'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { CascadeRouter } = require('../cascade-router.js')

const TIERS = {
  0: { model: 'fast-0.8b', budget: 4096 },
  1: { model: 'mid-4b', budget: 16384 },
  2: { model: 'primary-35b', budget: 131072 },
}

describe('CascadeRouter', () => {

  describe('startTier()', () => {
    it('starts low for cascadable roles', () => {
      const r = new CascadeRouter({ tiers: TIERS })
      assert.equal(r.startTier('code-search'), 0)
      assert.equal(r.startTier('context-gather'), 0)
      assert.equal(r.startTier('explore'), 1)
    })

    it('starts at max for primary-only roles', () => {
      const r = new CascadeRouter({ tiers: TIERS })
      assert.equal(r.startTier('implementation'), 2)
      assert.equal(r.startTier('debug'), 2)
    })

    it('defaults to max for unknown roles', () => {
      const r = new CascadeRouter({ tiers: TIERS })
      assert.equal(r.startTier('unknown-role'), 2)
    })
  })

  describe('evaluate() - commit decisions', () => {
    it('commits when a valid simple tool_call is returned', () => {
      const r = new CascadeRouter({ tiers: TIERS })
      const resp = {
        tool_calls: [{ function: { name: 'read_file', arguments: '{"path":"x.js"}' } }],
        content: null,
        finish_reason: 'tool_calls',
      }
      const d = r.evaluate(resp, 'code-search', 0)
      assert.equal(d.commit, true)
    })

    it('escalates on empty response', () => {
      const r = new CascadeRouter({ tiers: TIERS })
      const resp = { content: null, tool_calls: null, finish_reason: 'stop' }
      const d = r.evaluate(resp, 'code-search', 0)
      assert.equal(d.commit, false)
      assert.equal(d.next_tier, 1)
    })

    it('does not escalate past max tier', () => {
      const r = new CascadeRouter({ tiers: TIERS })
      const resp = { content: null, tool_calls: null, finish_reason: 'stop' }
      const d = r.evaluate(resp, 'code-search', 2)
      assert.equal(d.commit, true, 'must commit at max tier')
    })

    it('commits text-only for completion role when content present', () => {
      const r = new CascadeRouter({ tiers: TIERS })
      const resp = { content: 'Here is the result', tool_calls: null, finish_reason: 'stop' }
      const d = r.evaluate(resp, 'requirements', 1)
      assert.equal(d.commit, true)
    })

    it('escalates text-only for action roles', () => {
      const r = new CascadeRouter({ tiers: TIERS })
      const resp = {
        content: 'I will now proceed to read the file',
        tool_calls: null,
        finish_reason: 'stop',
      }
      const d = r.evaluate(resp, 'code-search', 0)
      assert.equal(d.commit, false, 'should escalate — no tool call from action role')
    })
  })

  describe('evaluate() - confidence', () => {
    it('commits when logprobs show high confidence', () => {
      const r = new CascadeRouter({ tiers: TIERS })
      const resp = {
        content: 'some output',
        finish_reason: 'stop',
        logprobs: {
          content: [
            { top_logprobs: [{ logprob: -0.1 }, { logprob: -5.0 }] },
            { top_logprobs: [{ logprob: -0.2 }, { logprob: -4.0 }] },
          ],
        },
      }
      const d = r.evaluate(resp, 'requirements', 1)
      assert.equal(d.commit, true)
    })

    it('escalates when confidence is low', () => {
      const r = new CascadeRouter({ tiers: TIERS, confidenceThreshold: 2.0 })
      const resp = {
        content: 'ambiguous',
        finish_reason: 'stop',
        logprobs: {
          content: [
            { top_logprobs: [{ logprob: -0.5 }, { logprob: -0.7 }] },
            { top_logprobs: [{ logprob: -0.6 }, { logprob: -1.0 }] },
          ],
        },
      }
      const d = r.evaluate(resp, 'requirements', 1)
      assert.equal(d.commit, false)
    })
  })

  describe('stats', () => {
    it('tracks escalation ratio', () => {
      const r = new CascadeRouter({ tiers: TIERS })
      // Simulate: 3 dispatches, 2 escalate
      r.recordCommit(0)
      r.recordCommit(1)
      r.recordCommit(2)
      const s = r.stats()
      assert.equal(s.dispatches, 3)
      assert.equal(s.tier_0_committed, 1)
      assert.equal(s.tier_1_committed, 1)
      assert.equal(s.tier_2_committed, 1)
    })
  })
})
