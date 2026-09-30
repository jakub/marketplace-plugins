// The detached process that runs one job. It claims the job, opens a session with the provider in
// a process group of its own, sends the prompt, journals each stdout line to events.jsonl,
// enforces the time budget, the stall ceiling and cancel, and writes the outcome. The lease is
// released before the outcome is written, and only after the provider's group is dead, so no two
// writers ever share a worktree.
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { seatPayload } from '../lib/charter-payload.mjs'
import { transport as claude } from './claude-control.mjs'
import { transport as codex } from './codex-app-server.mjs'
import { claim, DelegateError, jobDir, JOB_ID, log, readJob, releaseLease, settle, signalProvider, startToken, writeJob } from './jobs.mjs'
import { findExecutable, providerEnv } from './providers.mjs'

const STALL_SECONDS = 420
const KILL_GRACE_MS = 10_000
const CHARTER = new URL('../charter/charter.md', import.meta.url)
const TRANSPORTS = { codex, claude }

// The seat half of the charter, read from the file for every job, then the delegated-seat block.
// A continuation gets the same bytes, so no rule ever rides in caller prose.
export function delegatedInstructions(job, provider) {
  const access = job.access === 'workspace-write'
    ? 'You may edit only the assigned Git worktree. Do not publish, push, or modify another checkout.'
    : 'This is a read-only job. Do not edit files or mutate the repository.'
  return `${seatPayload(readFileSync(CHARTER, 'utf8'))}\n<delegated-seat>\nYou are a delegated ${provider} worker. ${access} Read and follow the applicable AGENTS.md or CLAUDE.md files before acting.\n</delegated-seat>`
}

// A diagnosis the provider itself showed (a refusal, a swapped model, a failed isolation
// read-back) outranks the interrupt that followed it, and a native success stands even when a
// stop raced it.
function outcome(job, folded, stopped) {
  if (folded.status === 'succeeded' || ['REFUSAL', 'MODEL_MISMATCH', 'ISOLATION'].includes(folded.error?.kind)) return folded
  if (!['CANCELLED', 'TIMEOUT', 'STALL'].includes(stopped)) return folded
  if (stopped === 'CANCELLED') return { ...folded, status: 'cancelled', error: { kind: 'CANCELLED', message: 'The job was cancelled.' } }
  const message = stopped === 'TIMEOUT' ? `The job ran past its ${job.timeBudgetSeconds}s budget.` : `The provider was silent for ${STALL_SECONDS}s.`
  return { ...folded, status: 'failed', error: { kind: stopped, message } }
}

// A failure the transport threw before its turn ended. A DelegateError is written for the caller;
// anything else is logged and reads INTERNAL.
function failed(job, error) {
  if (error instanceof DelegateError) return { status: 'failed', error: { kind: error.kind, message: error.message, ...(error.details ? { details: error.details } : {}) } }
  log(`provider session failed for ${job.id}: ${error?.stack || error}`)
  return { status: 'failed', error: { kind: 'INTERNAL', message: 'The runner could not drive the provider; server.log in the state directory has the detail.' } }
}

