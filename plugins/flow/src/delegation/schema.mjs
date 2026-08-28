import Ajv2020 from 'ajv/dist/2020.js'
import { DelegationError } from './contracts.mjs'

const objectAt = (path) => `outputSchema${path}`
const SCHEMA_METADATA = new Set([
  '$anchor', '$comment', '$defs', '$dynamicAnchor', '$id', '$schema',
  'default', 'deprecated', 'description', 'examples', 'readOnly', 'title', 'writeOnly',
])
const REF_ONLY = new Set([...SCHEMA_METADATA, '$ref'])
const UNSUPPORTED_APPLICATORS = [
  'allOf', 'contains', 'dependentSchemas', 'else', 'if', 'not', 'oneOf',
  'patternProperties', 'prefixItems', 'propertyNames', 'then',
  'unevaluatedItems', 'unevaluatedProperties',
]

function validateCodexNode(schema, path = '', { root = false } = {}) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new DelegationError('BAD_SCHEMA', `${objectAt(path)} must be an object for Codex structured output.`)
  }
  if (root && schema.anyOf) {
    throw new DelegationError('BAD_SCHEMA', 'outputSchema cannot use anyOf at the root for Codex structured output.')
  }
  if (root && schema.type !== 'object') {
    throw new DelegationError('BAD_SCHEMA', 'outputSchema must declare an object root for Codex structured output.')
  }
  for (const [keyword, definitions] of [['$defs', schema.$defs], ['definitions', schema.definitions]]) {
    if (!definitions) continue
    for (const [name, definition] of Object.entries(definitions)) {
      validateCodexNode(definition, `${path}.${keyword}[${JSON.stringify(name)}]`)
    }
  }
  for (const keyword of UNSUPPORTED_APPLICATORS) {
    if (schema[keyword] !== undefined) {
      throw new DelegationError('BAD_SCHEMA', `${objectAt(path)} uses unsupported ${keyword} for Codex structured output.`)
    }
  }
  if (schema.$ref && Object.keys(schema).every((keyword) => REF_ONLY.has(keyword))) return
  if (Array.isArray(schema.anyOf)) {
    if (!schema.anyOf.length) throw new DelegationError('BAD_SCHEMA', `${objectAt(path)}.anyOf cannot be empty.`)
    schema.anyOf.forEach((branch, index) => validateCodexNode(branch, `${path}.anyOf[${index}]`))
    if (Object.keys(schema).every((keyword) => keyword === 'anyOf' || SCHEMA_METADATA.has(keyword))) return
  }
  if (typeof schema.type !== 'string') {
    throw new DelegationError('BAD_SCHEMA', `${objectAt(path)} must declare an explicit type for Codex structured output.`)
  }
  if (schema.type === 'object') {
    if (schema.additionalProperties !== false) {
      throw new DelegationError('BAD_SCHEMA', `${objectAt(path)} must set additionalProperties to false for Codex structured output.`)
    }
    const properties = schema.properties || {}
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
      throw new DelegationError('BAD_SCHEMA', `${objectAt(path)}.properties must be an object.`)
    }
    const names = Object.keys(properties)
    if (!Array.isArray(schema.required) || schema.required.length !== names.length
      || names.some((name) => !schema.required.includes(name))) {
      throw new DelegationError('BAD_SCHEMA', `${objectAt(path)}.required must list every property for Codex structured output.`)
    }
    for (const [name, child] of Object.entries(properties)) {
      validateCodexNode(child, `${path}.properties[${JSON.stringify(name)}]`)
    }
  } else if (schema.type === 'array') {
    if (schema.items === undefined) {
      throw new DelegationError('BAD_SCHEMA', `${objectAt(path)}.items is required for Codex structured output.`)
    }
    validateCodexNode(schema.items, `${path}.items`)
  }
}

export function validateOutputSchema(schema, target) {
  if (schema == null) return null
  if (Buffer.byteLength(JSON.stringify(schema)) > 64 * 1024) {
    throw new DelegationError('BAD_SCHEMA', 'The output schema exceeds 64 KiB.')
  }
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  if (!ajv.validateSchema(schema)) throw new DelegationError('BAD_SCHEMA', 'outputSchema is not a valid JSON Schema.')
  try { ajv.compile(schema) } catch { throw new DelegationError('BAD_SCHEMA', 'outputSchema cannot be compiled.') }
  if (target === 'codex') {
    validateCodexNode(schema, '', { root: true })
  }
  return schema
}

export function providerOutputSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || schema.$schema === undefined) return schema
  const providerSchema = structuredClone(schema)
  delete providerSchema.$schema
  return providerSchema
}
