#!/usr/bin/env node
// Codex publish guard. Two jobs, and they are not the same job.
//
// 1. Codex cannot turn a PreToolUse hook result into an approval prompt: as of Codex CLI
//    0.149.1 an unsupported `ask` reads as a hook failure and the command runs anyway. So
//    publication fails closed here instead of asking.
// 2. A gate with no way through means a Codex session can never land anything, so there
//    is exactly one way through. A human writes a release sanction outside the session
//    with scripts/release-sanction.mjs, naming a repository, a branch, a head SHA, and the
//    operation ids they approve. This guard re-derives those facts from git at the moment
//    of the call, hands them to lib/release-sanction.mjs, and lets exactly that operation
//    past exactly once. This is the cron pattern: the model proposes, deterministic code
//    re-derives the conditions and decides.
//
// Trust posture, stated plainly rather than implied. Everything here runs as one uid, so a
// model with a shell can in principle produce the sanction file through some path this
// guard does not pattern-match. The commands that obviously write it are denied, the file
// is protected from the editor tools, and the sanction is consumed on use, which is a
// guardrail against the unattended mistake and the injected instruction. It is not a
// sandbox, and a credential-owning service on a single-uid homelab would be theater.
//
// Two limits worth knowing before you trust a pass. The facts come from the session's cwd,
// so a publication command that changes directory first is still checked against the
// session's repository - the sanction's repo binding is as good as the session being in the
// repository it names. And equality is checked against the head as it stands now, not
// against the head's history.
//
// Ordinary work must not notice this file. Commands that publish nothing take one regex
// pass and no git calls; only a publication command pays for the four git reads.

import { execFileSync } from 'node:child_process'
import { readFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { publishOperations, publishReason } from '../../lib/hook-policy.mjs'
import { releaseVerdict, sanctionPath } from '../../lib/release-sanction.mjs'
import { preToolDeny } from './wire.mjs'

const REGISTRY_TAIL =
  'Codex PreToolUse hooks cannot request confirmation, so direct publication is blocked. ' +
  'Run the publish command yourself after reviewing the version and package contents.'
const MERGE_HEADLINE =
  'This merges a pull request on GitHub, which moves the branch everyone else builds on. ' +
  'Confirm the head SHA and the merge method are what you mean to land.'
const MERGE_TAIL =
  'Codex PreToolUse hooks cannot request confirmation, so the merge is blocked here. ' +
  'Land it yourself, or ask for a release sanction covering this exact head.'

const deny = (reason) => process.stdout.write(JSON.stringify(preToolDeny(reason)))

const SANCTION = sanctionPath(process.env)

// The model may not write its own approval. These are the spellings that would do it
// through a shell: touching the sanction file by resolved path or by name, and running
// the approval helper. Deliberately narrow around the helper - it matches the helper's
// own verbs, so `git add plugins/flow/scripts/release-sanction.mjs` stays ordinary work.
const selfApproval = (command) => {
  if (command.includes(SANCTION)) return `it writes or reads ${SANCTION} directly`
  if (/\brelease-sanction\.json\b/.test(command)) return 'it names the release sanction file'
  if (/release-sanction\.mjs\b[^;&|]*\b(?:approve|revoke)\b/.test(command)) return 'it runs the release sanction helper'
  return null
}

let raw = ''
for await (const chunk of process.stdin) raw += chunk
let input
try { input = JSON.parse(raw) } catch { input = null }
const command = input?.tool_input?.command

if (typeof command !== 'string') {
  deny('flow: Codex sent a Bash call without an inspectable command; refusing an operation whose publication status cannot be verified.')
} else {
  const forged = selfApproval(command)
  const operations = publishOperations(command)

  if (forged) {
    deny(
      `flow: this command is refused because ${forged}. A release sanction is the human's approval ` +
      'of one specific head SHA, so the session that wants to publish never writes it. Ask the human ' +
      'to run scripts/release-sanction.mjs in their own terminal, and tell them the repository, ' +
      'branch, head SHA, and operation you need approved.',
    )
  } else if (operations.length > 0) {
    // A registry publication keeps the exact wording this guard has always used; only a
    // merge-only command gets the merge wording.
    const registry = publishReason(command)
    const headline = registry || MERGE_HEADLINE
    const tail = registry ? REGISTRY_TAIL : MERGE_TAIL
    const refuse = (why) => deny(
      `${headline} ${tail}\nRelease sanction: ${why}. The human approves a publication by running ` +
      `\`node <flow>/scripts/release-sanction.mjs approve --repo <owner/name> --branch <branch> ` +
      `--head <sha> --op ${operations.join(' --op ')}\` in their own terminal; relay what you need, ` +
      'do not run it yourself.',
    )

    // Scheduled jobs read untrusted text and nobody is watching them, so the release path
    // is simply off there. An injected instruction cannot set this variable, the same
    // reasoning git-guard's cron mode rests on.
    if (process.env.FLOW_CRON_JOB) {
      refuse('scheduled jobs cannot publish at all, and a sanction does not change that')
    } else {
      const cwd = typeof input?.cwd === 'string' && input.cwd !== '' ? input.cwd : process.cwd()
      // Every git read is bounded twice over. This hook runs before each Bash call, so one
      // hung git would stall the session; and hooks.json gives the whole hook 10 seconds,
      // after which a timed-out hook is a hook that decided nothing. Four reads at two
      // seconds fit inside that with room to spare, and a git that cannot answer in two
      // seconds returns null, which denies.
      const git = (...args) => {
        try {
          return execFileSync('git', ['-C', cwd, ...args], {
            encoding: 'utf8',
            timeout: 2000,
            stdio: ['ignore', 'pipe', 'pipe'],
          }).trim()
        } catch {
          return null
        }
      }
      const originUrl = git('remote', 'get-url', 'origin')
      const status = git('status', '--porcelain')
      const repo = {
        slug: originUrl ? (originUrl.replace(/\.git$/, '').match(/[:/]([^/:]+\/[^/]+)$/)?.[1] ?? null) : null,
        branch: git('symbolic-ref', '--quiet', '--short', 'HEAD'),
        head: git('rev-parse', 'HEAD'),
        dirty: status === null ? null : status !== '',
      }

      let sanction = null
      try { sanction = JSON.parse(readFileSync(SANCTION, 'utf8')) } catch { sanction = null }

      const verdict = releaseVerdict({ operations, sanction, repo, nowMs: Date.now() })
      if (!verdict.allowed) {
        refuse(verdict.reason)
      } else {
        // Consume first, allow second. rename() is atomic, so if two hook processes verify
        // the same sanction at once exactly one of them gets the file and the other's
        // rename fails with ENOENT - which denies, because an approval is for one command.
        try {
          renameSync(SANCTION, join(dirname(SANCTION), `release-sanction.consumed.${Date.now()}`))
        } catch (error) {
          refuse(`the sanction could not be consumed (${String(error?.code || error?.message || error).slice(0, 80)}), and an approval that cannot be spent is not honored`)
        }
      }
    }
  }
}
