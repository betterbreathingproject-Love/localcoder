'use strict'

/**
 * Central configuration for context window and token budgets.
 * Single source of truth — change values here and everything adjusts.
 *
 * To override at runtime, set environment variables:
 *   CTX_WINDOW=131072 npm start
 */

const CONTEXT_WINDOW = parseInt(process.env.CTX_WINDOW, 10) || 131072
const MAX_OUTPUT_TOKENS = parseInt(process.env.MAX_OUTPUT_TOKENS, 10) || 32768

// ── Default model paths ───────────────────────────────────────────────────────
// Primary: Qwen3.6 35B A3B 8bit — the main intelligent agent model
// Fast:    Qwen3.5 0.8B 8bit    — extraction model for fast-assist tasks
const MODELS_DIR = process.env.MODELS_DIR || (require('os').homedir() + '/.lmstudio/models')
const DEFAULT_PRIMARY_MODEL = process.env.PRIMARY_MODEL ||
  MODELS_DIR + '/unsloth/Qwen3.6-35B-A3B-MLX-8bit'
const DEFAULT_FAST_MODEL = process.env.FAST_MODEL ||
  MODELS_DIR + '/mlx-community/Qwen3.5-0.8B-MLX-8bit'

module.exports = {
  // Total context budget in tokens
  CONTEXT_WINDOW,

  // Max generation/output tokens
  MAX_OUTPUT_TOKENS,

  // Prompt budget = 90% of context window (leaves room for output + overhead)
  PROMPT_LIMIT: Math.floor(CONTEXT_WINDOW * 0.9),

  // Client-side input token budget (slightly below prompt limit for safety)
  MAX_INPUT_TOKENS: Math.floor(CONTEXT_WINDOW * 0.85),

  // Compaction triggers at 60% of context window.
  // The rendered Jinja prompt includes tool schemas (~10-15k tokens of JSON)
  // that estimateMessagesTokens() doesn't count — so the effective prompt is
  // significantly larger than the raw message estimate. 60% of 84k = ~50.4k
  // tokens of message content, which gives the agent enough room to hold
  // 3-4 source files plus conversation before compaction kicks in.
  COMPACTION_THRESHOLD: Math.floor(CONTEXT_WINDOW * 0.60),

  // Pre-send guard: hard cap before sending to server
  PRE_SEND_LIMIT: Math.floor(CONTEXT_WINDOW * 0.88),

  // Tool output truncation limits (chars)
  READ_FILE_TRUNCATE: Math.floor(CONTEXT_WINDOW * 4 * 0.35),  // ~183K chars — 35% of context budget in chars
  TOOL_OUTPUT_TRUNCATE: Math.floor(CONTEXT_WINDOW * 4 * 0.10), // ~52K chars — 10% of context budget in chars

  // Calibrator floor — memory pressure can reduce budget but never below this
  CALIBRATOR_FLOOR: Math.floor(CONTEXT_WINDOW * 0.4),

  // Rewind store settings
  REWIND_MAX_ENTRIES: 1000,
  REWIND_TTL_MS: Infinity, // persist forever — file size is small

  // Default model paths
  DEFAULT_PRIMARY_MODEL,
  DEFAULT_FAST_MODEL,
}