// Opens the session, sends the prompt, and folds until the provider has exited. The transport
// spawns the provider and hands the child to onSpawn before anything can signal it, so the group's
// identity is on record from the first moment, and every line it prints reaches onLine.
async function runProvider(job, dir, bin, transport, seat, prompt) {
  const events = createWriteStream(join(dir, 'events.jsonl'), { flags: 'a', mode: 0o600 })
  const stderr = createWriteStream(join(dir, 'stderr.txt'), { flags: 'a', mode: 0o600 })
  let record = job
  let group = null
  let session = null
  let failure = null
  let spawnFailed = false
  let closed = null
  let stopped = null
  let killTimer = null
  let stallTimer = null
  let exit = null
  let settled = false
  const journal = (event) => { if (!settled) events.write(`${JSON.stringify(event)}\n`) }
  const kill = (signal) => signalProvider(group, signal)
  // SIGTERM to the group now and SIGKILL after the grace, once however many paths ask for it.
  const terminate = () => {
    if (settled || killTimer) return
    kill('SIGTERM')
    killTimer = setTimeout(() => kill(), KILL_GRACE_MS)
  }
  const stop = async (reason) => {
    if (stopped || settled) return
    stopped = reason
    journal({ type: 'flow.stop', reason })
    // The provider's own interrupt goes first, so the turn ends where the provider can record it.
    // The group is signalled after it whatever the interrupt answered.
    const interrupted = session ? await session.interrupt() : null
    if (interrupted) journal({ type: 'flow.interrupt', ...interrupted })
    terminate()
  }
  const resetStall = () => {
    clearTimeout(stallTimer)
    if (!settled) stallTimer = setTimeout(() => stop('STALL'), STALL_SECONDS * 1000)
  }
  // The session's state after each line: the provider thread is recorded the moment it is known,
  // so a running job can be steered; so are whether the provider's catalog listed the model, what
  // the session read back and whether the prompt has gone out; a stop the fold asked for starts
  // now; an ended turn closes the session so the provider can exit.
  const sync = () => {
    if (!session) return
    if (session.threadId && session.threadId !== record.threadId) record = writeJob({ ...record, threadId: session.threadId })
    if (session.catalog && !record.catalog) record = writeJob({ ...record, catalog: session.catalog })
    if (session.isolation && !record.isolation) record = writeJob({ ...record, isolation: session.isolation })
    if (session.promptSent && !record.promptSent) record = writeJob({ ...record, promptSent: true })
    if (session.stopReason) stop(session.stopReason)
    if (session.turnEnded) session.close()
  }
  const onSpawn = (child) => {
    closed = new Promise((done) => {
      child.on('error', (error) => { log(`provider spawn failed for ${job.id}: ${error.message}`); spawnFailed = true; done() })
      child.on('close', () => done())
    })
    // Once the provider itself has exited, whatever is left in its group is a straggler that may
    // hold stdout open; killing the group lets 'close' arrive.
    child.on('exit', (code, signal) => { exit = { code, signal }; kill() })
    child.stderr.pipe(stderr)
    if (!child.pid) return
    // The group's identity, recorded before anything can signal it: the leader's pid and start.
    group = { providerPgid: child.pid, providerStart: startToken(child.pid, { zombie: true }) }
    record = writeJob({ ...record, ...group })
  }
  const onLine = (line) => {
    resetStall()
    if (!settled) events.write(`${line}\n`)
    sync()
  }

  const budget = setTimeout(() => stop('TIMEOUT'), job.timeBudgetSeconds * 1000)
  const poll = setInterval(() => { if (existsSync(join(dir, 'cancel'))) stop('CANCELLED') }, 500)
  resetStall()
  try {
    session = await transport.open({ job, dir, bin, env: providerEnv(job, dir), seat, onSpawn, onLine })
    sync()
    if (!stopped) {
      // The prompt is on its way once send returns, before the provider accepts it.
      const sending = session.send(prompt)
      sync()
      await sending
    }
  } catch (error) {
    failure = error
    session?.close()
    terminate()
  }
  await closed
  settled = true
  for (const timer of [budget, stallTimer, killTimer]) clearTimeout(timer)
  clearInterval(poll)
  kill()
  events.end()
  stderr.end()
  let folded
  if (spawnFailed) folded = { status: 'failed', error: { kind: 'PROVIDER_ERROR', message: `${transport.name} could not be started.` } }
  else if (failure) folded = failed(job, failure)
  else {
    try { folded = session.finish(exit ?? {}) } catch (error) {
      log(`fold failed for ${job.id}: ${error?.stack || error}`)
      folded = { status: 'failed', error: { kind: 'INTERNAL', message: 'The runner could not read the provider outcome; server.log in the state directory has the detail.' } }
    }
  }
  return { folded, stopped }
}

export async function runJob(id) {
  if (!JOB_ID.test(id)) return
  let job = readJob(id)
  if (job?.status !== 'queued' || !claim(id)) return
  const dir = jobDir(id)
  let result = null
  try {
    const transport = TRANSPORTS[job.target]
    const bin = findExecutable(job.target)
    if (existsSync(join(dir, 'cancel'))) {
      result = { status: 'cancelled', error: { kind: 'CANCELLED', message: 'The job was cancelled before it started.' } }
    } else if (!transport || !bin) {
      result = { status: 'failed', error: { kind: 'PROVIDER_NOT_INSTALLED', message: `${job.target} is not on the PATH the delegate server sees.` } }
    } else {
      const seat = delegatedInstructions(job, transport.name)
      writeFileSync(join(dir, 'seat.md'), seat, { mode: 0o600 })
      mkdirSync(join(dir, 'tmp'), { recursive: true, mode: 0o700 })
      const prompt = readFileSync(join(dir, 'prompt.txt'), 'utf8')
      job = writeJob({ ...job, status: 'running', startedAt: new Date().toISOString(), runnerPid: process.pid, runnerStart: startToken(process.pid) })
      const { folded, stopped } = await runProvider(job, dir, bin, transport, seat, prompt)
      job = readJob(id) ?? job
      result = outcome(job, folded, stopped)
    }
  } catch (error) {
    log(`runner failed for ${id}: ${error?.stack || error}`)
    result = { status: 'failed', error: { kind: 'INTERNAL', message: 'The job runner failed; server.log in the state directory has the detail.' } }
  } finally {
    signalProvider(job)
    releaseLease(job)
    const { status = 'failed', ...fields } = result ?? {}
    settle(job, status, fields)
  }
}
