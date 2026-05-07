'use strict'

/**
 * System prompt + steering docs cache
 * ────────────────────────────────────
 * `_buildSystemPrompt()` in direct-bridge.js is rebuilt on every `run()` call
 * and on every orchestrator dispatch. `loadSteeringDocs()` does `readdirSync`
 * plus N `readFileSync` on every call too. For an N-task spec that's N × 5
 * file reads + N × 5 KB of string concat just to produce bytes that are
 * usually identical.
 *
 * This module gives both a small, invalidation-correct cache so:
 *   1. Identical agent dispatches produce byte-identical prompts — the
 *      server's prefix cache then actually hits.
 *   2. Orchestrator fan-out stops re-reading steering docs N times.
 *
 * Invalidation is mtime-based:
 *   - System prompt: keyed on (agentRole, cwd, permissionMode). Invalidated
 *     when `.maccoder/steering/code-map.md` changes (affects the orient
 *     preamble).
 *   - Steering docs: keyed on projectDir. Invalidated when any `.md` file in
 *     `.maccoder/steering/` is added/removed/modified (digest of
 *     filename:mtime:size for every .md file in the dir).
 *
 * All cache lookups are synchronous and do a single `fs.statSync` per file,
 * so a cache hit is ~sub-millisecond even on cold disk.
 */

const fs = require('node:fs')
const path = require('node:path')

const SYSTEM_PROMPT_MAX_ENTRIES = 32
const STEERING_MAX_ENTRIES = 16

// key `${agentRole}|${cwd}|${permissionMode}` → { value, codeMapMtime }
const _systemPromptCache = new Map()

// projectDir → { digest, docs, formatted }
const _steeringCache = new Map()

let _hits = 0
let _misses = 0

function _codeMapMtime(cwd) {
  try {
    return fs.statSync(path.join(cwd, '.maccoder', 'steering', 'code-map.md')).mtimeMs
  } catch {
    return 0
  }
}

/**
 * Return a cached system prompt or call `builder()` to produce and cache one.
 * Cache key is `(agentRole, cwd, permissionMode)`; invalidation hinges on the
 * mtime of `.maccoder/steering/code-map.md` (the only file that influences
 * output between calls with the same key).
 *
 * @param {string} agentRole
 * @param {string} cwd
 * @param {string} permissionMode
 * @param {() => string} builder - synchronous producer of the prompt string
 * @returns {string}
 */
function getCachedSystemPrompt(agentRole, cwd, permissionMode, builder) {
  const key = `${agentRole}|${cwd}|${permissionMode}`
  const codeMapMtime = _codeMapMtime(cwd)
  const cached = _systemPromptCache.get(key)
  if (cached && cached.codeMapMtime === codeMapMtime) {
    _hits++
    // Move-to-end for simple LRU behaviour
    _systemPromptCache.delete(key)
    _systemPromptCache.set(key, cached)
    return cached.value
  }
  _misses++
  const value = builder()
  _systemPromptCache.set(key, { value, codeMapMtime })
  // Evict oldest when over capacity
  while (_systemPromptCache.size > SYSTEM_PROMPT_MAX_ENTRIES) {
    const oldest = _systemPromptCache.keys().next().value
    _systemPromptCache.delete(oldest)
  }
  return value
}

/**
 * Compute a stable digest of every `.md` file in a project's steering dir.
 * Uses (filename, mtime, size) for each file — skips directory contents
 * beyond the top level (steering docs are flat by convention).
 */
function _steeringDigest(projectDir) {
  const steeringDir = path.join(projectDir, '.maccoder', 'steering')
  let entries
  try {
    entries = fs.readdirSync(steeringDir)
  } catch {
    return '__no_steering_dir__'
  }
  const mdFiles = entries.filter(f => f.endsWith('.md')).sort()
  const parts = []
  for (const f of mdFiles) {
    try {
      const st = fs.statSync(path.join(steeringDir, f))
      parts.push(`${f}:${st.mtimeMs}:${st.size}`)
    } catch {
      parts.push(`${f}:missing`)
    }
  }
  return parts.length === 0 ? '__empty__' : parts.join('|')
}

/**
 * Return cached steering docs + formatted prompt section, or (re)load when
 * the directory digest has changed.
 *
 * @param {string} projectDir
 * @param {(projectDir: string) => Array} loader - loadSteeringDocs
 * @param {(docs: Array) => string} formatter - formatSteeringForPrompt
 * @returns {{ docs: Array, formatted: string }}
 */
function getCachedSteering(projectDir, loader, formatter) {
  const digest = _steeringDigest(projectDir)
  const cached = _steeringCache.get(projectDir)
  if (cached && cached.digest === digest) {
    _hits++
    _steeringCache.delete(projectDir)
    _steeringCache.set(projectDir, cached)
    return { docs: cached.docs, formatted: cached.formatted }
  }
  _misses++
  const docs = loader(projectDir) || []
  const formatted = formatter(docs) || ''
  _steeringCache.set(projectDir, { digest, docs, formatted })
  while (_steeringCache.size > STEERING_MAX_ENTRIES) {
    const oldest = _steeringCache.keys().next().value
    _steeringCache.delete(oldest)
  }
  return { docs, formatted }
}

function invalidate(projectDir) {
  // Clear any system-prompt entry whose cwd matches
  for (const key of _systemPromptCache.keys()) {
    if (key.endsWith(`|${projectDir}|auto-edit`) || key.endsWith(`|${projectDir}|interactive`)) {
      _systemPromptCache.delete(key)
    } else if (projectDir && key.includes(`|${projectDir}|`)) {
      _systemPromptCache.delete(key)
    }
  }
  _steeringCache.delete(projectDir)
}

function invalidateAll() {
  _systemPromptCache.clear()
  _steeringCache.clear()
}

function stats() {
  const total = _hits + _misses
  return {
    hits: _hits,
    misses: _misses,
    hit_rate: total > 0 ? _hits / total : 0,
    system_prompt_entries: _systemPromptCache.size,
    steering_entries: _steeringCache.size,
  }
}

module.exports = {
  getCachedSystemPrompt,
  getCachedSteering,
  invalidate,
  invalidateAll,
  stats,
}
