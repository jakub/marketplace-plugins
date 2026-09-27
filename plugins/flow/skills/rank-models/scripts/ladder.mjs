#!/usr/bin/env node
// Builds the charter's model ladder from two agentic coding evaluations. Node builtins only.
//
//   node ladder.mjs --band <points> [--keep <slug>[,<slug>…]] [--json] [--coding <eval>] [--tools <eval>]
//                   [--fc-version <key>] <family>=<release>[,<release>…] …
//   node ladder.mjs --band 8 openai=gpt-6-luna,gpt-6-astra claude=claude-opus-5-5,claude-sonnet-5
//
// Sources. A release is the bare slug from artificialanalysis.ai/models/<release>. Each release
// page lists its effort variants, and every variant page embeds one `currentModel` object in its
// React Server Components payload, with each index evaluation's score and cost per task from the
// same run. There is no public API, so the page is the source: the payload arrives as
// `self.__next_f.push([1,"…"])` string chunks, decoded here as JSON string literals and
// concatenated before anything is searched. The second source is Cognition's FrontierCode data
// file, joined on the Artificial Analysis release name and the effort label.
//
// Per rung: the pass rate on each coding evaluation (Terminal-Bench on Artificial Analysis and
// FrontierCode's main subset) and the cost per task on each, both at list price. The rung's pass
// rate is the mean of the two, and its cost is their geometric mean, which keeps the ratio between
// two rungs when both costs scale together. Cost per solve is cost over pass rate. A rung is
// measured only with a positive score and a positive, finite cost on both evaluations; anything
// else is reported as unmeasured, never priced as free.
//
// The ladder, per family: drop every rung that another rung in the family beats, meaning it passes
// at least as often for less per solve. Then collapse ties from the top down: the strongest rung
// left opens a group, every rung within `--band` points of it joins, and the group's cheapest rung
// stays. The band is a policy tolerance that the skill derives from the task counts, not a
// significance test. Each ladder rung but the top gets `tryFirstAbove`, its cost over the next
// rung's: the pass rate a task must promise before the cheaper rung is worth a first attempt.
// `--keep` puts back a rung the human keeps despite the rules, marked as kept, and it joins the
// thresholds like any other rung. The tool-call rung is the family's lowest cost per solve on the tool-use evaluation, ladder or not.
// The skill's SKILL.md owns what to do with the output.

const AA = 'https://artificialanalysis.ai'
const FRONTIERCODE = 'https://cognition.com/data/frontiercode-leaderboard/data.json'

const args = process.argv.slice(2)
const take = (name) => {
  const at = args.indexOf(name)
  if (at < 0) return undefined
  const [, value] = args.splice(at, 2)
  if (value === undefined) throw new Error(`${name} needs a value`)
  return value
}
const json = args.includes('--json')
if (json) args.splice(args.indexOf('--json'), 1)
const CODING = take('--coding') ?? 'terminalbench-4-0'
const TOOLS = take('--tools') ?? 'automationbench-aa'
const fcVersion = take('--fc-version')
const band = Number(take('--band'))
const keep = new Set((take('--keep') ?? '').split(',').filter(Boolean))
const families = args.map((arg) => {
  const [family, list] = arg.split('=')
  if (!family || !list) throw new Error(`expected <family>=<release>[,<release>…], got "${arg}"`)
  return { family, releases: list.split(',').filter(Boolean) }
})
if (families.length === 0 || !(band >= 0)) {
  console.error('usage: ladder.mjs --band <points> [--keep <slug>[,<slug>…]] [--json] [--coding <eval>] [--tools <eval>] [--fc-version <key>] <family>=<release>[,<release>…] …')
  process.exit(2)
}

async function get(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { headers: { 'user-agent': 'flow-rank-models' } })
      if (response.status === 404) return null
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.text()
    } catch (error) {
      if (attempt === 3) throw new Error(`${url}: ${error.message}`)
      await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** attempt))
    }
  }
}

// A release page is also its max (or only) variant's page, so each slug is fetched once.
const pages = new Map()
function page(slug) {
  if (!pages.has(slug)) pages.set(slug, get(`${AA}/models/${slug}`).then((html) => html && payload(html)))
  return pages.get(slug)
}

function payload(html) {
  const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)]
  return chunks.map((match) => JSON.parse(match[1])).join('')
}

// The balanced JSON object or array starting at `start`, skipping brackets inside strings.
function value(text, start) {
  const open = text[start]
  if (open !== '{' && open !== '[') throw new Error(`expected a JSON object or array at offset ${start}`)
  const close = open === '{' ? '}' : ']'
  let depth = 0
  for (let at = start; at < text.length; at++) {
    const char = text[at]
    if (char === '"') {
      for (at++; at < text.length && text[at] !== '"'; at++) if (text[at] === '\\') at++
      if (at >= text.length) break
    } else if (char === open) depth++
    else if (char === close && --depth === 0) return JSON.parse(text.slice(start, at + 1))
  }
  throw new Error('unterminated JSON value')
}

