// The CDP driver's home. build.mjs's browser check talks to Chromium over --remote-debugging-pipe
// from here. For now this module holds only Chromium discovery: the launch, the pipe transport,
// the close ladder and the signal handlers are not written yet.
//
//   findChromium(env, platform) -> { path, reason }
//     path is the executable to launch, or null. reason is null with a path, else an unknown
//     reason { kind: 'no-chromium', detail }.
//
// Discovery, in order, with no silent fallback:
//   1. PLANS_CHROMIUM, when the variable is set at all. It is used exactly when it names an
//      executable regular file (a symlink to one counts), and otherwise the result is unknown.
//      A set but unusable PLANS_CHROMIUM never falls through to PATH.
//   2. chromium, chromium-browser, google-chrome-stable and google-chrome, in that order, in each
//      absolute PATH entry in order. Empty and relative entries are skipped, so the working
//      directory is never searched.
//   3. On darwin, /Applications/Google Chrome.app/Contents/MacOS/Google Chrome.
// It never looks in an npx or Playwright cache.

import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

const NAMES = ['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome']
const MAC = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

function executable(path) {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function findChromium(env = process.env, platform = process.platform) {
  if (env.PLANS_CHROMIUM !== undefined) {
    const p = env.PLANS_CHROMIUM
    if (p !== '' && executable(p)) return { path: p, reason: null }
    return { path: null, reason: { kind: 'no-chromium', detail: `PLANS_CHROMIUM=${p} is not an executable regular file` } }
  }
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue
    for (const name of NAMES) {
      const p = join(dir, name)
      if (executable(p)) return { path: p, reason: null }
    }
  }
  if (platform === 'darwin' && executable(MAC)) return { path: MAC, reason: null }
  return { path: null, reason: { kind: 'no-chromium', detail: `no Chromium found: set PLANS_CHROMIUM, or put one of ${NAMES.join(', ')} on PATH` } }
}
