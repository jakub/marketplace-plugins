import { accessSync, constants, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DelegationError } from './contracts.mjs'

export function claudeSpawnCommand(command, args, {
  platform = process.platform,
  nodeExecutable = process.execPath,
} = {}) {
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(command)) return { command, args }
  const directory = dirname(command)
  const candidates = [
    resolve(directory, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
    resolve(directory, '..', '@anthropic-ai', 'claude-code', 'cli.js'),
  ]
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.R_OK)
      return { command: nodeExecutable, args: [realpathSync(candidate), ...args] }
    } catch {}
  }
  throw new DelegationError(
    'CLAUDE_STARTUP',
    'Claude Code\'s Windows batch launcher could not be resolved without a shell. Install the native Claude Code executable.',
  )
}
