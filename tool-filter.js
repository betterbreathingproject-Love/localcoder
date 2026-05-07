'use strict'

/**
 * Tool Filter — Semantic Pre-Filtering for Tool Definitions
 * ────────────────────────────────────────────────────────
 * Reduces the 28-tool baseline (~7.4K tokens) down to the most relevant ~10-12
 * tools (~3K tokens) per request, saving ~4K tokens of prefill every turn.
 *
 * How it works:
 *   1. On first use, precompute embeddings for every tool description. Cached in memory.
 *   2. On each call, embed the current user prompt + recent context.
 *   3. Compute cosine similarity between prompt embedding and tool embeddings.
 *   4. Return top-K most relevant tools, merged with an "always include" set.
 *
 * Uses the existing memory-bridge /memory/embed endpoint (ONNX MiniLM,
 * ~0.3ms per embed on CPU). Zero new dependencies.
 *
 * Design principles:
 *   - Safety-first: always-include set protects critical tools (task_complete,
 *     write_file, bash, etc.) from being filtered out even if semantically
 *     unrelated to the prompt.
 *   - Graceful degradation: if the embed endpoint is down or slow, returns
 *     the full unfiltered tool list (same as today).
 *   - Persistent cache: tool embeddings cached to disk so restarts don't pay
 *     the ~140ms precompute cost again.
 */

const http = require('node:http')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const DEFAULT_ENDPOINT = 'http://127.0.0.1:8090/memory/embed'
const DEFAULT_TIMEOUT_MS = 2500
const DEFAULT_TOP_K = 12
const DEFAULT_MIN_SCORE = 0.1  // below this similarity, tool is probably irrelevant

// Tools that should ALWAYS be available regardless of semantic match.
// These are task-completion primitives — without them, agents can't finish work.
const DEFAULT_ALWAYS_INCLUDE = new Set([
  'task_complete',
  'update_todos',
  'edit_todos',
  'read_file',
  'write_file',
  'edit_file',
  'bash',
  'list_dir',
  'agent_notes',
  'ask_user',
])

// Cache location — mirrors the disk prefix-cache location
const CACHE_DIR = path.join(os.homedir(), '.qwencoder', 'tool-filter-cache')

/**
 * Build a short, semantic-friendly string for a tool. Keeps name + description,
 * strips long JSON schemas that pollute the embedding.
 */
function toolSemanticText(tool) {
  const fn = tool.function || {}
  const name = fn.name || 'unknown'
  const desc = fn.description || ''
  // Include the first-line parameter hints so e.g. "read_file" carries the
  // notion of "path" in its embedding.
  const paramHints = []
  if (fn.parameters?.properties) {
    for (const key of Object.keys(fn.parameters.properties).slice(0, 4)) {
      paramHints.push(key)
    }
  }
  return `${name}: ${desc.slice(0, 300)}${paramHints.length ? ` (params: ${paramHints.join(', ')})` : ''}`
}

/**
 * Stable hash for a tool's semantic text — used as cache key.
 */
function toolHash(tool) {
  return crypto.createHash('sha1').update(toolSemanticText(tool)).digest('hex').slice(0, 16)
}

/**
 * Cosine similarity between two vectors of equal length.
 */
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom > 0 ? dot / denom : 0
}

/**
 * POST text to the embed endpoint, return vector or null on failure.
 */
function fetchEmbedding(text, endpoint = DEFAULT_ENDPOINT, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ text })
    const url = new URL(endpoint)
    const req = http.request({
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString())
          if (Array.isArray(data.embedding) && data.embedding.length > 0) {
            resolve(data.embedding)
          } else {
            resolve(null)
          }
        } catch {
          resolve(null)
        }
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { try { req.destroy() } catch {}; resolve(null) })
    req.write(body)
    req.end()
  })
}

