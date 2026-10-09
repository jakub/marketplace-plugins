// The plans metadata the issue requires, beyond the agreement smoke-plugin-manifests.mjs checks between
// manifests: the plugin manifest and the marketplace entry carry one description that names all three
// skills (show, doc, publish), both sit at version 0.1.0, plans ships no Codex manifest because Codex
// finds skills/*/SKILL.md by itself, and the README row names the three skills. Each rule is a function
// of in-memory state, so every negative control mutates that state and proves the rule fails; nothing
// is written to disk.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const SKILLS = ['show', 'doc', 'publish']
const VERSION = '0.1.0'
const BASE_DESCRIPTION = 'Publish, verify, and delete HTML plans, images, and video as viewable URLs through the open-source plans CLI and a self-hosted plansd server.'

const namesAll = (text) => SKILLS.every((skill) => new RegExp(`\\b${skill}\\b`).test(text))
const rowNamesAll = (row) => SKILLS.every((skill) => row.includes(`\`${skill}\``))

export default async function ({ ROOT, check }) {
  const plugin = JSON.parse(readFileSync(join(ROOT, 'plugins/plans/.claude-plugin/plugin.json'), 'utf8'))
  const entry = JSON.parse(readFileSync(join(ROOT, '.claude-plugin/marketplace.json'), 'utf8')).plugins.find((p) => p.name === 'plans')
  const row = readFileSync(join(ROOT, 'README.md'), 'utf8').split('\n').find((line) => line.startsWith('| **plans** |')) ?? ''

  const descriptionOk = (a, b) => typeof a === 'string' && a === b && namesAll(a)
  const versionOk = (a, b) => a === VERSION && b === VERSION
  const codexOk = (exists) => exists === false

  check('the plans entry exists in the marketplace manifest', !!entry)
  check('plugin.json and the marketplace entry carry one description that names show, doc and publish', descriptionOk(plugin.description, entry?.description), plugin.description)
  check(`plugin.json and the marketplace entry are both at version ${VERSION}`, versionOk(plugin.version, entry?.version), `${plugin.version} / ${entry?.version}`)
  check('plugins/plans/.codex-plugin does not exist', codexOk(existsSync(join(ROOT, 'plugins/plans/.codex-plugin'))))
  check('the README plans row names show, doc and publish', rowNamesAll(row), row.slice(0, 200))

  check('control: the base-era description fails the description rule', !descriptionOk(BASE_DESCRIPTION, BASE_DESCRIPTION))
  check('control: manifests that differ in description fail the description rule', !descriptionOk(plugin.description, `${plugin.description} `))
  check('control: version 0.1.1 in either place fails the version rule', !versionOk('0.1.1', VERSION) && !versionOk(VERSION, '0.1.1'))
  check('control: a present Codex manifest path fails the Codex rule', !codexOk(true))
  check('control: a README row without doc fails the row rule', !rowNamesAll(row.replaceAll('`doc`', 'docs')))
}
