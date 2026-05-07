'use strict'

/**
 * Post-Write Read Cache
 * ─────────────────────
 * When the agent writes a file, cache the content keyed by absolute path.
 * If the agent reads the same file within N turns and the file hasn't been
 * modified externally (mtime unchanged), return the cached content instead
 * of re-reading from disk AND re-prefilling the model.
 *
 * Why this helps:
 *   - After write_file/edit_file, the agent often follows up with read_file
 *     to verify the change. This re-read returns the same content the agent
 *     just generated — a complete waste of prefill tokens.
 *   - A cached read returns instantly (no disk I/O) and with a compact
 *     "already in memory" note, saving context bloat.
 *
 * Safety:
 *   - mtime check: if the file changed externally (LSP formatter, bash edit),
 *     cache is invalidated.
 *   - TTL (default 10 turns): old caches are evicted.
 *   - Per-run scope: cleared on run end.
 *
 * Plug point: direct-bridge.js tool executor, between write and next read.
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

class PostWriteCache {
  /**
   * @param {object} opts
   * @param {number} [opts.maxEntries=50]
   * @param {number} [opts.ttlTurns=10]
   */
  constructor(opts = {}) {
    this._maxEntries = opts.maxEntries ?? 50
    this._ttlTurns = opts.ttlTurns ?? 10
    // Map<absPath, { content, mtime, writtenAtTurn, hash }>
    this._cache = new Map()
    this._hits = 0
    this._misses = 0
  }

  /**
   * Record a file write. Call this after write_file / edit_file completes.
   */
  recordWrite(absPath, content, currentTurn) {
    if (!absPath || typeof content !== 'string') return
    let mtime = 0
    try { mtime = fs.statSync(absPath).mtimeMs } catch {}
    const hash = crypto.createHash('sha1').update(content).digest('hex').slice(0, 16)
    this._cache.set(absPath, {
      content,
      mtime,
      writtenAtTurn: currentTurn,
      hash,
    })
    this._evictIfNeeded()
  }

  /**
   * Check if a file can be served from cache. Returns the cached content or null.
   * Invalidates the entry if mtime changed externally.
   */
  tryServe(absPath, currentTurn) {
    if (!absPath) return null
    const entry = this._cache.get(absPath)
    if (!entry) { this._misses++; return null }

    // TTL check
    if (currentTurn - entry.writtenAtTurn > this._ttlTurns) {
      this._cache.delete(absPath)
      this._misses++
      return null
    }

    // External mtime check — if the file was modified by something other than us,
    // the cache is stale. Write_file updates mtime too, but we record it right
    // after, so a match means "we wrote this" or "no one else touched it".
    let currentMtime = 0
    try { currentMtime = fs.statSync(absPath).mtimeMs } catch {
      // File missing → cache miss
      this._cache.delete(absPath)
      this._misses++
      return null
    }
    if (currentMtime !== entry.mtime) {
      // Something else modified the file — content may not match
      this._cache.delete(absPath)
      this._misses++
      return null
    }

    this._hits++
    return {
      content: entry.content,
      hash: entry.hash,
      ageInTurns: currentTurn - entry.writtenAtTurn,
    }
  }

  /**
   * Manually invalidate a path (e.g. after bash may have modified it).
   */
  invalidate(absPath) {
    this._cache.delete(absPath)
  }

  /**
   * Invalidate all entries.
   */
  clear() {
    this._cache.clear()
  }

  /**
   * Evict oldest entries when cache is full.
   */
  _evictIfNeeded() {
    if (this._cache.size <= this._maxEntries) return
    const entries = [...this._cache.entries()].sort((a, b) => a[1].writtenAtTurn - b[1].writtenAtTurn)
    const toRemove = entries.slice(0, entries.length - this._maxEntries)
    for (const [key] of toRemove) this._cache.delete(key)
  }

  stats() {
    const total = this._hits + this._misses
    return {
      hits: this._hits,
      misses: this._misses,
      entries: this._cache.size,
      hit_rate: total > 0 ? this._hits / total : 0,
    }
  }
}

module.exports = { PostWriteCache }
