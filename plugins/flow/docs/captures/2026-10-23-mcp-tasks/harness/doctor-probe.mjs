// Arm (e) probe: starts the PR's delegate server by hand with a given CLAUDE_PROJECT_DIR, speaks the
// modern era to it (server/discover, then tools/call delegation_doctor with modern _meta and no tasks
// extension), and prints the doctor's client, tasks, rootsSource and roots fields. No model is called.
// Usage: node doctor-probe.mjs <main.mjs> <CLAUDE_PROJECT_DIR value>
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
const [main, projectDir] = process.argv.slice(2)
const env = { ...process.env, CLAUDE_PROJECT_DIR: projectDir }
const child = spawn(process.execPath, [main, 'mcp', '--host', 'claude'], { stdio: ['pipe', 'pipe', 'inherit'], env })
const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'arm-e-probe', version: '0' }, 'io.modelcontextprotocol/clientCapabilities': {} }
const waiting = new Map(); let next = 0
const request = (method, params) => new Promise((resolve) => { const id = ++next; waiting.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') })
createInterface({ input: child.stdout }).on('line', (line) => { const m = JSON.parse(line); if (m.method && m.id) { console.log('UNEXPECTED SERVER REQUEST', m.method); return } if (m.id) waiting.get(m.id)?.(m) })
const discover = await request('server/discover', { _meta: meta })
console.log('discover:', JSON.stringify(discover.result ?? discover.error))
const doctor = await request('tools/call', { name: 'delegation_doctor', arguments: {}, _meta: meta })
const body = doctor.result?.structuredContent ?? doctor.error
console.log('doctor:', JSON.stringify({ resultType: doctor.result?.resultType, ok: body?.ok, client: body?.client, tasks: body?.tasks, rootsSource: body?.rootsSource, roots: body?.roots, error: body?.error }))
child.stdin.end()
