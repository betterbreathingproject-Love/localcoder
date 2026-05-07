'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { shrinkOlderToolResults } = require('../tool-result-shrinker.js')

// Simple mock compactor with a rewind store
function mockCompactor() {
  const store = new Map()
  let n = 0
  return {
    rewindStore(original, compressed, tokens) {
      n++
      const key = `rw_${n}`
      store.set(key, original)
      return key
    },
    rewindRetrieve(key) { return store.get(key) || null },
    _size: () => store.size,
  }
}

function makeToolMsg(id, content) {
  return { role: 'tool', tool_call_id: id, content }
}

function makeLongContent(lines, prefix = '') {
  return (prefix ? prefix + '\n' : '') + Array.from({ length: lines }, (_, i) => `${i + 1}| line ${i}`).join('\n')
}

describe('Tool Result Shrinker', () => {

  it('shrinks older tool results, keeps recent N intact', () => {
    const compactor = mockCompactor()
    const messages = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'do a thing' },
      makeToolMsg('c1', makeLongContent(100, '── old-file.js (100 lines) ──')),
      makeToolMsg('c2', makeLongContent(100, '── older-file.js (100 lines) ──')),
      makeToolMsg('c3', makeLongContent(100, '── recent.js (100 lines) ──')),
      makeToolMsg('c4', makeLongContent(100, '── latest.js (100 lines) ──')),
    ]
    const { shrunk, tokensSaved } = shrinkOlderToolResults(messages, compactor, { keepRecentN: 2 })
    assert.equal(shrunk, 2, 'should shrink 2 older tool results')
    assert.ok(tokensSaved > 0)
    // Oldest two should be shrunk
    assert.ok(messages[2].content.startsWith('[shrunk:'))
    assert.ok(messages[3].content.startsWith('[shrunk:'))
    // Recent two should be intact
    assert.ok(!messages[4].content.startsWith('[shrunk:'))
    assert.ok(!messages[5].content.startsWith('[shrunk:'))
    // Shrunk messages should have rewind keys
    assert.ok(messages[2].content.includes('rw_'))
    assert.ok(messages[3].content.includes('rw_'))
  })

  it('preserves rewind retrievability', () => {
    const compactor = mockCompactor()
    const longContent = makeLongContent(100, '── file.js (100 lines) ──')
    const messages = [
      { role: 'system', content: 'system' },
      makeToolMsg('c1', longContent),
      makeToolMsg('c2', 'recent tool result'),
    ]
    shrinkOlderToolResults(messages, compactor, { keepRecentN: 1 })
    // Extract the rewind key from the shrunk message
    const match = messages[1].content.match(/rw_\d+/)
    assert.ok(match, 'shrunk message should include rewind key')
    const retrieved = compactor.rewindRetrieve(match[0])
    assert.equal(retrieved, longContent, 'rewind key should recover original')
  })

  it('skips messages below minShrinkChars', () => {
    const compactor = mockCompactor()
    const shortContent = '── small.js (5 lines) ──\nhello'
    const messages = [
      makeToolMsg('c1', shortContent),
      makeToolMsg('c2', makeLongContent(100, '── big.js (100 lines) ──')),
      makeToolMsg('c3', 'recent'),
    ]
    const { shrunk } = shrinkOlderToolResults(messages, compactor, { keepRecentN: 1, minShrinkChars: 500 })
    // Only the long one (index 1) is shrunk — short one skipped
    assert.equal(shrunk, 1)
    assert.equal(messages[0].content, shortContent)
    assert.ok(messages[1].content.startsWith('[shrunk:'))
  })

  it('skips already-shrunk messages', () => {
    const compactor = mockCompactor()
    const messages = [
      makeToolMsg('c1', '[shrunk: file read, 5000 chars hidden. First line: "── old.js ──". Rewind key: rw_99]'),
      makeToolMsg('c2', makeLongContent(100, '── unshrunk.js (100 lines) ──')),
      makeToolMsg('c3', 'recent'),
    ]
    const { shrunk } = shrinkOlderToolResults(messages, compactor, { keepRecentN: 1 })
    assert.equal(shrunk, 1, 'only the unshrunk one should be shrunk')
  })

  it('skips already-compressed messages', () => {
    const compactor = mockCompactor()
    const messages = [
      makeToolMsg('c1', '[compressed: 80% reduction...] actual content here'),
      makeToolMsg('c2', makeLongContent(100, '── file.js (100 lines) ──')),
      makeToolMsg('c3', 'recent'),
    ]
    const { shrunk } = shrinkOlderToolResults(messages, compactor, { keepRecentN: 1 })
    assert.equal(shrunk, 1)
  })

  it('handles no tool messages gracefully', () => {
    const compactor = mockCompactor()
    const messages = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ]
    const { shrunk } = shrinkOlderToolResults(messages, compactor, { keepRecentN: 3 })
    assert.equal(shrunk, 0)
  })

  it('works without compactor (no rewind)', () => {
    const messages = [
      makeToolMsg('c1', makeLongContent(100, '── file.js (100 lines) ──')),
      makeToolMsg('c2', 'recent'),
    ]
    const { shrunk } = shrinkOlderToolResults(messages, null, { keepRecentN: 1 })
    assert.equal(shrunk, 1)
    // Should still shrink, just without rewind key
    assert.ok(messages[0].content.startsWith('[shrunk:'))
    assert.ok(!messages[0].content.includes('rw_'))
  })

  it('detects file reads, batch reads, and searches differently', () => {
    const compactor = mockCompactor()
    const messages = [
      makeToolMsg('c1', '── single.js (100 lines) ──\n' + 'x'.repeat(3000)),
      makeToolMsg('c2', '── first.js\n── second.js\n' + 'x'.repeat(3000)),
      makeToolMsg('c3', '1: match here\n2: another match\n' + 'x'.repeat(3000)),
      makeToolMsg('c4', 'recent'),
    ]
    shrinkOlderToolResults(messages, compactor, { keepRecentN: 1 })
    assert.ok(messages[0].content.includes('file read'))
    assert.ok(messages[1].content.includes('batch read'))
    assert.ok(messages[2].content.includes('search results'))
  })
})
