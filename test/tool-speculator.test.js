'use strict'

const { describe, it, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { ToolSpeculator, SAFE_TOOLS } = require('../tool-speculator.js')

// Mock executor that tracks calls
function makeExecutor(delayMs = 0, errorFor = null) {
  const calls = []
  const exec = async (name, args) => {
    calls.push({ name, args, t: Date.now() })
    if (delayMs) await new Promise(r => setTimeout(r, delayMs))
    if (errorFor && errorFor(name, args)) throw new Error(`mock error for ${name}`)
    return { ok: true, name, args }
  }
  return { exec, calls }
}

describe('ToolSpeculator', () => {

  describe('safety checks', () => {
    it('identifies read-only tools as safe', () => {
      assert.equal(ToolSpeculator.isSafe('read_file'), true)
      assert.equal(ToolSpeculator.isSafe('search_files'), true)
      assert.equal(ToolSpeculator.isSafe('lsp_get_hover'), true)
    })

    it('identifies mutating tools as unsafe', () => {
      assert.equal(ToolSpeculator.isSafe('write_file'), false)
      assert.equal(ToolSpeculator.isSafe('edit_file'), false)
      assert.equal(ToolSpeculator.isSafe('bash'), false)
    })
  })

  describe('speculate()', () => {
    it('fires speculation when args are complete enough', async () => {
      const { exec, calls } = makeExecutor(50)
      const spec = new ToolSpeculator({ execute: exec })
      const sig = spec.speculate('read_file', { path: 'src/main.js' })
      assert.ok(sig, 'should return signature')
      // Give it a tick to actually fire
      await new Promise(r => setTimeout(r, 10))
      assert.equal(calls.length, 1)
      assert.equal(calls[0].name, 'read_file')
    })

    it('refuses to speculate on unsafe tools', () => {
      const { exec, calls } = makeExecutor()
      const spec = new ToolSpeculator({ execute: exec })
      const sig = spec.speculate('write_file', { path: 'x', content: 'y' })
      assert.equal(sig, null)
      assert.equal(calls.length, 0)
    })

    it('does not speculate if required fields missing', () => {
      const { exec, calls } = makeExecutor()
      const spec = new ToolSpeculator({ execute: exec })
      const sig = spec.speculate('read_file', {})
      assert.equal(sig, null)
      assert.equal(calls.length, 0)
    })

    it('deduplicates identical speculations', async () => {
      const { exec, calls } = makeExecutor(50)
      const spec = new ToolSpeculator({ execute: exec })
      const sig1 = spec.speculate('read_file', { path: 'a.js' })
      const sig2 = spec.speculate('read_file', { path: 'a.js' })
      assert.equal(sig1, sig2)
      await new Promise(r => setTimeout(r, 100))
      assert.equal(calls.length, 1, 'should only fire once')
    })

    it('respects max inflight limit', () => {
      const { exec } = makeExecutor(500) // slow so they stay in flight
      const spec = new ToolSpeculator({ execute: exec, maxInflight: 2 })
      const s1 = spec.speculate('read_file', { path: 'a.js' })
      const s2 = spec.speculate('read_file', { path: 'b.js' })
      const s3 = spec.speculate('read_file', { path: 'c.js' })
      assert.ok(s1)
      assert.ok(s2)
      assert.equal(s3, null, 'third speculation should be skipped')
    })
  })

  describe('resolve()', () => {
    it('returns hit when speculation matches', async () => {
      const { exec, calls } = makeExecutor(30)
      const spec = new ToolSpeculator({ execute: exec })
      spec.speculate('read_file', { path: 'src/foo.js' })
      await new Promise(r => setTimeout(r, 50)) // let spec finish
      const r = await spec.resolve('read_file', { path: 'src/foo.js' })
      assert.equal(r.hit, true)
      assert.equal(r.result.ok, true)
      assert.equal(calls.length, 1, 'should reuse speculation, no re-execution')
    })

    it('returns miss and executes fresh when args differ', async () => {
      const { exec, calls } = makeExecutor()
      const spec = new ToolSpeculator({ execute: exec })
      spec.speculate('read_file', { path: 'guessed.js' })
      await new Promise(r => setTimeout(r, 10))
      const r = await spec.resolve('read_file', { path: 'actual.js' })
      assert.equal(r.hit, false)
      assert.equal(calls.length, 2, 'both speculation and fresh exec ran')
      assert.equal(r.result.args.path, 'actual.js')
    })

    it('discards other speculations on hit', async () => {
      const { exec } = makeExecutor(30)
      const spec = new ToolSpeculator({ execute: exec })
      spec.speculate('read_file', { path: 'guess1.js' })
      spec.speculate('read_file', { path: 'guess2.js' })
      spec.speculate('read_file', { path: 'actual.js' })
      await new Promise(r => setTimeout(r, 50))
      await spec.resolve('read_file', { path: 'actual.js' })
      assert.equal(spec.stats().inflight, 0, 'all speculations cleared')
    })

    it('propagates errors from speculated execution', async () => {
      const { exec } = makeExecutor(0, (n, a) => n === 'read_file')
      const spec = new ToolSpeculator({ execute: exec })
      spec.speculate('read_file', { path: 'x.js' })
      await new Promise(r => setTimeout(r, 10))
      await assert.rejects(
        () => spec.resolve('read_file', { path: 'x.js' }),
        /mock error/
      )
    })
  })

  describe('stats', () => {
    it('tracks hits and misses', async () => {
      const { exec } = makeExecutor(10)
      const spec = new ToolSpeculator({ execute: exec })
      spec.speculate('read_file', { path: 'a.js' })
      await new Promise(r => setTimeout(r, 30))
      await spec.resolve('read_file', { path: 'a.js' })
      await spec.resolve('read_file', { path: 'b.js' })
      const s = spec.stats()
      assert.equal(s.hits, 1)
      assert.equal(s.misses, 1)
      assert.equal(s.fired, 1)
      assert.equal(s.hit_rate, 1.0) // 1 hit out of 1 fired
    })
  })
})
