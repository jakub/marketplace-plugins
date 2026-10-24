// Drives one claude -p stream-json session for a capture arm. Usage:
//   node drive.mjs <arm> <mcp-config.json> <cwd> <allowedTools> <prompt-file> [flagged] [interrupt-after-ms]
// Prints the assistant text, tool uses and the result line; the wire goes to the tee's log.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const [arm, mcpConfig, cwd, allowed, promptFile, flagged, interruptAfter] = process.argv.slice(2)
// A 7th argument that names a .txt file is a follow-up user message, sent after the first result; the
// session then ends at the second result. Any other 7th argument is a delay in ms before an interrupt.
const followup = interruptAfter && interruptAfter.endsWith('.txt') ? readFileSync(interruptAfter, 'utf8') : null
let results = 0
const prompt = readFileSync(promptFile, 'utf8')
const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', 'sonnet',
  '--mcp-config', mcpConfig, '--strict-mcp-config', '--settings', new URL('./settings-plain.json', import.meta.url).pathname,
  '--allowedTools', allowed]
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/.test(k)))
if (flagged === '1') env.CLAUDE_AUTO_BACKGROUND_TASKS = '1'
const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'inherit'], env, cwd })
const t0 = Date.now()
const out = (...a) => console.log(`[${arm} +${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a)
let timedOut = false
const timer = setTimeout(() => { timedOut = true; out('TIMEOUT'); child.kill('SIGTERM') }, 600_000)
child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n')
if (interruptAfter && !followup) setTimeout(() => { out('INTERRUPT: sending control_request interrupt'); child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'int-1', request: { subtype: 'interrupt' } }) + '\n') }, Number(interruptAfter))
createInterface({ input: child.stdout }).on('line', (line) => {
  let m; try { m = JSON.parse(line) } catch { return }
  if (m.type === 'assistant') for (const b of m.message?.content ?? []) {
    if (b.type === 'text') out('ASSISTANT:', b.text.slice(0, 1500))
    if (b.type === 'tool_use') out('TOOL_USE:', b.name, JSON.stringify(b.input).slice(0, 300))
  }
  if (m.type === 'user') for (const b of m.message?.content ?? []) if (b.type === 'tool_result') out('TOOL_RESULT:', JSON.stringify(b.content).slice(0, 1500))
  if (m.type === 'system' && m.subtype !== 'init') out('SYSTEM:', JSON.stringify(m).slice(0, 400))
  if (m.type === 'control_response') out('CONTROL_RESPONSE:', JSON.stringify(m).slice(0, 300))
  if (m.type === 'result') {
    out('RESULT:', m.subtype, m.is_error ? 'error' : 'ok', 'turns', m.num_turns)
    results += 1
    if (followup && results === 1) { out('FOLLOWUP: sending second user message'); child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: followup } }) + '\n'); return }
    clearTimeout(timer); child.stdin.end()
  }
})
// Exit with the child's code so run-all.sh can tell a failed arm from a good one: a signal kill (code null) and
// the timeout both exit non-zero even when the child reports 0.
// close, not exit: it fires after the child's stdio closed, so buffered stream-json lines reach the log first.
child.on('close', (code) => { out('EXIT', code); process.exit(timedOut ? 1 : (code ?? 1)) })
