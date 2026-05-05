'use strict'

/**
 * Claw Compactor bridge — calls claw-compactor Python library from Node.
 * Uses the FusionEngine API to compress context before sending to LLM.
 * Falls back to built-in JS compactor when Python package is unavailable.
 *
 * Rewind store lives here in Node (not in the Python process) so it persists
 * across all bridge invocations for the lifetime of the Electron app.
 * The store is also persisted to disk so rewind keys survive app restarts.
 */
const { execFile } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')
const builtin = require('./compactor-builtin')

const COMPACTOR_SCRIPT = (() => {
  // In packaged app, Python scripts are in extraResources (outside asar)
  if (process.resourcesPath) {
    const packed = path.join(process.resourcesPath, 'compactor-bridge.py')
    try { if (fs.existsSync(packed)) return packed } catch {}
  }
  // Development fallback
  return path.join(__dirname, 'compactor-bridge.py')
})()

// ── Node-side Rewind Store ─────────────────────────────────────────────────
const { REWIND_MAX_ENTRIES, REWIND_TTL_MS } = require('./config')

const _rewindStore = new Map() // key → { original, compressed, storedAt, tokens }

// ── Disk persistence ───────────────────────────────────────────────────────
function _rewindStorePath() {
  return path.join(os.homedir(), '.qwencoder', 'rewind-store.json')
}

function _loadRewindStore() {
  try {
    const p = _rewindStorePath()
    if (!fs.existsSync(p)) return
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'))
    let loaded = 0
    for (const [key, entry] of Object.entries(raw)) {
      _rewindStore.set(key, entry)
      loaded++
    }
    if (loaded > 0) console.log(`[compactor] Loaded ${loaded} rewind entries from disk`)
  } catch (err) {
    console.warn(`[compactor] Failed to load rewind store: ${err.message}`)
  }
}

let _saveTimer = null
function _scheduleRewindSave() {
  // Debounce: write at most once per 2s to avoid hammering disk on rapid compression
  if (_saveTimer) return
  _saveTimer = setTimeout(() => {
    _saveTimer = null
    _persistRewindStore()
  }, 2000)
}

function _persistRewindStore() {
  try {
    const dir = path.join(os.homedir(), '.qwencoder')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const obj = {}
    for (const [key, entry] of _rewindStore.entries()) {
      obj[key] = entry
    }
    fs.writeFileSync(_rewindStorePath(), JSON.stringify(obj), 'utf-8')
  } catch (err) {
    console.warn(`[compactor] Failed to persist rewind store: ${err.message}`)
  }
}

// Load persisted entries on module init
_loadRewindStore()

function rewindStore(original, compressed, originalTokens = 0) {
  // Use short sequential keys (rw_1, rw_2, ...) so the model can remember them
  // across session interrupts. Random hex keys are impossible to recall.
  const seqNum = _rewindStore.size + 1
  const key = 'rw_' + seqNum
  // Evict oldest if at capacity
  if (_rewindStore.size >= REWIND_MAX_ENTRIES) {
    const oldest = _rewindStore.keys().next().value
    _rewindStore.delete(oldest)
  }
  _rewindStore.set(key, { original, compressed, storedAt: Date.now(), originalTokens })
  _scheduleRewindSave()
  return key
}

function rewindRetrieve(key) {
  const entry = _rewindStore.get(key)
  if (!entry) return null
  return entry.original
}

function rewindClear() {
  _rewindStore.clear()
  _persistRewindStore()
}

function rewindSize() {
  return _rewindStore.size
}

// ── Check installed ────────────────────────────────────────────────────────

function checkInstalled(pythonPath = 'python3') {
  return new Promise(resolve => {
    execFile(pythonPath, ['-c', 'from claw_compactor.fusion.engine import FusionEngine; print("ok")'], { timeout: 5000 }, (err) => {
      if (err) {
        execFile(pythonPath, ['-c', 'from claw_compactor import FusionEngine; print("ok")'], { timeout: 5000 }, (err2) => {
          resolve(!err2)
        })
      } else {
        resolve(true)
      }
    })
  })
}

// ── Compress messages ──────────────────────────────────────────────────────

