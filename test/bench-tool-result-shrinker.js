'use strict'

/**
 * Benchmark: Tool Result Shrinker
 * Simulates the screenshot scenario: 5 file reads stacking up to 27K+ tokens
 * of tool results. Measures how many tokens get eliminated per turn.
 */

const { shrinkOlderToolResults } = require('../tool-result-shrinker.js')

function mockCompactor() {
  const store = new Map()
  let n = 0
  return {
    rewindStore: (orig) => { n++; const k = `rw_${n}`; store.set(k, orig); return k },
    _size: () => store.size,
  }
}

function makeFileRead(path, lines, avgLineChars = 80) {
  const content = Array.from({ length: lines }, (_, i) =>
    `${i + 1}| ` + 'const foo = bar.baz() // '.padEnd(avgLineChars - 10, 'x')
  ).join('\n')
  return `── ${path} (${lines} lines) ──\n${content}`
}

function estimateTokens(text) { return Math.ceil(text.length / 4) }

function totalTokens(messages) {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content || ''), 0)
}

console.log('='.repeat(70))
console.log('Tool Result Shrinker — Benchmark')
console.log('='.repeat(70))
console.log('')
console.log('Scenario: agent reads 5 files over 5 turns, stacking up tool')
console.log('results like in the real screenshot (27K tokens at turn 5).')
console.log('')

// Simulate the screenshot scenario: 5 file reads
const filesRead = [
  makeFileRead('booking.html', 800),
  makeFileRead('booking.js', 600),
  makeFileRead('property.html', 500),
  makeFileRead('styles.css', 300),
  makeFileRead('wellness.html', 400),
]

// Baseline: all 5 reads stay in context
const baselineMessages = [
  { role: 'system', content: 'You are a coding assistant.' },
  { role: 'user', content: 'Analyze the booking system and fix any issues.' },
  { role: 'tool', tool_call_id: 'c1', content: filesRead[0] },
  { role: 'assistant', content: 'Now reading the JS file.' },
  { role: 'tool', tool_call_id: 'c2', content: filesRead[1] },
  { role: 'assistant', content: 'Checking property page.' },
  { role: 'tool', tool_call_id: 'c3', content: filesRead[2] },
  { role: 'assistant', content: 'Checking styles.' },
  { role: 'tool', tool_call_id: 'c4', content: filesRead[3] },
  { role: 'assistant', content: 'Checking wellness page.' },
  { role: 'tool', tool_call_id: 'c5', content: filesRead[4] },
]

const baselineTokens = totalTokens(baselineMessages)
console.log(`Baseline context: ${baselineTokens.toLocaleString()} tokens across 5 tool results`)
console.log('')

// Apply shrinker with different keepRecentN values
for (const keep of [1, 2, 3, 6]) {
  // Clone messages so each run starts fresh
  const clone = JSON.parse(JSON.stringify(baselineMessages))
  const compactor = mockCompactor()
  const { shrunk, tokensSaved } = shrinkOlderToolResults(clone, compactor, {
    keepRecentN: keep,
    minShrinkChars: 2000,
  })
  const after = totalTokens(clone)
  const reduction = ((baselineTokens - after) / baselineTokens * 100).toFixed(0)
  console.log(`  keepRecentN=${keep}: ${shrunk} shrunk, ${baselineTokens.toLocaleString()} → ${after.toLocaleString()} tokens (-${reduction}%)`)
}

console.log('')
console.log('─── Real-world impact ───────────────────────────────────────────')
console.log('')
console.log('With keepRecentN=2 (recommended for agent workflows):')
const clone = JSON.parse(JSON.stringify(baselineMessages))
const compactor = mockCompactor()
const result = shrinkOlderToolResults(clone, compactor, { keepRecentN: 2, minShrinkChars: 2000 })
const after = totalTokens(clone)
const msPerToken = 1.0 // M1 Max 35B prefill estimate
const saved_seconds = ((baselineTokens - after) * msPerToken) / 1000
console.log(`  Tokens eliminated per turn: ${(baselineTokens - after).toLocaleString()}`)
console.log(`  Prefill time saved per turn: ~${saved_seconds.toFixed(1)}s`)
console.log(`  Over 20 agent turns: ~${(saved_seconds * 20 / 60).toFixed(1)}min saved`)
console.log('')
console.log('The agent can still rewind to full content via rewind_context({"key":"rw_X"})')
console.log('if it ever needs the original content of a shrunk tool result.')
console.log('='.repeat(70))
