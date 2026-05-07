'use strict'

/**
 * Cascade Router
 * ──────────────
 * Routes agent dispatches through a cascade of model sizes, escalating only
 * when the smaller model's response is ambiguous.
 *
 * Cascade tiers (defaults):
 *   tier 0: fast  (0.8B) — simple dispatch, classification, read-then-act
 *   tier 1: mid   (4B)   — moderate reasoning
 *   tier 2: primary (35B) — full reasoning
 *
 * Escalation triggers (in order):
 *   1. Response contains no tool_call AND no task_complete → escalate
 *   2. Response confidence below threshold → escalate
 *      (confidence = logprob gap between top-1 and top-2 on first N tokens)
 *   3. Response is text-only reflection / planning → escalate
 *   4. Role-specific policy (e.g. implementation always goes to primary)
 *
 * Plug point: agent-pool.js dispatch(). Before creating the agent, consult
 * the router for which model to use. The router wraps the regular agentFactory.
 *
 * Opt-in per-role: roles marked 'cascade: true' (e.g. code-search, explore,
 * context-gather) use the cascade. implementation/debug skip straight to
 * primary.
 */

const CASCADE_POLICY = {
  // Simple lookup/dispatch tasks — almost always answerable by fast model
  'code-search': { allowed: true, min_tier: 0, max_tier: 2 },
  'context-gather': { allowed: true, min_tier: 0, max_tier: 2 },
  'explore': { allowed: true, min_tier: 1, max_tier: 2 },

  // Structured generation — mid tier often sufficient
  'requirements': { allowed: true, min_tier: 1, max_tier: 2 },
  'design': { allowed: true, min_tier: 1, max_tier: 2 },

  // Complex reasoning — primary only
  'implementation': { allowed: false, min_tier: 2, max_tier: 2 },
  'debug': { allowed: false, min_tier: 2, max_tier: 2 },
  'tester': { allowed: false, min_tier: 2, max_tier: 2 },
  'general': { allowed: true, min_tier: 0, max_tier: 2 },
}

// Default confidence threshold — response is "confident" if the gap between
// top-1 and top-2 token logprobs on the first few tokens averages above this.
const DEFAULT_CONFIDENCE_THRESHOLD = 2.0 // natural log units; ~7x probability ratio

class CascadeRouter {
  /**
   * @param {object} opts
   * @param {object} opts.tiers - { 0: fastModel, 1: midModel, 2: primaryModel }
   * @param {object} [opts.policy] - override CASCADE_POLICY
   * @param {number} [opts.confidenceThreshold] - logprob gap required
   * @param {function} [opts.onEscalate] - notified when tier escalates
   */
  constructor(opts = {}) {
    this._tiers = opts.tiers || {}
    this._policy = { ...CASCADE_POLICY, ...(opts.policy || {}) }
    this._confidence = opts.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD
    this._onEscalate = opts.onEscalate || (() => {})
    this._stats = {
      dispatches: 0,
      tier_0_committed: 0,
      tier_1_committed: 0,
      tier_2_committed: 0,
      escalations: 0,
    }
  }

  /**
   * Decide which tier to start at for a given agent role.
   */
  startTier(role) {
    const p = this._policy[role]
    if (!p || !p.allowed) return 2
    return p.min_tier
  }

