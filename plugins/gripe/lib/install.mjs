// gripe: which install is running.
//
// Two harnesses install this plugin from the same marketplace into two caches, and the
// PATH shim picks one of them at exec time. Without these two fields, a capture of a
// working `gripe doctor` says only that some gripe answered; with them it says which
// tree's code ran and what it calls itself. That is the difference between evidence and
// "it printed something and presumably worked".
//
// Deliberately not part of the health verdict. Version skew between the two installs is a
// fact for the human to read, not a condition for this code to rule on.

import { readFileSync } from 'node:fs'
import { dirname, join, normalize, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION_RE = /^\d+\.\d+\.\d+$/
const MANIFESTS = ['.claude-plugin', '.codex-plugin']

const stable = (value) => (typeof value === 'string' && VERSION_RE.test(value) ? value : null)

function manifestVersion(root) {
  for (const directory of MANIFESTS) {
    try {
      const version = stable(JSON.parse(readFileSync(join(root, directory, 'plugin.json'), 'utf8'))?.version)
      if (version !== null) return version
    } catch {
      // A missing or malformed manifest is not an error here, it is the next candidate.
    }
  }
  return null
}

/**
 * The plugin root and version of the code that is running, derived from the caller's own
 * module URL: `installFacts(import.meta.url)` from a file one directory under the plugin
 * root. Lexical normalization only, never realpath, because the point is to report the
 * path the harness actually launched, symlinks and all.
 *
 * Version comes from the Claude manifest, then the Codex manifest, then the directory
 * name a plugin cache gave the install, then null. Never throws: a doctor that dies
 * reporting its own identity is worse than one reporting an unknown version.
 */
export function installFacts(moduleUrl) {
  let root = null
  try {
    root = normalize(dirname(dirname(fileURLToPath(moduleUrl))))
  } catch {
    return { plugin_root: null, plugin_version: null }
  }
  let version = null
  try {
    version = manifestVersion(root) ?? stable(basename(root))
  } catch {
    version = null
  }
  return { plugin_root: root, plugin_version: version }
}
