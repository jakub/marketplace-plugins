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

import { dirname, join, normalize, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readCapped } from './shim.mjs'

const VERSION_RE = /^\d+\.\d+\.\d+$/
const MANIFESTS = ['.claude-plugin', '.codex-plugin']
// A plugin.json is a few hundred bytes. This bound is generous, and its real job is to keep
// the read capped rather than to filter by size.
const MANIFEST_CAP = 64 * 1024

const stable = (value) => (typeof value === 'string' && VERSION_RE.test(value) ? value : null)

// Read each manifest through the same capped, non-blocking, regular-file-only helper the shim
// uses. A blocking readFileSync on a FIFO or other special file planted at a manifest path hangs
// forever, and it would hang here inside installFacts, before doctor can report identity or
// health, where the surrounding try/catch cannot catch a read that never returns. readCapped
// opens non-blocking and fstat rejects anything that is not a regular file, so a special or
// unreadable manifest reads as null and falls through to the next candidate.
function manifestVersion(root) {
  for (const directory of MANIFESTS) {
    const bytes = readCapped(join(root, directory, 'plugin.json'), MANIFEST_CAP)
    if (bytes === null) continue
    try {
      const version = stable(JSON.parse(bytes.toString('utf8'))?.version)
      if (version !== null) return version
    } catch {
      // A malformed manifest is not an error here, it is the next candidate.
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