  /**
   * Decide whether to commit the current tier's response or escalate.
   *
   * @param {object} response - { content, tool_calls, finish_reason, logprobs }
   * @param {string} role
   * @param {number} currentTier
   * @returns {{ commit: boolean, reason: string, next_tier?: number }}
   */
  evaluate(response, role, currentTier) {
    const policy = this._policy[role]
    if (!policy || !policy.allowed) {
      return { commit: true, reason: 'cascade-disabled' }
    }

    // Already at max tier — must commit
    if (currentTier >= policy.max_tier) {
      return { commit: true, reason: 'max-tier-reached' }
    }

    // Reason 1: Response contains a tool_call — commit. Tool calls are
    // structured actions; if the small model produced a valid one, use it.
    if (Array.isArray(response.tool_calls) && response.tool_calls.length > 0) {
      // But: require that it's a safe/simple tool when coming from tier 0
      if (currentTier === 0 && !this._isSimpleToolCall(response.tool_calls)) {
        return this._escalate(currentTier, policy, 'complex-tool-call-at-tier-0')
      }
      return { commit: true, reason: 'tool-call-present' }
    }

    // Reason 2: Empty or garbage response — escalate
    if (!response.content && !response.tool_calls) {
      return this._escalate(currentTier, policy, 'empty-response')
    }

    // Reason 3: Action-requiring role produced text-only output — escalate.
    // Action roles must act (tool_calls); narration alone isn't useful.
    // This check comes BEFORE the stop-with-content check so that an
    // action role can't commit on pure text.
    if (this._isActionRole(role) && !response.tool_calls) {
      return this._escalate(currentTier, policy, 'no-action-in-action-role')
    }

    // Reason 4: Explicit completion with content — commit (for non-action roles)
    if (response.finish_reason === 'stop' && response.content) {
      // Check confidence if we have logprobs
      if (response.logprobs && !this._isConfident(response.logprobs)) {
        return this._escalate(currentTier, policy, 'low-confidence')
      }
      return { commit: true, reason: 'stop-with-content' }
    }

    return { commit: true, reason: 'default-commit' }
  }

  _isSimpleToolCall(toolCalls) {
    // Simple = read-only, structured dispatch tools. Tier 0 can handle these.
    const SIMPLE = new Set([
      'read_file', 'read_files', 'list_dir', 'search_files',
      'ast_search', 'lsp_get_document_symbols', 'lsp_get_hover',
      'lsp_get_definition', 'lsp_get_references',
      'update_todos', 'edit_todos', 'task_complete',
    ])
    return toolCalls.every(tc => SIMPLE.has(tc.function?.name))
  }

  _isActionRole(role) {
    return ['implementation', 'debug', 'tester', 'code-search', 'context-gather'].includes(role)
  }

  _isConfident(logprobs) {
    if (!logprobs?.content || !Array.isArray(logprobs.content)) return true
    const first = logprobs.content.slice(0, 5)
    if (first.length === 0) return true
    let totalGap = 0
    let count = 0
    for (const tok of first) {
      if (!tok.top_logprobs || tok.top_logprobs.length < 2) continue
      const gap = tok.top_logprobs[0].logprob - tok.top_logprobs[1].logprob
      totalGap += gap
      count++
    }
    if (count === 0) return true
    return (totalGap / count) >= this._confidence
  }

  _escalate(currentTier, policy, reason) {
    const next = Math.min(currentTier + 1, policy.max_tier)
    if (next === currentTier) {
      return { commit: true, reason: `${reason}-but-at-max` }
    }
    this._stats.escalations++
    this._onEscalate({ from: currentTier, to: next, reason })
    return { commit: false, reason, next_tier: next }
  }

  /**
   * Get the model config for a tier.
   */
  getTierModel(tier) {
    return this._tiers[tier] || this._tiers[2] || null
  }

  /**
   * Record a commit at a tier — updates stats.
   */
  recordCommit(tier) {
    this._stats.dispatches++
    const key = `tier_${tier}_committed`
    if (key in this._stats) this._stats[key]++
  }

  stats() {
    const total = this._stats.dispatches || 1
    return {
      ...this._stats,
      tier_0_ratio: this._stats.tier_0_committed / total,
      tier_1_ratio: this._stats.tier_1_committed / total,
      tier_2_ratio: this._stats.tier_2_committed / total,
      escalation_ratio: this._stats.escalations / total,
    }
  }
}

module.exports = { CascadeRouter, CASCADE_POLICY }
