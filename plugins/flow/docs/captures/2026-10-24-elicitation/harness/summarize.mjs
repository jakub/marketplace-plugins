#!/usr/bin/env node
// Prints, for each server log written by server.mjs, the elicitation requests with their send
// times, the client's answers and the latency in ms from request to answer.
//
//   node summarize.mjs <log.jsonl>...
import { readFileSync } from 'node:fs'

if (process.argv.length < 3) {
  process.stderr.write('usage: node summarize.mjs <log.jsonl>...\n')
  process.exit(2)
}

for (const path of process.argv.slice(2)) {
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  console.log(`== ${path} (${lines.length} lines)`)
  const init = lines.find((l) => l.dir === 'in' && l.method === 'initialize')
  if (init) console.log(`initialize: client protocolVersion ${init.protocolVersion ?? '?'}, elicitation capability ${init.clientElicitation}`)
  const discover = lines.find((l) => l.dir === 'in' && l.method === 'server/discover')
  console.log(`server/discover seen: ${discover !== undefined}`)
  const gate = lines.find((l) => l.kind === 'gate')
  console.log(`gate: ${gate ? `appeared ${gate.appeared} (${gate.gate})` : 'none set'}`)
  const dirs = [...new Set(lines.map((l) => l.projectDir))]
  console.log(`CLAUDE_PROJECT_DIR: ${dirs.join(', ')}`)
  const sent = lines.filter((l) => l.dir === 'out' && l.method === 'elicitation/create')
  if (sent.length === 0) console.log('no elicitation sent')
  for (const req of sent) {
    const ans = lines.find((l) => l.dir === 'in' && l.kind === 'response' && l.id === req.id)
    const result = !ans ? 'no response' : ans.error !== undefined ? `error ${ans.error}` : `action ${ans.action}`
    const latency = ans ? `${Date.parse(ans.t) - Date.parse(req.t)} ms` : '-'
    console.log(`${req.mode.padEnd(4)} id ${req.id}  sent ${req.t}  ${result}  latency ${latency}`)
  }
  const summary = lines.find((l) => l.kind === 'summary')
  console.log(`summary: ${summary ? JSON.stringify(summary.summary) : 'not written'}`)
}