class ToolFilter {
  /**
   * @param {object} opts
   * @param {string} [opts.endpoint] - embedding endpoint
   * @param {number} [opts.timeoutMs] - per-request timeout
   * @param {number} [opts.topK] - max semantically-selected tools
   * @param {number} [opts.minScore] - minimum cosine similarity
   * @param {Set<string>} [opts.alwaysInclude] - tool names to always include
   * @param {boolean} [opts.persistCache] - save tool embeddings to disk
   */
  constructor(opts = {}) {
    this._endpoint = opts.endpoint || DEFAULT_ENDPOINT
    this._timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this._topK = opts.topK ?? DEFAULT_TOP_K
    this._minScore = opts.minScore ?? DEFAULT_MIN_SCORE
    this._alwaysInclude = new Set(opts.alwaysInclude || DEFAULT_ALWAYS_INCLUDE)
    this._persistCache = opts.persistCache !== false
    this._cacheDir = opts.cacheDir || CACHE_DIR

    // Map<toolHash, embedding>
    this._toolEmbeddings = new Map()
    // Map<promptHash, embedding>
    this._promptEmbeddings = new Map()
    this._promptCacheCap = 50

    // Stats
    this._stats = {
      toolEmbedsComputed: 0,
      toolEmbedsFromCache: 0,
      promptEmbeds: 0,
      promptCacheHits: 0,
      filterCalls: 0,
      filterFallbacks: 0,
      tokensSavedEst: 0,
    }

    if (this._persistCache) {
      try { fs.mkdirSync(this._cacheDir, { recursive: true }) } catch {}
      this._loadDiskCache()
    }
  }

  _diskCachePath() {
    return path.join(this._cacheDir, 'tool-embeddings.json')
  }

  _loadDiskCache() {
    try {
      const p = this._diskCachePath()
      if (!fs.existsSync(p)) return
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8'))
      for (const [hash, emb] of Object.entries(raw)) {
        if (Array.isArray(emb)) this._toolEmbeddings.set(hash, emb)
      }
    } catch (_) { /* corrupt cache — ignore */ }
  }

  _saveDiskCache() {
    if (!this._persistCache) return
    try {
      const obj = {}
      for (const [hash, emb] of this._toolEmbeddings) obj[hash] = emb
      fs.writeFileSync(this._diskCachePath(), JSON.stringify(obj), 'utf-8')
    } catch (_) { /* non-fatal */ }
  }

  /**
   * Ensure embeddings exist for all tools. Returns the number newly computed.
   */
  async _ensureToolEmbeddings(tools) {
    let computed = 0
    const pending = []
    for (const tool of tools) {
      const hash = toolHash(tool)
      if (!this._toolEmbeddings.has(hash)) {
        pending.push({ tool, hash })
      } else {
        this._stats.toolEmbedsFromCache++
      }
    }
    // Parallel embed up to 8 at a time
    for (let i = 0; i < pending.length; i += 8) {
      const batch = pending.slice(i, i + 8)
      const results = await Promise.all(batch.map(({ tool }) =>
        fetchEmbedding(toolSemanticText(tool), this._endpoint, this._timeout)
      ))
      for (let j = 0; j < batch.length; j++) {
        if (results[j]) {
          this._toolEmbeddings.set(batch[j].hash, results[j])
          computed++
          this._stats.toolEmbedsComputed++
        }
      }
    }
    if (computed > 0) this._saveDiskCache()
    return computed
  }

  /**
   * Embed the prompt context. Caches recent prompts for reuse.
   */
  async _embedPrompt(contextText) {
    const hash = crypto.createHash('sha1').update(contextText).digest('hex').slice(0, 16)
    if (this._promptEmbeddings.has(hash)) {
      this._stats.promptCacheHits++
      return this._promptEmbeddings.get(hash)
    }
    const emb = await fetchEmbedding(contextText, this._endpoint, this._timeout)
    if (emb) {
      if (this._promptEmbeddings.size >= this._promptCacheCap) {
        const firstKey = this._promptEmbeddings.keys().next().value
        this._promptEmbeddings.delete(firstKey)
      }
      this._promptEmbeddings.set(hash, emb)
      this._stats.promptEmbeds++
    }
    return emb
  }

