// The JSON Schema subset a structured answer is checked against before a job may succeed. A
// schema is admitted only when every keyword in it is one this file checks or a pure annotation,
// so an admitted schema is always checked in full; nothing is skipped silently. `$ref` resolves
// inside the schema itself and nowhere else, as a JSON pointer from the root. A nested `$id` would
// start a resource of its own for the references under it, so `$id` is admitted at the root alone.
//
// Admission bounds the schema, not the work of checking an answer against it: references can
// share a subschema along branches that multiply at every level, and a pattern can backtrack
// without end on the string it meets. The runner holds the job and its lease until the outcome is
// written, so checkAnswer runs this file as a child process and kills it after CHECK_SECONDS.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const CHECK_SECONDS = 10
const SELF = fileURLToPath(import.meta.url)

const CHECKED = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern',
  'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties', 'anyOf', 'oneOf', 'allOf', 'not',
  '$ref', '$defs', 'definitions'])
const ANNOTATIONS = new Set(['$schema', '$id', '$comment', 'title', 'description', 'default', 'examples', 'format',
  'deprecated', 'readOnly', 'writeOnly'])
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
const NUMBERS = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']
const COUNTS = ['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties']
const ERROR_LIMIT = 10
const DEPTH_LIMIT = 64

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isSchema = (value) => typeof value === 'boolean' || isObject(value)

function resolve(root, ref) {
  if (typeof ref !== 'string' || (ref !== '#' && !ref.startsWith('#/'))) return undefined
  let node = root
  for (const raw of ref.slice(1).split('/').slice(1)) {
    // A malformed percent-escape names nothing, so the reference does not resolve.
    let key
    try { key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~') } catch { return undefined }
    if (!isObject(node) || !Object.hasOwn(node, key)) return undefined
    node = node[key]
  }
  return isSchema(node) ? node : undefined
}

/** Why the schema cannot be admitted, or null. */
export function schemaProblem(schema, root = schema, at = '#', depth = 0) {
  if (typeof schema === 'boolean') return null
  if (!isObject(schema)) return `${at} is not a schema`
  if (depth > DEPTH_LIMIT) return `${at} nests deeper than ${DEPTH_LIMIT} levels`
  for (const key of Object.keys(schema)) {
    if (!CHECKED.has(key) && !ANNOTATIONS.has(key)) return `${at} uses ${key}, which the delegate cannot check`
  }
  if (depth > 0 && schema.$id !== undefined) return `${at} sets $id, and the delegate resolves every $ref from the root`
  if (schema.type !== undefined) {
    const types = [].concat(schema.type)
    if (!types.length || types.some((type) => !TYPES.has(type))) return `${at}/type names no JSON type`
  }
  if (schema.required !== undefined && !(Array.isArray(schema.required) && schema.required.every((key) => typeof key === 'string'))) return `${at}/required is not a list of names`
  if (schema.enum !== undefined && !(Array.isArray(schema.enum) && schema.enum.length)) return `${at}/enum is not a non-empty list`
  for (const key of NUMBERS) if (schema[key] !== undefined && !Number.isFinite(schema[key])) return `${at}/${key} is not a number`
  if (schema.multipleOf !== undefined && !(Number.isFinite(schema.multipleOf) && schema.multipleOf > 0)) return `${at}/multipleOf is not a positive number`
  for (const key of COUNTS) if (schema[key] !== undefined && !(Number.isInteger(schema[key]) && schema[key] >= 0)) return `${at}/${key} is not a count`
  if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== 'boolean') return `${at}/uniqueItems is not a boolean`
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== 'string') return `${at}/pattern is not a string`
    try { new RegExp(schema.pattern, 'u') } catch { return `${at}/pattern is not a valid regular expression` }
  }
  if (schema.$ref !== undefined && resolve(root, schema.$ref) === undefined) return `${at}/$ref does not resolve inside the schema`
  const children = []
  for (const key of ['properties', '$defs', 'definitions']) {
    if (schema[key] === undefined) continue
    if (!isObject(schema[key])) return `${at}/${key} is not an object`
    for (const [name, child] of Object.entries(schema[key])) children.push([child, `${at}/${key}/${name}`])
  }
  for (const key of ['additionalProperties', 'items', 'not']) if (schema[key] !== undefined) children.push([schema[key], `${at}/${key}`])
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (schema[key] === undefined) continue
    if (!Array.isArray(schema[key]) || !schema[key].length) return `${at}/${key} is not a non-empty list`
    schema[key].forEach((child, index) => children.push([child, `${at}/${key}/${index}`]))
  }
  for (const [child, path] of children) {
    const problem = schemaProblem(child, root, path, depth + 1)
    if (problem) return problem
  }
  return null
}

function same(a, b) {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => same(item, b[i]))
  if (!isObject(a) || !isObject(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && same(a[key], b[key]))
}

/** The decimal JSON prints for a finite number, as digits × 10^exponent. */
function decimal(number) {
  const [mantissa, exponent = '0'] = String(Math.abs(number)).split('e')
  const [whole, fraction = ''] = mantissa.split('.')
  return { digits: BigInt(whole + fraction), exponent: Number(exponent) - fraction.length }
}

