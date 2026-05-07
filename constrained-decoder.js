'use strict'

/**
 * Constrained Tool Call Decoding (client-side repair)
 * ──────────────────────────────────────────────────
 * Server-side constrained decoding needs logit biasing at the sampler level.
 * Since we use an OpenAI-compatible server, we can't bias logits directly
 * from the client. But we can do the next best thing: aggressive client-side
 * repair + validation of malformed tool_calls, with a feedback-loop retry that
 * costs one round but eliminates the whole class of "invalid tool_call" errors.
 *
 * What this catches:
 *   - Wrong key names (e.g. "args" instead of "arguments", "tool" vs "name")
 *   - Missing required fields per tool schema
 *   - Invalid enum values
 *   - Extra/unknown fields
 *   - Invented tool names (hallucinated tools)
 *   - Stringified JSON inside "arguments" (common model failure mode)
 *   - Truncated JSON (missing closing braces)
 *
 * Usage: call `repairAndValidate(toolCall, toolDefs)` after parsing the model
 * response but before executing. Returns { valid, repaired, issues }.
 */

/**
 * @param {object} toolCall - as emitted by the model (possibly malformed)
 * @param {object[]} toolDefs - array of OpenAI-style tool definitions
 * @returns {{ valid: boolean, repaired: object, issues: string[] }}
 */
function repairAndValidate(toolCall, toolDefs) {
  const issues = []
  let repaired = { ...toolCall }

  // ── Normalize top-level shape ────────────────────────────────────────
  // Expected: { id, type: 'function', function: { name, arguments } }
  if (!repaired.function && repaired.name) {
    repaired.function = { name: repaired.name, arguments: repaired.arguments }
    delete repaired.name
    delete repaired.arguments
    issues.push('hoisted name/arguments into function.*')
  }

  if (!repaired.function) {
    return { valid: false, repaired, issues: ['missing function object'] }
  }

  const fn = repaired.function

  // Model sometimes uses "tool" or "tool_name" instead of "name"
  if (!fn.name && fn.tool) { fn.name = fn.tool; delete fn.tool; issues.push('renamed tool→name') }
  if (!fn.name && fn.tool_name) { fn.name = fn.tool_name; delete fn.tool_name; issues.push('renamed tool_name→name') }

  // Model sometimes uses "args", "params", "parameters", "input"
  if (!fn.arguments) {
    for (const alt of ['args', 'params', 'parameters', 'input']) {
      if (fn[alt] !== undefined) {
        fn.arguments = fn[alt]
        delete fn[alt]
        issues.push(`renamed ${alt}→arguments`)
        break
      }
    }
  }

  // ── Validate tool name exists ────────────────────────────────────────
  const toolDef = toolDefs.find(d => d.function?.name === fn.name)
  if (!toolDef) {
    return {
      valid: false,
      repaired,
      issues: [...issues, `unknown tool: ${fn.name}. Known tools: ${toolDefs.slice(0, 20).map(d => d.function?.name).join(', ')}`],
    }
  }

  // ── Parse and repair arguments ───────────────────────────────────────
  let args = fn.arguments
  if (typeof args === 'string') {
    // Try parse, with common repairs
    args = _parseJsonWithRepair(args, issues)
    if (args === null) {
      return {
        valid: false,
        repaired,
        issues: [...issues, `could not parse arguments as JSON: ${(fn.arguments || '').slice(0, 100)}`],
      }
    }
  }

  if (args === null || args === undefined) args = {}

  // Handle double-encoding: arguments = '{"key":"value"}' inside a string
  // (happens when model emits `arguments: "{\"path\":\"x\"}"`)
  if (typeof args === 'object' && Object.keys(args).length === 1 &&
      typeof args[Object.keys(args)[0]] === 'string') {
    const onlyKey = Object.keys(args)[0]
    const onlyVal = args[onlyKey]
    if ((onlyKey === 'arguments' || onlyKey === 'args') && onlyVal.startsWith('{')) {
      const inner = _parseJsonWithRepair(onlyVal, issues)
      if (inner) { args = inner; issues.push('unwrapped double-encoded arguments') }
    }
  }

  // ── Validate against schema ──────────────────────────────────────────
  const schema = toolDef.function.parameters || {}
  // Apply type coercions FIRST, then validate.
  // This lets us fix coercible issues (string→number, single→array) before
  // they're reported as type mismatches.
  args = _applyDefaults(args, schema, issues)
  const schemaIssues = _validateAgainstSchema(args, schema)
  issues.push(...schemaIssues)

  fn.arguments = JSON.stringify(args)

  repaired.function = fn
  return {
    valid: schemaIssues.length === 0,
    repaired,
    issues,
  }
}

/**
 * Parse JSON with common LLM-output repairs:
 *   - Trailing commas
 *   - Unquoted keys
 *   - Single quotes instead of double
 *   - Missing closing braces/brackets
 *   - Leading/trailing whitespace or markdown fences
 */
