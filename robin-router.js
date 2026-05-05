'use strict'

/**
 * Robin Router — intelligent free-model routing for OpenRouter.
 *
 * Inspired by RobinLLM (github.com/akumaburn/RobinLLM), this module:
 * 1. Discovers free models on OpenRouter via their API
 * 2. Tracks performance metrics (latency, success rate, errors)
 * 3. Routes requests to the best-performing free model
 * 4. Provides circuit breaker + failover for reliability
 *
 * Used by the orchestrator to dispatch concurrent subagent requests
 * across multiple free models without bottlenecking on local MLX.
 */

const https = require('https')
const { EventEmitter } = require('node:events')

// ── Constants ─────────────────────────────────────────────────────────────────

const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1'
const MODEL_LIST_URL = `${OPENROUTER_API_BASE}/models`
const CHAT_URL = `${OPENROUTER_API_BASE}/chat/completions`

// Scoring weights (same as RobinLLM defaults)
const WEIGHT_LATENCY = 0.6
const WEIGHT_SUCCESS = 0.3
const WEIGHT_RATE_LIMIT = 0.1

// Circuit breaker settings
const CIRCUIT_BREAKER_THRESHOLD = 0.5  // 50% failure rate trips the breaker
const CIRCUIT_BREAKER_COOLDOWN = 60000 // 60s before retrying a tripped model
const MIN_REQUESTS_FOR_SCORE = 3       // Need at least 3 requests to score

// Discovery interval: refresh free model list every 30 minutes
const DISCOVERY_INTERVAL = 30 * 60 * 1000

// Max models to keep in the active pool
const MAX_POOL_SIZE = 15

// ── Model Metrics ─────────────────────────────────────────────────────────────

class ModelMetrics {
  constructor(id) {
    this.id = id
    this.totalRequests = 0
    this.successes = 0
    this.failures = 0
    this.totalLatency = 0
    this.lastLatency = 0
    this.lastUsed = 0
    this.circuitOpen = false
    this.circuitOpenedAt = 0
  }

  get avgLatency() {
    return this.totalRequests > 0 ? this.totalLatency / this.totalRequests : Infinity
  }

  get successRate() {
    return this.totalRequests > 0 ? this.successes / this.totalRequests : 0
  }

  get failureRate() {
    return this.totalRequests > 0 ? this.failures / this.totalRequests : 0
  }

  recordSuccess(latencyMs) {
    this.totalRequests++
    this.successes++
    this.totalLatency += latencyMs
    this.lastLatency = latencyMs
    this.lastUsed = Date.now()
    // Close circuit on success
    if (this.circuitOpen) this.circuitOpen = false
  }

  recordFailure() {
    this.totalRequests++
    this.failures++
    this.lastUsed = Date.now()
    // Trip circuit breaker if failure rate exceeds threshold
    if (this.totalRequests >= MIN_REQUESTS_FOR_SCORE && this.failureRate >= CIRCUIT_BREAKER_THRESHOLD) {
      this.circuitOpen = true
      this.circuitOpenedAt = Date.now()
    }
  }

  isAvailable() {
    if (!this.circuitOpen) return true
    // Allow retry after cooldown
    if (Date.now() - this.circuitOpenedAt > CIRCUIT_BREAKER_COOLDOWN) {
      this.circuitOpen = false
      return true
    }
    return false
  }

  /**
   * Compute a score (higher = better). Normalized 0–1.
   */
  score(fastestLatency) {
    if (this.totalRequests < MIN_REQUESTS_FOR_SCORE) return 0.5 // neutral for untested
    const latencyScore = fastestLatency > 0 ? Math.min(1, fastestLatency / this.avgLatency) : 0.5
    const successScore = this.successRate
    // Rate limit proximity: penalize models used very recently (< 2s ago)
    const timeSinceUse = Date.now() - this.lastUsed
    const rateLimitScore = Math.min(1, timeSinceUse / 2000)
    return (WEIGHT_LATENCY * latencyScore) + (WEIGHT_SUCCESS * successScore) + (WEIGHT_RATE_LIMIT * rateLimitScore)
  }
}

// ── Robin Router ──────────────────────────────────────────────────────────────

class RobinRouter extends EventEmitter {
  constructor() {
    super()
    this._apiKey = null
    this._models = new Map()       // modelId → { id, name, contextLength, pricing }
    this._metrics = new Map()      // modelId → ModelMetrics
    this._discoveryTimer = null
    this._enabled = false
    this._lastDiscovery = 0
    this._roundRobinIdx = 0
  }

  /**
   * Initialize the router with an API key and start discovery.
   * @param {string} apiKey - OpenRouter API key
   */
  async start(apiKey) {
    if (!apiKey) return
    this._apiKey = apiKey
    this._enabled = true
    await this._discoverFreeModels()
    this._discoveryTimer = setInterval(() => this._discoverFreeModels(), DISCOVERY_INTERVAL)
  }

  stop() {
    this._enabled = false
    if (this._discoveryTimer) {
      clearInterval(this._discoveryTimer)
      this._discoveryTimer = null
    }
  }

  get enabled() { return this._enabled && this._models.size > 0 }
  get modelCount() { return this._models.size }