  /**
   * Filter a list of tools down to the most relevant for the given prompt context.
   *
   * @param {object[]} tools - full tool list (OpenAI-style tool defs)
   * @param {string} contextText - user prompt + recent conversation excerpt
   * @returns {Promise<{tools, metrics}>}
   */
  async filter(tools, contextText) {
    this._stats.filterCalls++
    const t0 = Date.now()

    if (!Array.isArray(tools) || tools.length === 0) {
      return { tools: [], metrics: { fallback: true, reason: 'no-tools' } }
    }
    // If there are fewer tools than topK + alwaysInclude, no filtering needed
    if (tools.length <= this._topK) {
      return { tools, metrics: { fallback: true, reason: 'under-topK', elapsedMs: Date.now() - t0 } }
    }

    if (!contextText || contextText.length < 5) {
      this._stats.filterFallbacks++
      return { tools, metrics: { fallback: true, reason: 'empty-context', elapsedMs: Date.now() - t0 } }
    }

    // Ensure tool embeddings are computed
    try {
      await this._ensureToolEmbeddings(tools)
    } catch (_) {
      this._stats.filterFallbacks++
      return { tools, metrics: { fallback: true, reason: 'tool-embed-failed', elapsedMs: Date.now() - t0 } }
    }

    // Embed the prompt
    const promptEmb = await this._embedPrompt(contextText)
    if (!promptEmb) {
      this._stats.filterFallbacks++
      return { tools, metrics: { fallback: true, reason: 'prompt-embed-failed', elapsedMs: Date.now() - t0 } }
    }

    // Score each tool
    const scored = []
    for (const tool of tools) {
      const name = tool.function?.name
      const hash = toolHash(tool)
      const emb = this._toolEmbeddings.get(hash)
      const score = emb ? cosine(promptEmb, emb) : 0
      const isAlways = this._alwaysInclude.has(name)
      scored.push({ tool, name, score, isAlways })
    }

    // Split into always-include and semantic candidates
    const always = scored.filter(s => s.isAlways).map(s => s.tool)
    const semantic = scored
      .filter(s => !s.isAlways)
      .sort((a, b) => b.score - a.score)

    // Pick top-K semantic tools that meet min score
    const picked = []
    for (const s of semantic) {
      if (picked.length >= this._topK - always.length) break
      if (s.score < this._minScore) break
      picked.push(s.tool)
    }

    const filtered = [...always, ...picked]
    const elapsed = Date.now() - t0

    // Estimate tokens saved (very rough — 4 chars/token)
    const before = tools.reduce((sum, t) => sum + JSON.stringify(t).length, 0)
    const after = filtered.reduce((sum, t) => sum + JSON.stringify(t).length, 0)
    const tokensSaved = Math.max(0, Math.floor((before - after) / 4))
    this._stats.tokensSavedEst += tokensSaved

    return {
      tools: filtered,
      metrics: {
        elapsedMs: elapsed,
        original: tools.length,
        kept: filtered.length,
        alwaysKept: always.length,
        semanticKept: picked.length,
        topScore: semantic[0]?.score || 0,
        tokensSaved,
      },
    }
  }

  stats() {
    return {
      ...this._stats,
      toolEmbeddingsCached: this._toolEmbeddings.size,
      promptCacheSize: this._promptEmbeddings.size,
    }
  }

  /**
   * Clear in-memory prompt cache (not tool embeddings).
   */
  clearPromptCache() {
    this._promptEmbeddings.clear()
  }

  /**
   * Nuke everything (useful for tests).
   */
  clear() {
    this._toolEmbeddings.clear()
    this._promptEmbeddings.clear()
  }
}

module.exports = { ToolFilter, toolSemanticText, cosine, DEFAULT_ALWAYS_INCLUDE }
