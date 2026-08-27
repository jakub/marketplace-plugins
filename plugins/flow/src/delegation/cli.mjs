import { readFileSync } from 'node:fs'
import { DelegationService } from './service.mjs'
import { DelegationError, HOSTS, publicError, resultEnvelope } from './contracts.mjs'
import { defaultStateDir, serviceLog } from './store.mjs'

async function stdin() {
  if (process.stdin.isTTY) return ''
  process.stdin.setEncoding('utf8')
  let value = ''
  for await (const chunk of process.stdin) value += chunk
  return value
}

export function parse(argv) {
  const out = { command: argv[0], flags: {}, positionals: [] }
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) { out.positionals.push(arg); continue }
    const name = arg.slice(2)
    if (name === 'detach') { out.flags.detach = true; continue }
    i++
    if (i >= argv.length) throw new Error(`--${name} requires a value`)
    out.flags[name] = argv[i]
  }
  return out
}

const number = (value, fallback) => value == null ? fallback : Number(value)

export async function runCli({ argv, entryPath }) {
  const { command, flags, positionals } = parse(argv)
  // The host is the caller's own family, and the route rules depend on it. A default would
  // let a codex-hosted call claim to be claude, so the flag is required on every invocation.
  if (!HOSTS.includes(flags.host)) {
    throw new DelegationError('BAD_REQUEST', `--host is required and must be one of: ${HOSTS.join(', ')}.`)
  }
  const depth = Number(process.env.FLOW_DELEGATION_DEPTH || 0)
  const service = new DelegationService({
    host: flags.host,
    depth,
    stateDir: flags['state-dir'],
    entryPath,
    projectDir: flags.cwd || process.cwd(),
  })
  let value
  if (command === 'run') {
    const prompt = await stdin()
    const outputSchema = flags['schema-file'] ? JSON.parse(readFileSync(flags['schema-file'], 'utf8')) : null
    const job = await service.start({
      mode: flags.mode || 'task',
      prompt,
      cwd: flags.cwd || process.cwd(),
      access: flags.access || 'read-only',
      model: flags.model,
      effort: flags.effort,
      serviceTier: 'default',
      profile: flags.profile || 'standard',
      delivery: flags.detach ? 'detached' : 'attached',
      timeBudgetSeconds: number(flags['time-budget-seconds'], 900),
      outputSchema,
      base: flags.base || null,
      head: flags.head || 'HEAD',
    }, { fallbackCwd: flags.cwd || process.cwd() })
    value = flags.detach ? resultEnvelope(job) : resultEnvelope(await service.wait(job.id))
  } else if (command === 'status') {
    value = resultEnvelope(await service.reconcile(positionals[0]))
  } else if (command === 'result') {
    value = service.result(positionals[0])
  } else if (command === 'events') {
    value = service.events(positionals[0], { after: number(flags.after, 0), limit: number(flags.limit, 200) })
  } else if (command === 'cancel') {
    value = resultEnvelope(service.cancel(positionals[0]))
  } else if (command === 'steer') {
    value = resultEnvelope(service.steer(positionals[0], await stdin()))
  } else if (command === 'continue') {
    const prior = service.get(positionals[0])
    const job = await service.continue(positionals[0], {
      prompt: await stdin(),
      access: flags.access,
      model: flags.model,
      effort: flags.effort,
      delivery: flags.detach ? 'detached' : 'attached',
      timeBudgetSeconds: number(flags['time-budget-seconds'], undefined),
    }, { fallbackCwd: prior.cwd })
    value = flags.detach ? resultEnvelope(job) : resultEnvelope(await service.wait(job.id))
  } else if (command === 'models') {
    value = await service.models(flags.cwd || process.cwd())
  } else if (command === 'doctor') {
    value = await service.doctor(flags.cwd || process.cwd())
  } else {
    throw new Error('usage: delegation.mjs cli run|status|result|events|cancel|steer|continue|models|doctor')
  }
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

export async function safeRunCli(options) {
  try { await runCli(options) } catch (error) {
    // A CLI failure can happen before any job exists, and publicError() drops the cause on
    // the floor, so the real one goes to the service log.
    if (!(error instanceof DelegationError)) {
      let stateDir = defaultStateDir()
      try { stateDir = parse(options.argv).flags['state-dir'] || stateDir } catch {}
      serviceLog(stateDir, `cli failed: ${error?.stack || error?.message || error}`)
    }
    process.stdout.write(`${JSON.stringify({ status: 'failed', error: publicError(error, 'Delegation CLI failed') })}\n`)
  }
}