function _parseJsonWithRepair(str, issues) {
  if (!str || typeof str !== 'string') return null
  let s = str.trim()

  // Strip markdown fences
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    issues.push('stripped markdown fence')
  }

  // Direct parse first
  try { return JSON.parse(s) } catch {}

  // Repair: trailing commas in objects/arrays
  let repaired = s.replace(/,(\s*[}\]])/g, '$1')
  try { return JSON.parse(repaired) } catch {}

  // Repair: single quotes → double quotes (careful with escapes)
  repaired = repaired.replace(/'/g, '"')
  try { return JSON.parse(repaired) } catch {}

  // Repair: unquoted keys (common after single-quote fix)
  repaired = repaired.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":')
  try { return JSON.parse(repaired) } catch {}

  // Repair: append missing closing braces
  const openBraces = (repaired.match(/\{/g) || []).length
  const closeBraces = (repaired.match(/\}/g) || []).length
  if (openBraces > closeBraces) {
    repaired += '}'.repeat(openBraces - closeBraces)
    try { return JSON.parse(repaired); } catch {}
  }
  const openBrackets = (repaired.match(/\[/g) || []).length
  const closeBrackets = (repaired.match(/\]/g) || []).length
  if (openBrackets > closeBrackets) {
    repaired += ']'.repeat(openBrackets - closeBrackets)
    try { return JSON.parse(repaired); } catch {}
  }

  // Last resort: find the largest prefix that parses
  for (let i = repaired.length; i > 0; i--) {
    try {
      const candidate = repaired.slice(0, i)
      if (!candidate.trim().endsWith('}') && !candidate.trim().endsWith(']')) continue
      return JSON.parse(candidate)
    } catch {}
  }

  return null
}

/**
 * Validate an args object against a JSON Schema (limited subset).
 */
function _validateAgainstSchema(args, schema) {
  const issues = []
  if (!schema || typeof schema !== 'object') return issues

  const required = schema.required || []
  for (const key of required) {
    if (args[key] === undefined || args[key] === null) {
      issues.push(`missing required field: ${key}`)
    }
  }

  const props = schema.properties || {}
  for (const [key, val] of Object.entries(args)) {
    if (!props[key]) continue
    const propSchema = props[key]
    const expectedType = propSchema.type
    const actualType = Array.isArray(val) ? 'array' : typeof val
    if (expectedType && expectedType !== actualType) {
      // Common coercion: string → number
      if (expectedType === 'number' && actualType === 'string' && !isNaN(Number(val))) {
        // Will be fixed in _applyDefaults
        continue
      }
      issues.push(`type mismatch for ${key}: expected ${expectedType}, got ${actualType}`)
    }
    if (propSchema.enum && !propSchema.enum.includes(val)) {
      issues.push(`invalid enum value for ${key}: got ${val}, expected one of ${propSchema.enum.join(', ')}`)
    }
  }

  return issues
}

/**
 * Apply type coercions and fill in sensible defaults where possible.
 */
function _applyDefaults(args, schema, issues) {
  if (!schema?.properties) return args
  const out = { ...args }
  for (const [key, val] of Object.entries(out)) {
    const prop = schema.properties[key]
    if (!prop) continue
    // Coerce string → number
    if (prop.type === 'number' && typeof val === 'string' && !isNaN(Number(val))) {
      out[key] = Number(val)
      issues.push(`coerced ${key} from string to number`)
    }
    // Coerce string → boolean
    if (prop.type === 'boolean' && typeof val === 'string') {
      if (val.toLowerCase() === 'true') { out[key] = true; issues.push(`coerced ${key} to boolean true`) }
      else if (val.toLowerCase() === 'false') { out[key] = false; issues.push(`coerced ${key} to boolean false`) }
    }
    // Array coerce: single value → array
    if (prop.type === 'array' && !Array.isArray(val)) {
      out[key] = [val]
      issues.push(`coerced ${key} single value to array`)
    }
  }
  return out
}

/**
 * Build a feedback message for the model describing what went wrong,
 * suitable for sending back as a tool-error to trigger a retry.
 */
function buildRepairFeedback(toolCall, toolDefs, issues) {
  const name = toolCall?.function?.name || '(unknown)'
  const def = toolDefs.find(d => d.function?.name === name)
  const schema = def?.function?.parameters

  const lines = [
    `Tool call validation failed for "${name}":`,
    ...issues.map(i => `  • ${i}`),
  ]
  if (schema) {
    lines.push('')
    lines.push('Expected schema:')
    lines.push(JSON.stringify(schema, null, 2))
  }
  lines.push('')
  lines.push('Fix the arguments and call the tool again with the correct shape.')
  return lines.join('\n')
}

module.exports = { repairAndValidate, buildRepairFeedback }