function field(text, name, from = 0) {
  const needle = `"${name}":`
  const at = text.indexOf(needle, from)
  return at < 0 ? null : value(text, at + needle.length)
}

// One malformed release page reports that release as missing and leaves the other releases alone.
async function variants(release) {
  try {
    const text = await page(release)
    if (text === null) return { release, missing: true, variants: [] }
    const at = text.indexOf(`"releaseSlug":"${release}"`)
    const options = at < 0 ? null : field(text, 'options', at)
    const efforts = Array.isArray(options) ? options : [{ label: 'default', href: `/models/${release}` }]
    return {
      release,
      variants: efforts
        .filter((option) => option?.label !== 'non-reasoning' && typeof option?.href === 'string')
        .map((option) => option.href.replace('/models/', '')),
    }
  } catch (error) {
    return { release, missing: true, why: error.message, variants: [] }
  }
}

const positive = (x) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : null)
const fraction = (x) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1 ? x : null)

function measure(score, cost) {
  const pass = fraction(score)
  const price = positive(cost)
  return { pass, cost: price, measured: pass !== null && pass > 0 && price !== null }
}

// One malformed or missing page reports its own rung as an error and leaves the rest of the run alone.
async function rung(slug, family, frontiercode) {
  try {
    return await measureRung(slug, family, frontiercode)
  } catch (error) {
    return { family, slug, status: 'error', why: error.message }
  }
}

async function measureRung(slug, family, frontiercode) {
  const text = await page(slug)
  const model = text && field(text, 'currentModel')
  if (!model) return { family, slug, status: 'error', why: text === null ? 'page not found' : 'no currentModel object on the page' }
  const evals = Object.fromEntries((model.intelligenceIndexEvaluations ?? []).map((entry) => [entry.slug, entry]))
  const release = model.release?.name ?? model.name
  const effort = model.effort?.label ?? 'default'
  const tb = measure(evals[CODING]?.score, evals[CODING]?.costPerTask)
  const fcRow = frontiercode.data?.[release]?.[effort]?.main
  const fc = measure(fcRow?.new_score, fcRow?.cost)
  const tools = measure(evals[TOOLS]?.score, evals[TOOLS]?.costPerTask)
  const base = {
    family, slug, release, effort, tb, fc,
    tools: tools.pass,
    toolsPerSolve: tools.measured ? tools.cost / tools.pass : null,
    index: positive(model.intelligenceIndex),
    estimated: model.intelligenceIndexIsEstimated === true,
    price: [model.price1mInputTokens, model.price1mOutputTokens],
  }
  const gaps = [
    !tb.measured && `no positive ${CODING} score with a cost (evals here: ${Object.keys(evals).join(', ') || 'none'})`,
    !fc.measured && `no positive FrontierCode main score with a cost for "${release}" at ${effort}`,
  ].filter(Boolean)
  if (gaps.length > 0) return { ...base, status: 'unmeasured', why: gaps.join('; ') }
  const pass = (tb.pass + fc.pass) / 2
  const cost = Math.sqrt(tb.cost * fc.cost)
  return { ...base, status: 'ok', pass, cost, perSolve: cost / pass }
}

function ladder(rungs) {
  const scored = rungs.filter((r) => r.status === 'ok')
  // Name the cheapest rung that beats this one, the one a reader would move to instead.
  for (const r of scored) {
    r.beatenBy = scored
      .filter((other) => other !== r && other.pass >= r.pass && other.perSolve < r.perSolve)
      .sort((a, b) => a.cost - b.cost)[0] ?? null
  }
  const frontier = scored.filter((r) => r.beatenBy === null).sort((a, b) => b.pass - a.pass)
  const on = []
  while (frontier.length > 0) {
    const floor = frontier[0].pass - band / 100
    const group = frontier.filter((r) => r.pass >= floor)
    const kept = group.reduce((a, b) => (b.cost < a.cost ? b : a))
    for (const r of group) if (r !== kept) r.tiedWith = kept
    on.push(kept)
    frontier.splice(0, frontier.length, ...frontier.filter((r) => !group.includes(r)))
  }
  for (const r of scored) if (keep.has(r.slug) && !on.includes(r)) { r.kept = true; on.push(r) }
  on.sort((a, b) => a.cost - b.cost)
  on.forEach((r, i) => { r.tryFirstAbove = on[i + 1] ? r.cost / on[i + 1].cost : null })
  const toolRung = rungs
    .filter((r) => r.status !== 'error' && r.toolsPerSolve !== null)
    .sort((a, b) => a.toolsPerSolve - b.toolsPerSolve)[0] ?? null
  return { on, toolRung }
}