  /**
   * Get the list of available free models with their scores.
   * @returns {Array<{id, name, score, metrics}>}
   */
  getModels() {
    const fastestLatency = this._getFastestLatency()
    const result = []
    for (const [id, model] of this._models) {
      const metrics = this._metrics.get(id) || new ModelMetrics(id)
      result.push({
        id,
        name: model.name || id,
        contextLength: model.contextLength,
        score: metrics.score(fastestLatency),
        available: metrics.isAvailable(),
        avgLatency: metrics.avgLatency === Infinity ? null : Math.round(metrics.avgLatency),
        successRate: metrics.successRate,
        totalRequests: metrics.totalRequests,
      })
    }
    return result.sort((a, b) => b.score - a.score)
  }

  /**
   * Select the best model for a request. Uses weighted scoring with
   * round-robin among top performers to distribute load.
   * @returns {string|null} model ID or null if none available
   */
  selectModel() {
    if (!this._enabled || this._models.size === 0) return null

    const ranked = this.getModels().filter(m => m.available)
    if (ranked.length === 0) return null

    // Pick from top 3 using round-robin for load distribution
    const topN = ranked.slice(0, Math.min(3, ranked.length))
    const idx = this._roundRobinIdx % topN.length
    this._roundRobinIdx++
    return topN[idx].id
  }

  /**
   * Record a successful request for a model.
   * @param {string} modelId
   * @param {number} latencyMs
   */
  recordSuccess(modelId, latencyMs) {
    if (!this._metrics.has(modelId)) this._metrics.set(modelId, new ModelMetrics(modelId))
    this._metrics.get(modelId).recordSuccess(latencyMs)
    this.emit('metrics-update', { modelId, event: 'success', latencyMs })
  }

  /**
   * Record a failed request for a model.
   * @param {string} modelId
   */
  recordFailure(modelId) {
    if (!this._metrics.has(modelId)) this._metrics.set(modelId, new ModelMetrics(modelId))
    this._metrics.get(modelId).recordFailure()
    this.emit('metrics-update', { modelId, event: 'failure' })
  }

  /**
   * Get stats summary for UI display.
   */
  getStats() {
    const models = this.getModels()
    const totalReqs = models.reduce((sum, m) => sum + m.totalRequests, 0)
    const avgSuccess = models.length > 0
      ? models.reduce((sum, m) => sum + m.successRate, 0) / models.length
      : 0
    return {
      totalModels: this._models.size,
      availableModels: models.filter(m => m.available).length,
      totalRequests: totalReqs,
      avgSuccessRate: Math.round(avgSuccess * 100),
      topModel: models[0]?.id || null,
    }
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  _getFastestLatency() {
    let fastest = Infinity
    for (const m of this._metrics.values()) {
      if (m.totalRequests >= MIN_REQUESTS_FOR_SCORE && m.avgLatency < fastest) {
        fastest = m.avgLatency
      }
    }
    return fastest === Infinity ? 1000 : fastest
  }

  /**
   * Fetch the model list from OpenRouter and filter for free models.
   */
  async _discoverFreeModels() {
    try {
      const data = await this._fetchJSON(MODEL_LIST_URL)
      if (!data || !data.data) return

      let freeModels = data.data.filter(m => {
        // Free models have pricing.prompt === "0" and pricing.completion === "0"
        const p = m.pricing || {}
        return p.prompt === '0' && p.completion === '0'
      })

      // Sort by context length (prefer larger context)
      freeModels.sort((a, b) => (b.context_length || 0) - (a.context_length || 0))

      // Cap pool size
      freeModels = freeModels.slice(0, MAX_POOL_SIZE)

      // Update model map (preserve existing metrics)
      const newMap = new Map()
      for (const m of freeModels) {
        newMap.set(m.id, {
          id: m.id,
          name: m.name || m.id,
          contextLength: m.context_length || 4096,
          pricing: m.pricing,
        })
        // Initialize metrics if new
        if (!this._metrics.has(m.id)) {
          this._metrics.set(m.id, new ModelMetrics(m.id))
        }
      }
      this._models = newMap

      // Prune metrics for models no longer in pool
      for (const id of this._metrics.keys()) {
        if (!this._models.has(id)) this._metrics.delete(id)
      }

      this._lastDiscovery = Date.now()
      this.emit('discovery', { count: this._models.size })
    } catch (err) {
      this.emit('error', { phase: 'discovery', error: err.message })
    }
  }

  /**
   * Simple HTTPS GET that returns parsed JSON.
   */
  _fetchJSON(url) {
    return new Promise((resolve, reject) => {
      const headers = { 'Accept': 'application/json' }
      if (this._apiKey) headers['Authorization'] = `Bearer ${this._apiKey}`

      const req = https.get(url, { headers, timeout: 15000 }, (res) => {
        if (res.statusCode >= 400) {
          let body = ''
          res.on('data', c => { body += c })
          res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`)))
          return
        }
        let body = ''
        res.on('data', c => { body += c })
        res.on('end', () => {
          try { resolve(JSON.parse(body)) }
          catch (e) { reject(e) }
        })
      })
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')) })
    })
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────
const robinRouter = new RobinRouter()

module.exports = { RobinRouter, robinRouter }