function compressMessages(pythonPath, messages, options = {}) {
  return new Promise((resolve) => {
    const input = JSON.stringify({ messages, options })
    const child = execFile(pythonPath, [COMPACTOR_SCRIPT, 'compress-messages'], {
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    }, (err, stdout) => {
      if (err) {
        const fallback = builtin.compressMessages(messages, options)
        fallback.stats = { ...fallback.stats, engine: 'builtin' }
        return resolve(fallback)
      }
      try {
        const result = JSON.parse(stdout)
        if (result.stats?.compressed) {
          result.stats.engine = 'python'
          // Store originals in Node-side rewind store for any compressed messages
          const rewindKeys = []
          if (result.messages && messages.length === result.messages.length) {
            for (let i = 0; i < messages.length; i++) {
              const origContent = typeof messages[i].content === 'string' ? messages[i].content : JSON.stringify(messages[i].content)
              const compContent = typeof result.messages[i].content === 'string' ? result.messages[i].content : JSON.stringify(result.messages[i].content)
              if (origContent !== compContent && origContent.length > 200) {
                const key = rewindStore(origContent, compContent, result.stats?.per_message?.[i]?.original_tokens || 0)
                rewindKeys.push(key)
              }
            }
          }
          if (rewindKeys.length) result.stats.rewind_keys = rewindKeys
          return resolve(result)
        }
        const fallback = builtin.compressMessages(messages, options)
        fallback.stats = { ...fallback.stats, engine: 'builtin' }
        resolve(fallback)
      } catch {
        const fallback = builtin.compressMessages(messages, options)
        fallback.stats = { ...fallback.stats, engine: 'builtin' }
        resolve(fallback)
      }
    })
    child.stdin.write(input)
    child.stdin.end()
  })
}

// ── Compress text ──────────────────────────────────────────────────────────

function compressText(pythonPath, text, contentType = 'auto', options = {}) {
  return new Promise((resolve) => {
    const input = JSON.stringify({ text, content_type: contentType, ...options })
    const child = execFile(pythonPath, [COMPACTOR_SCRIPT, 'compress-text'], {
      timeout: 15000,
      maxBuffer: 5 * 1024 * 1024,
    }, (err, stdout) => {
      if (err) {
        const fallback = builtin.compressText(text, contentType, options)
        fallback.stats = { ...fallback.stats, engine: 'builtin' }
        return resolve(fallback)
      }
      try {
        const result = JSON.parse(stdout)
        if (result.stats?.compressed) {
          result.stats.engine = 'python'
          // Store original in Node-side rewind store
          const compressed = result.compressed || result.text || text
          if (result.stats.reduction_pct > 10 && text.length > 200) {
            const key = rewindStore(text, compressed, result.stats.original_tokens || 0)
            result.rewind_key = key
            result.stats.rewind_key = key
          }
          return resolve(result)
        }
        const fallback = builtin.compressText(text, contentType, options)
        fallback.stats = { ...fallback.stats, engine: 'builtin' }
        resolve(fallback)
      } catch {
        const fallback = builtin.compressText(text, contentType, options)
        fallback.stats = { ...fallback.stats, engine: 'builtin' }
        resolve(fallback)
      }
    })
    child.stdin.write(input)
    child.stdin.end()
  })
}

// ── Rewind ─────────────────────────────────────────────────────────────────

/**
 * Retrieve original uncompressed content by rewind key.
 * Now uses the Node-side store (no Python call needed).
 */
function rewind(_pythonPath, key) {
  const content = rewindRetrieve(key)
  if (content !== null) {
    return Promise.resolve({ found: true, content })
  }
  return Promise.resolve({ found: false, error: 'Content no longer available (expired or evicted)' })
}

// ── Status ─────────────────────────────────────────────────────────────────

function getStatus(pythonPath) {
  return new Promise(resolve => {
    execFile(pythonPath, [COMPACTOR_SCRIPT, 'status'], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve({ installed: true, version: 'built-in', engine: 'builtin', rewind_enabled: true, rewind_entries: rewindSize() })
      try {
        const result = JSON.parse(stdout)
        if (result.installed) return resolve({ ...result, engine: 'python', rewind_enabled: true, rewind_entries: rewindSize() })
        resolve({ installed: true, version: 'built-in', engine: 'builtin', rewind_enabled: true, rewind_entries: rewindSize() })
      } catch { resolve({ installed: true, version: 'built-in', engine: 'builtin', rewind_enabled: true, rewind_entries: rewindSize() }) }
    })
  })
}

module.exports = { compressMessages, compressText, rewind, getStatus, checkInstalled, rewindClear, rewindSize }