const name = (r) => (r.status === 'error' ? r.slug : `${r.release} ${r.effort}`)
const pct = (x) => (x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`)
const usd = (x) => (x === null || x === undefined ? '—' : x.toFixed(2))
const score = (x) => (x === null || x === undefined ? '—' : x.toFixed(2))

const fcText = await get(FRONTIERCODE)
if (fcText === null) throw new Error(`${FRONTIERCODE} returned 404`)
const fcFile = JSON.parse(fcText)
const fcKey = fcVersion ?? Object.keys(fcFile).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).at(-1)
const frontiercode = fcFile[fcKey]
if (!frontiercode?.data) throw new Error(`FrontierCode has no "${fcKey}" data; keys: ${Object.keys(fcFile).join(', ')}`)

const results = []
for (const { family, releases } of families) {
  const found = await Promise.all(releases.map(variants))
  const rungs = await Promise.all(found.flatMap((f) => f.variants.map((slug) => rung(slug, family, frontiercode))))
  results.push({ family, missing: found.filter((f) => f.missing), rungs, ...ladder(rungs) })
}

if (json) {
  const refs = new Set(['beatenBy', 'tiedWith'])
  console.log(JSON.stringify({ frontiercode: fcKey, band, results }, (key, v) => (refs.has(key) && v ? v.slug : v), 2))
  process.exit(0)
}

console.log(`Coding: ${CODING} on Artificial Analysis and FrontierCode ${fcKey} main (${frontiercode.subsets?.main ?? '?'} tasks). Tools: ${TOOLS}.`)
console.log(`Pass is the mean of the two; $ is the geometric mean of their costs per task at list price. Tie band: ${band} points.\n`)
console.log('| Rung | TB | FC | $ | $/solve | Tools | Try first above |')
console.log('| --- | --- | --- | --- | --- | --- | --- |')
for (const { family, on, toolRung } of results) {
  console.log(`| **${family}** | | | | | | |`)
  const rows = toolRung && !on.includes(toolRung) ? [toolRung, ...on] : on
  for (const r of rows) {
    const label = `${name(r)}${r === toolRung ? ', tools' : ''}${r.kept ? ', kept' : ''}`
    const onLadder = on.includes(r)
    console.log(`| ${label} | ${pct(r.tb.pass)} | ${pct(r.fc.pass)} | ${usd(r.cost)} | ${usd(r.perSolve)} | ${score(r.tools)} | ${onLadder ? pct(r.tryFirstAbove) : '—'} |`)
  }
}

console.log('\nOff the ladder:')
for (const { family, missing, rungs, on, toolRung } of results) {
  for (const { release, why } of missing) console.log(`- ${family}: ${release}: ${why ?? 'no page on Artificial Analysis'}`)
  for (const r of rungs.filter((x) => !on.includes(x) && x !== toolRung)) {
    const why = r.status !== 'ok' ? `${r.status}: ${r.why}`
      : r.beatenBy ? `beaten by ${name(r.beatenBy)}, ${pct(r.beatenBy.pass)} at ${usd(r.beatenBy.perSolve)}/solve`
      : `tied within ${band} points with ${name(r.tiedWith)}, which costs ${usd(r.tiedWith.cost)} to its ${usd(r.cost)}`
    const numbers = r.status === 'ok' ? ` (${pct(r.pass)}, ${usd(r.perSolve)}/solve)` : ''
    console.log(`- ${family}: ${name(r)}${numbers}: ${why}`)
  }
}

console.log('\nEvery rung:')
console.log('| Rung | Index | TB | TB $ | FC | FC $ | Pass | $ | $/solve | Tools | Tools $/solve | $/M in/out |')
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
for (const { rungs } of results) {
  for (const r of rungs) {
    if (r.status === 'error') { console.log(`| ${r.slug} | ${r.why} | | | | | | | | | | |`); continue }
    const index = r.index === null ? '—' : `${r.index.toFixed(1)}${r.estimated ? ' (est)' : ''}`
    const toolsPerSolve = r.toolsPerSolve === null ? '—' : r.toolsPerSolve.toFixed(3)
    console.log(`| ${name(r)} | ${index} | ${pct(r.tb.pass)} | ${usd(r.tb.cost)} | ${pct(r.fc.pass)} | ${usd(r.fc.cost)} | ${pct(r.pass)} | ${usd(r.cost)} | ${usd(r.perSolve)} | ${score(r.tools)} | ${toolsPerSolve} | ${r.price.join('/')} |`)
  }
}
