'use strict'

/**
 * Speculative Tool Execution
 * ───────────────────────────
 * While the model streams a tool_call, parse partial arguments and kick off
 * read-only tools in the background. By the time the full tool_call arrives,
 * the result is often already ready — overlapping generation with I/O.
 *
 * Only read-only, side-effect-free tools are speculated. Writes, bash, edits
 * are always awaited sequentially.
 *
 * Design:
 *  - Parses incremental JSON stream, fires a speculation when args are stable
 *    enough to execute (e.g. "path" complete for read_file).
 *  - Memoizes by tool signature — if speculation was wrong, we discard.
 *  - Handles multiple in-flight speculations; resolves on full tool_call match.
 *
 * Plug point: direct-bridge.js tool loop. Instead of waiting for the full
 * tool_call, call `speculator.observeStream(partialArgs, toolName)` on each
 * streamed chunk. When the real tool_call arrives, call
 * `speculator.resolve(toolName, fullArgs)` — if a speculation matches, it
 * returns the cached result instantly; otherwise executes fresh.
 */

const crypto = require('node:crypto')

// Tools that are safe to speculate — no side effects, idempotent
const SAFE_TOOLS = new Set([
  'read_file',
  'read_files',
  'list_dir',
  'search_files',
  'ast_search',
  'lsp_get_document_symbols',
  'lsp_get_hover',
  'lsp_get_definition',
  'lsp_get_references',
  'lsp_get_type_definition',
  'lsp_workspace_symbol',
  'lsp_get_call_hierarchy',
  'lsp_get_diagnostics',
  'undo_list',
])

// Per-tool minimum arg set required before we can speculate.
// If the streamed partial args contain all required fields and they parse
// as valid JSON, we can fire the speculation.
const MIN_ARGS_FOR_SPEC = {
  read_file: ['path'],
  read_files: ['paths'],
  list_dir: ['path'],
  search_files: [], // both `pattern` or `patterns` are optional depending on shape
  ast_search: ['query'],
  lsp_get_document_symbols: ['file_path'],
  lsp_get_hover: ['file_path', 'line', 'column'],
  lsp_get_definition: ['file_path', 'line', 'column'],
  lsp_get_references: ['file_path', 'line', 'column'],
  lsp_get_type_definition: ['file_path', 'line', 'column'],
  lsp_workspace_symbol: [],
  lsp_get_call_hierarchy: ['file_path', 'line', 'column'],
  lsp_get_diagnostics: [],
  undo_list: [],
}

class ToolSpeculator {
  /**
   * @param {object} opts
   * @param {function} opts.execute - async (name, args) => result. Usually a
   *   bound call to executeTool() with cwd/lspManager/etc already applied.
   * @param {number} [opts.maxInflight=4] - max concurrent speculations
   * @param {function} [opts.onSpeculate] - called when a speculation starts (for metrics)
   * @param {function} [opts.onHit] - called when a speculation is used (for metrics)
   * @param {function} [opts.onMiss] - called when a speculation is discarded
   */
  constructor(opts = {}) {
    this._execute = opts.execute
    this._maxInflight = opts.maxInflight ?? 4
    this._onSpeculate = opts.onSpeculate || (() => {})
    this._onHit = opts.onHit || (() => {})
    this._onMiss = opts.onMiss || (() => {})
    // Map<signature, Promise<{result, args}>>
    this._inflight = new Map()
    this._hits = 0
    this._misses = 0
    this._fired = 0
  }

  static isSafe(toolName) {
    return SAFE_TOOLS.has(toolName)
  }

  /**
   * Compute a stable signature for a (tool, args) pair.
   */
  _sig(name, args) {
    // Normalize: sort keys so object ordering doesn't change signature
    const canonical = JSON.stringify(args, Object.keys(args || {}).sort())
    return `${name}::${crypto.createHash('sha1').update(canonical).digest('hex').slice(0, 16)}`
  }

  /**
   * Check if partial args are complete enough to speculate.
   */
  _readyToSpeculate(name, args) {
    if (!SAFE_TOOLS.has(name)) return false
    const required = MIN_ARGS_FOR_SPEC[name] || []
    for (const key of required) {
      const v = args?.[key]
      if (v === undefined || v === null) return false
      if (typeof v === 'string' && v.length === 0) return false
      if (Array.isArray(v) && v.length === 0) return false
    }
    return true
  }

  /**
   * Called while the model is streaming a tool_call. If args look complete
   * enough, fire a background execution. No-op if already in flight, unsafe
   * tool, or max concurrency reached.
   *
   * @param {string} name - tool name
   * @param {object} args - partial or complete args object
   * @returns {string|null} signature of the speculation, or null if skipped
   */
  speculate(name, args) {
    if (!this._execute) return null
    if (!this._readyToSpeculate(name, args)) return null
    if (this._inflight.size >= this._maxInflight) return null

    const sig = this._sig(name, args)
    if (this._inflight.has(sig)) return sig

    this._fired++
    this._onSpeculate({ name, args, sig })

    // Fire-and-store. We don't await — the promise sits in the map.
    const p = (async () => {
      try {
        const result = await this._execute(name, args)
        return { result, args, name, error: null }
      } catch (err) {
        return { result: null, args, name, error: err }
      }
    })()

    this._inflight.set(sig, p)
    return sig
  }

  /**
   * When the full tool_call arrives, resolve against in-flight speculations.
   * If a matching speculation exists, returns its result (hit). Otherwise
   * executes fresh (miss) and discards any non-matching speculations.
   *
   * @param {string} name
   * @param {object} args
   * @returns {Promise<{result, hit: boolean}>}
   */
  async resolve(name, args) {
    const sig = this._sig(name, args)
    const inflight = this._inflight.get(sig)

    if (inflight) {
      this._hits++
      this._onHit({ name, args, sig })
      const { result, error } = await inflight
      this._inflight.delete(sig)
      // Discard all other speculations (they were wrong paths)
      this._discardOthers(sig)
      if (error) throw error
      return { result, hit: true }
    }

    // Miss — discard all speculations, execute fresh
    this._misses++
    this._onMiss({ name, args })
    this._discardOthers(null)
    const result = await this._execute(name, args)
    return { result, hit: false }
  }

  /**
   * Abandon all in-flight speculations except the one whose sig is given.
   * Pending promises complete in the background and are garbage collected.
   */
  _discardOthers(keepSig) {
    for (const sig of this._inflight.keys()) {
      if (sig !== keepSig) this._inflight.delete(sig)
    }
  }

  /**
   * Abandon everything — used on turn boundaries or abort.
   */
  clear() {
    this._inflight.clear()
  }

  stats() {
    return {
      fired: this._fired,
      hits: this._hits,
      misses: this._misses,
      hit_rate: this._fired > 0 ? this._hits / this._fired : 0,
      inflight: this._inflight.size,
    }
  }
}

module.exports = { ToolSpeculator, SAFE_TOOLS }
