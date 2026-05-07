'use strict'

/**
 * Tool Result Shrinker
 * ────────────────────
 * Every turn, walk through the message history and compress older tool
 * results that are still in their verbose form. Keeps the most-recent-N
 * tool results at full fidelity; older ones get replaced with a compact
 * receipt that preserves the agent's awareness the call happened but
 * strips the bulk content.
 *
 * Why this is different from your existing compactor:
 *   - Compactor triggers at 55-75% of context window (crisis response)
 *   - This runs every turn, eagerly shrinking older results (prevention)
 *   - Uses the rewind store so the agent can always recover the full
 *     original via rewind_context({"key": "rw_XXX"}) if needed
 *
 * Safety:
 *   - Protects recent N tool results (default 6) at full fidelity
 *   - Protects small tool results (under 2000 chars) — no gain from shrinking
 *   - Only shrinks messages that include a "── file (N lines) ──" header
 *     or very long text content — i.e. things that would benefit
 *   - Emits a rewind-retrievable notice in place of the content
 */

/**
 * Walk messages and shrink older tool results that haven't been
 * shrunk already.
 *
 * @param {Array} messages - mutated in place
 * @param {object} compactor - the compactor module (for rewindStore)
 * @param {object} opts
 * @param {number} opts.keepRecentN - keep the last N tool results intact
 * @param {number} opts.minShrinkChars - don't shrink messages smaller than this
 * @param {function} opts.log - optional logger
 * @returns {{ shrunk: number, tokensSaved: number }}
 */
function shrinkOlderToolResults(messages, compactor, opts = {}) {
  const keepRecentN = opts.keepRecentN ?? 6
  const minShrinkChars = opts.minShrinkChars ?? 2000
  const log = opts.log || (() => {})

  // Count tool messages from the end
  let toolIndices = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === 'tool') toolIndices.push(i)
  }

  // Keep the last N tool messages — shrink anything before them
  const shrinkBoundary = Math.max(0, toolIndices.length - keepRecentN)
  const indicesToShrink = toolIndices.slice(0, shrinkBoundary)

  let shrunk = 0
  let bytesSaved = 0
  const ALREADY_SHRUNK = '[shrunk:'

  for (const idx of indicesToShrink) {
    const msg = messages[idx]
    if (!msg.content || typeof msg.content !== 'string') continue
    // Skip messages already shrunk
    if (msg.content.startsWith(ALREADY_SHRUNK)) continue
    // Skip already-compressed or-short messages
    if (msg.content.startsWith('[compressed:')) continue
    if (msg.content.length < minShrinkChars) continue

    // Extract a preview: first line if it's a "── file.ext (N lines) ──"
    // header, or the first 150 chars otherwise.
    const firstNewline = msg.content.indexOf('\n')
    let header = firstNewline > 0 ? msg.content.slice(0, firstNewline) : msg.content.slice(0, 150)
    header = header.trim()

    // Detect tool type from content shape
    let toolType = 'tool output'
    if (/^── .+\s+\(\d+ lines\)\s+──/.test(header)) toolType = 'file read'
    else if (header.startsWith('── ')) toolType = 'batch read'
    else if (/^\d+: /.test(header)) toolType = 'search results'

    // Store original in rewind store (if available)
    let rewindKey = null
    try {
      if (compactor && typeof compactor.rewindStore === 'function') {
        rewindKey = compactor.rewindStore(msg.content, '', Math.ceil(msg.content.length / 4))
      }
    } catch (_) { /* rewind optional */ }

    const origChars = msg.content.length
    const newContent = rewindKey
      ? `[shrunk: ${toolType}, ${origChars.toLocaleString()} chars hidden. ` +
        `First line: "${header.slice(0, 150)}". ` +
        `Rewind key: ${rewindKey} — call rewind_context({"key":"${rewindKey}"}) to retrieve the full content if needed.]`
      : `[shrunk: ${toolType}, ${origChars.toLocaleString()} chars hidden. ` +
        `First line: "${header.slice(0, 150)}".]`

    msg.content = newContent
    shrunk++
    bytesSaved += origChars - newContent.length
  }

  if (shrunk > 0) {
    log(`[tool-result-shrinker] Shrunk ${shrunk} older tool result(s), saved ~${Math.ceil(bytesSaved / 4).toLocaleString()} tokens`)
  }

  return { shrunk, tokensSaved: Math.ceil(bytesSaved / 4) }
}

module.exports = { shrinkOlderToolResults }
