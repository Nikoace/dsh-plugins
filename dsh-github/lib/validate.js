/**
 * Minimal JSON-Schema validation for tool arguments.
 *
 * `defineTool` from `@deepseek-ai/dsh-tools` compiles and validates arguments,
 * but a dependency-free bundle cannot import that package. The tool registry
 * accepts a raw JSON Schema, so this module validates the same supported subset
 * (`type`, `properties`, `required`, `additionalProperties`, `items`, `enum`,
 * `const`, `oneOf`) before a tool body runs.
 */

/** @param {unknown} value - candidate. @returns {value is Record<string, unknown>} plain record. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {unknown} value - candidate. @returns {string} diagnostic path segment. */
function segment(key) {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`
}

/**
 * Validate a JSON value against the supported schema subset.
 *
 * @param {Record<string, unknown>} schema - raw JSON Schema node.
 * @param {unknown} value - candidate value.
 * @param {string} path - diagnostic path of the candidate.
 * @returns {string[]} violations in walk order; empty means valid.
 */
export function validateValue(schema, value, path = 'arguments') {
  const violations = []
  if (!isRecord(schema)) return [`${path} has no schema`]

  if (Object.hasOwn(schema, 'oneOf')) {
    const branches = Array.isArray(schema.oneOf) ? schema.oneOf : []
    const matches = branches.filter((branch) => isRecord(branch) && validateValue(branch, value, path).length === 0)
    if (matches.length !== 1) violations.push(`${path} must match exactly one oneOf branch (matched ${matches.length})`)
    return violations
  }

  const type = typeof schema.type === 'string' ? schema.type : undefined
  if (type !== undefined && type !== 'json') {
    const matches =
      type === 'object'
        ? isRecord(value)
        : type === 'array'
          ? Array.isArray(value)
          : type === 'string'
            ? typeof value === 'string'
            : type === 'number'
              ? typeof value === 'number' && Number.isFinite(value)
              : type === 'integer'
                ? typeof value === 'number' && Number.isInteger(value)
                : type === 'boolean'
                  ? typeof value === 'boolean'
                  : type === 'null'
                    ? value === null
                    : true
    if (!matches) {
      violations.push(`${path} must be ${type === 'integer' ? 'an integer' : `a ${type}`}`)
      return violations
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    violations.push(`${path} must be one of ${JSON.stringify(schema.enum)}`)
  }
  if (Object.hasOwn(schema, 'const') && value !== schema.const) {
    violations.push(`${path} must be ${JSON.stringify(schema.const)}`)
  }

  if (type === 'object' && isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {}
    const required = Array.isArray(schema.required) ? schema.required : []
    for (const name of required) {
      if (typeof name === 'string' && !Object.hasOwn(value, name)) violations.push(`${path}${segment(name)} is required`)
    }
    for (const [name, propertySchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, name)) violations.push(...validateValue(propertySchema, value[name], `${path}${segment(name)}`))
    }
    if (schema.additionalProperties === false) {
      for (const name of Object.keys(value)) {
        if (!Object.hasOwn(properties, name)) violations.push(`${path}${segment(name)} is not a supported argument`)
      }
    }
  }

  if (type === 'array' && Array.isArray(value) && isRecord(schema.items)) {
    value.forEach((entry, index) => {
      violations.push(...validateValue(schema.items, entry, `${path}[${index}]`))
    })
  }

  return violations
}

/**
 * Assert model-generated arguments against a tool's parameter schema.
 *
 * @param {Record<string, unknown>} schema - tool parameter schema.
 * @param {unknown} args - parsed arguments.
 * @returns {void}
 * @throws {Error} with every violation listed.
 */
export function assertArgs(schema, args) {
  const violations = validateValue(schema, args)
  if (violations.length > 0) throw new Error(`invalid arguments: ${violations.join('; ')}`)
}

/**
 * Read a required non-empty string argument.
 *
 * @param {Record<string, unknown>} args - validated arguments.
 * @param {string} name - field name.
 * @returns {string} trimmed value.
 * @throws {Error} when absent or blank.
 */
export function requireText(args, name) {
  const value = args[name]
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} must be a non-empty string`)
  return value.trim()
}

/**
 * Read an optional string argument.
 *
 * @param {Record<string, unknown>} args - arguments.
 * @param {string} name - field name.
 * @returns {string} trimmed value, or `''`.
 */
export function optionalText(args, name) {
  const value = args[name]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Read an integer argument clamped into a range.
 *
 * @param {Record<string, unknown>} args - arguments.
 * @param {string} name - field name.
 * @param {number} fallback - default when absent.
 * @param {number} min - inclusive lower bound.
 * @param {number} max - inclusive upper bound.
 * @returns {number} resolved integer.
 */
export function integerIn(args, name, fallback, min, max) {
  const value = args[name]
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback
  return Math.max(min, Math.min(max, value))
}

/**
 * Read a required positive integer argument.
 *
 * @param {Record<string, unknown>} args - arguments.
 * @param {string} name - field name.
 * @returns {number} positive integer.
 * @throws {Error} when absent or not a positive integer.
 */
export function positiveInteger(args, name) {
  const value = args[name]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

/**
 * Read a string array argument, dropping non-strings.
 *
 * @param {Record<string, unknown>} args - arguments.
 * @param {string} name - field name.
 * @returns {string[]} normalized values.
 */
export function stringArray(args, name) {
  const value = args[name]
  if (!Array.isArray(value)) return []
  return value.filter((entry) => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim())
}
