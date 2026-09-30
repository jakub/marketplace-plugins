// The detached process that runs one job. It claims the job, spawns the provider CLI in a process
// group of its own, journals each stdout line to events.jsonl, enforces the time budget, the stall
// ceiling and cancel, and writes the outcome. The lease is released before the outcome is written,
// and only after the provider's group is dead, so no two writers ever share a worktree.
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { seatPayload } from '../lib/charter-payload.mjs'
import { claim, jobDir, JOB_ID, killGroup, log, readJob, releaseLease, settle, startToken, writeJob } from './jobs.mjs'
import { findExecutable, PROVIDERS, providerEnv } from './providers.mjs'

const STALL_SECONDS = 420
const KILL_GRACE_MS = 10_000
const CHARTER = new URL('../charter/charter.md', import.meta.url)

// The seat half of the charter, read from the file for every job, then the delegated-seat block.
// A continuation gets the same bytes, so no rule ever rides in caller prose.
export function delegatedInstructions(job, provider) {
  const access = job.access === 'workspace-write'
    ? 'You may edit only the assigned Git worktree. Do not publish, push, or modify another checkout.'
    : 'This is a read-only job. Do not edit files or mutate the repository.'
  return `${seatPayload(readFileSync(CHARTER, 'utf8'))}\n<delegated-seat>\nYou are a delegated ${provider} worker. ${access} Read and follow the applicable AGENTS.md or CLAUDE.md files before acting.\n</delegated-seat>`
}

// A diagnosis the provider itself showed (a refusal, a swapped model) outranks the interrupt that
// followed it, and a native success stands even when a stop raced it.
function outcome(job, folded, stopped) {
  if (folded.status === 'succeeded' || ['REFUSAL', 'MODEL_MISMATCH'].includes(folded.error?.kind)) return folded
  if (!['CANCELLED', 'TIMEOUT', 'STALL'].includes(stopped)) return folded
  if (stopped === 'CANCELLED') return { ...folded, status: 'cancelled', error: { kind: 'CANCELLED', message: 'The job was cancelled.' } }
  const message = stopped === 'TIMEOUT' ? `The job ran past its ${job.timeBudgetSeconds}s budget.` : `The provider was silent for ${STALL_SECONDS}s.`
  return { ...folded, status: 'failed', error: { kind: stopped, message } }
}

function runProvider(job, dir, bin, provider, stdin) {
  return new Promise((resolve) => {
    const child = spawn(bin, provider.argv(job, dir), {
      cwd: job.cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: providerEnv(job, dir),
    })
    const fold = provider.fold(job, dir)
    const events = createWriteStream(join(dir, 'events.jsonl'), { flags: 'a', mode: 0o600 })
    const stderr = createWriteStream(join(dir, 'stderr.txt'), { flags: 'a', mode: 0o600 })
    let stopped = null
    let killTimer = null
    let stallTimer = null
    let exit = null
    let settled = false
    const stop = (reason) => {
      if (stopped) return
      stopped = reason
      events.write(`${JSON.stringify({ type: 'flow.stop', reason })}\n`)
      killGroup(child.pid, 'SIGTERM')
      killTimer = setTimeout(() => killGroup(child.pid), KILL_GRACE_MS)
    }
    const resetStall = () => {
      clearTimeout(stallTimer)
      stallTimer = setTimeout(() => stop('STALL'), STALL_SECONDS * 1000)
    }
    const budget = setTimeout(() => stop('TIMEOUT'), job.timeBudgetSeconds * 1000)
    const poll = setInterval(() => { if (existsSync(join(dir, 'cancel'))) stop('CANCELLED') }, 500)
    const finish = (spawnError) => {
      if (settled) return
      settled = true
      for (const timer of [budget, stallTimer, killTimer]) clearTimeout(timer)
      clearInterval(poll)
      killGroup(child.pid)
      events.end()
      stderr.end()
      let folded = { status: 'failed', error: { kind: 'PROVIDER_ERROR', message: `${provider.name} could not be started.` } }
      if (!spawnError) {
        try { folded = fold.finish(exit ?? {}) } catch (error) {
          log(`fold failed for ${job.id}: ${error?.stack || error}`)
          folded = { status: 'failed', error: { kind: 'INTERNAL', message: 'The runner could not read the provider outcome; server.log in the state directory has the detail.' } }
        }
      }
      resolve({ folded, stopped })
    }
    child.on('error', (error) => { log(`provider spawn failed for ${job.id}: ${error.message}`); finish(error) })
    if (!child.pid) return
    writeJob({ ...job, providerPgid: child.pid })
    resetStall()
    child.stdin.on('error', () => {})
    child.stdin.end(stdin)
    child.stderr.pipe(stderr)
    createInterface({ input: child.stdout }).on('line', (line) => {
      resetStall()
      events.write(`${line}\n`)
      let event
      try { event = JSON.parse(line) } catch { return }
      try { if (fold.event(event) === 'interrupt') stop('MODEL_MISMATCH') } catch (error) { log(`fold failed for ${job.id}: ${error?.stack || error}`) }
    })
    // Once the provider itself has exited, whatever is left in its group is a straggler that may
    // hold stdout open; killing the group lets 'close' arrive.
    child.on('exit', (code, signal) => { exit = { code, signal }; killGroup(child.pid) })
    child.on('close', () => finish(null))
  })
}

export async function runJob(id) {
  if (!JOB_ID.test(id)) return
  let job = readJob(id)
  if (job?.status !== 'queued' || !claim(id)) return
  const dir = jobDir(id)
  let result = null
  try {
    const provider = PROVIDERS[job.target]
    const bin = findExecutable(job.target)
    if (existsSync(join(dir, 'cancel'))) {
      result = { status: 'cancelled', error: { kind: 'CANCELLED', message: 'The job was cancelled before it started.' } }
    } else if (!provider || !bin) {
      result = { status: 'failed', error: { kind: 'PROVIDER_NOT_INSTALLED', message: `${job.target} is not on the PATH the delegate server sees.` } }
    } else {
      const seat = delegatedInstructions(job, provider.name)
      writeFileSync(join(dir, 'seat.md'), seat, { mode: 0o600 })
      mkdirSync(join(dir, 'tmp'), { recursive: true, mode: 0o700 })
      const prompt = readFileSync(join(dir, 'prompt.txt'), 'utf8')
      job = writeJob({ ...job, status: 'running', startedAt: new Date().toISOString(), runnerPid: process.pid, runnerStart: startToken(process.pid) })
      const { folded, stopped } = await runProvider(job, dir, bin, provider, provider.stdin(seat, prompt))
      job = readJob(id) ?? job
      result = outcome(job, folded, stopped)
      if (result.status === 'succeeded' && job.mode === 'adversarial-review' && !Array.isArray(result.structured?.findings)) {
        result = { ...result, status: 'failed', error: { kind: 'SCHEMA_OUTPUT', message: 'The review answered without a findings array.' } }
      }
    }
  } catch (error) {
    log(`runner failed for ${id}: ${error?.stack || error}`)
    result = { status: 'failed', error: { kind: 'INTERNAL', message: 'The job runner failed; server.log in the state directory has the detail.' } }
  } finally {
    killGroup(job.providerPgid)
    releaseLease(job)
    const { status = 'failed', ...fields } = result ?? {}
    settle(job, status, fields)
  }
}