// Decided exactly, on the decimals JSON prints for both numbers, which is the text the caller
// receives. A floating-point quotient rounds, and it overflows to Infinity for a small divisor.
function isMultiple(value, divisor) {
  const [v, d] = [decimal(value), decimal(divisor)]
  const low = Math.min(v.exponent, d.exponent)
  return (v.digits * 10n ** BigInt(v.exponent - low)) % (d.digits * 10n ** BigInt(d.exponent - low)) === 0n
}

function is(type, value) {
  switch (type) {
    case 'null': return value === null
    case 'boolean': return typeof value === 'boolean'
    case 'string': return typeof value === 'string'
    case 'number': return Number.isFinite(value)
    case 'integer': return Number.isInteger(value)
    case 'array': return Array.isArray(value)
    default: return isObject(value)
  }
}

function check(schema, value, at, root, errors, depth) {
  if (errors.length >= ERROR_LIMIT || schema === true) return
  if (schema === false) { errors.push(`${at}: no value is allowed here`); return }
  if (depth > DEPTH_LIMIT) { errors.push(`${at}: the schema recurses deeper than ${DEPTH_LIMIT} levels`); return }
  const fail = (text) => { errors.push(`${at}: ${text}`) }
  if (schema.$ref !== undefined) check(resolve(root, schema.$ref), value, at, root, errors, depth + 1)
  const types = schema.type === undefined ? null : [].concat(schema.type)
  if (types && !types.some((type) => is(type, value))) fail(`expected ${types.join(' or ')}`)
  if (schema.enum !== undefined && !schema.enum.some((option) => same(option, value))) fail('not one of the allowed values')
  if (Object.hasOwn(schema, 'const') && !same(schema.const, value)) fail('not the required value')
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) fail(`below the minimum ${schema.minimum}`)
    if (schema.maximum !== undefined && value > schema.maximum) fail(`above the maximum ${schema.maximum}`)
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) fail(`not above ${schema.exclusiveMinimum}`)
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) fail(`not below ${schema.exclusiveMaximum}`)
    if (schema.multipleOf !== undefined && !(Number.isFinite(value) && isMultiple(value, schema.multipleOf))) fail(`not a multiple of ${schema.multipleOf}`)
  }
  if (typeof value === 'string') {
    const length = Array.from(value).length
    if (schema.minLength !== undefined && length < schema.minLength) fail(`shorter than ${schema.minLength} characters`)
    if (schema.maxLength !== undefined && length > schema.maxLength) fail(`longer than ${schema.maxLength} characters`)
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) fail('does not match the pattern')
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail(`fewer than ${schema.minItems} items`)
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(`more than ${schema.maxItems} items`)
    if (schema.uniqueItems && value.some((item, i) => value.findIndex((other) => same(other, item)) !== i)) fail('items are not unique')
    if (schema.items !== undefined) value.forEach((item, i) => check(schema.items, item, `${at}[${i}]`, root, errors, depth + 1))
  }
  if (isObject(value)) {
    const keys = Object.keys(value)
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) fail(`fewer than ${schema.minProperties} properties`)
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) fail(`more than ${schema.maxProperties} properties`)
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) fail(`missing the required property ${JSON.stringify(key)}`)
    for (const key of keys) {
      const path = `${at}.${key}`
      if (schema.properties && Object.hasOwn(schema.properties, key)) check(schema.properties[key], value[key], path, root, errors, depth + 1)
      else if (schema.additionalProperties === false) errors.push(`${path}: not a property the schema allows`)
      else if (schema.additionalProperties !== undefined) check(schema.additionalProperties, value[key], path, root, errors, depth + 1)
    }
  }
  const passes = (sub) => validate(sub, value, root, depth + 1).length === 0
  for (const sub of schema.allOf ?? []) check(sub, value, at, root, errors, depth + 1)
  if (schema.anyOf && !schema.anyOf.some(passes)) fail('matches none of the anyOf alternatives')
  if (schema.oneOf && schema.oneOf.filter(passes).length !== 1) fail('does not match exactly one of the oneOf alternatives')
  if (schema.not !== undefined && passes(schema.not)) fail('matches a schema it must not')
}

/** Where the value breaks the schema, as up to ten `path: problem` lines; empty when it conforms. */
export function validate(schema, value, root = schema, depth = 0) {
  const errors = []
  check(schema, value, '$', root, errors, depth)
  return errors
}

/** validate() against the schema file, in a child process: its lines, or null when it was killed unfinished. */
export function checkAnswer(schemaPath, value, timeoutMs = CHECK_SECONDS * 1000) {
  const child = spawnSync(process.execPath, [SELF, schemaPath], {
    input: JSON.stringify(value), encoding: 'utf8', env: {}, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024,
  })
  if (child.error?.code === 'ETIMEDOUT') return null
  let errors
  try { errors = child.status === 0 ? JSON.parse(child.stdout) : undefined } catch {}
  if (!Array.isArray(errors)) {
    throw new Error(`the schema check ended without a verdict (${child.error?.message ?? `exit ${child.status ?? child.signal}`}): ${String(child.stderr ?? '').split('\n')[0]}`)
  }
  return errors
}

if (process.argv[1] === SELF) {
  const schema = JSON.parse(readFileSync(process.argv[2], 'utf8'))
  process.stdout.write(JSON.stringify(validate(schema, JSON.parse(readFileSync(0, 'utf8')))))
}
