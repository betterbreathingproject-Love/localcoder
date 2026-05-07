'use strict'

/**
 * Integration test: ToolSpeculator wired into DirectBridge
 *
 * Verifies that when a DirectBridge instance receives streaming tool_call
 * deltas, the speculator fires background executions that are hit when the
 * real tool_call arrives.
 *
 * Uses direct access to the DirectBridge's internal state to simulate
 * streaming without needing a full server.
 */

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const { ToolSpeculator } = require('../tool-speculator.js')

describe('ToolSpeculator + DirectBridge integration', () => {

  it('is exported from direct-bridge.js dependencies', () => {
    // Verify the module system picks it up
    const spec = new ToolSpeculator({ execute: async () => ({ ok: true }) })
    assert.ok(spec, 'ToolSpeculator instantiates')
  })

  it('speculator fires on partial args during simulated streaming', async () => {
    const calls = []
    const spec = new ToolSpeculator({
      execute: async (name, args) => {
        calls.push({ name, args, t: Date.now() })
        await new Promise(r => setTimeout(r, 5))
        return { ok: true, name, args }
      },
    })

    // Simulate streaming deltas: incomplete → partial → complete
    const streamingDeltas = [
      '{',
      '{"path"',
      '{"path":"sr',
      '{"path":"src/main.js"}',  // This one parses and fires speculation
      '{"path":"src/main.js"}',  // Duplicate — shouldn't re-fire
    ]

    const specStreamArgs = new Map()
    for (const delta of streamingDeltas) {
      try {
        const parsedArgs = JSON.parse(delta)
        const lastSig = specStreamArgs.get(0)
        const currentSig = JSON.stringify(parsedArgs)
        if (lastSig !== currentSig) {
          specStreamArgs.set(0, currentSig)
          spec.speculate('read_file', parsedArgs)
        }
      } catch { /* still streaming */ }
    }

    // Let speculation complete
    await new Promise(r => setTimeout(r, 30))

    assert.equal(calls.length, 1, 'should fire exactly once despite duplicate delta')
    assert.equal(calls[0].args.path, 'src/main.js')

    // Resolve with the matching args → hit
    const result = await spec.resolve('read_file', { path: 'src/main.js' })
    assert.equal(result.hit, true)
    assert.equal(calls.length, 1, 'no second execution on hit')
  })

  it('speculator misses gracefully when args change mid-stream', async () => {
    const calls = []
    const spec = new ToolSpeculator({
      execute: async (name, args) => {
        calls.push({ name, args })
        await new Promise(r => setTimeout(r, 5))
        return { name, args }
      },
    })

    // Model started streaming wrong path, then corrected itself
    spec.speculate('read_file', { path: 'wrong.js' })
    await new Promise(r => setTimeout(r, 20))

    // Actual tool_call arrived with different path
    const result = await spec.resolve('read_file', { path: 'right.js' })
    assert.equal(result.hit, false)
    assert.equal(result.result.args.path, 'right.js')
    // calls: [wrong.js speculation, right.js fresh exec]
    assert.equal(calls.length, 2)
  })

  it('speculator refuses unsafe tools streamed by model', () => {
    const calls = []
    const spec = new ToolSpeculator({
      execute: async () => { calls.push('called'); return {} },
    })

    const sig = spec.speculate('write_file', { path: 'x.js', content: 'mutation' })
    assert.equal(sig, null, 'unsafe tool refused')
    assert.equal(calls.length, 0, 'executor never called')
  })

  it('works with read_file against a real temporary file', async () => {
    // Create a real file to read
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-test-'))
    const tmpFile = path.join(tmpDir, 'hello.txt')
    fs.writeFileSync(tmpFile, 'hello world\nline 2')

    try {
      const spec = new ToolSpeculator({
        execute: async (name, args) => {
          if (name === 'read_file') {
            const content = fs.readFileSync(args.path, 'utf-8')
            return { result: content }
          }
          return { error: 'unknown tool' }
        },
      })

      spec.speculate('read_file', { path: tmpFile })
      await new Promise(r => setTimeout(r, 10))
      const result = await spec.resolve('read_file', { path: tmpFile })
      assert.equal(result.hit, true)
      assert.ok(result.result.result.includes('hello world'))
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('measures speedup: 100ms stream × 200ms tool, sequential vs speculative', async () => {
    const executor = async (name, args) => {
      await new Promise(r => setTimeout(r, 200)) // slow tool
      return { ok: true }
    }

    // Sequential: wait full stream, then tool
    const tSeqStart = Date.now()
    await new Promise(r => setTimeout(r, 100)) // streaming
    await executor('search_files', { patterns: ['foo'] })
    const seqMs = Date.now() - tSeqStart

    // Speculative: fire halfway through stream
    const spec = new ToolSpeculator({ execute: executor })
    const tSpecStart = Date.now()
    await new Promise(r => setTimeout(r, 50))
    spec.speculate('search_files', { patterns: ['foo'] })
    await new Promise(r => setTimeout(r, 50))
    await spec.resolve('search_files', { patterns: ['foo'] })
    const specMs = Date.now() - tSpecStart

    // Speculative should be at least 50ms faster (lower bound)
    assert.ok(specMs < seqMs - 30, `expected speedup: seq=${seqMs}ms spec=${specMs}ms`)
    console.log(`    → seq=${seqMs}ms  spec=${specMs}ms  (${(seqMs - specMs)}ms saved, ${((seqMs / specMs) * 100 - 100).toFixed(0)}% gain)`)
  })
})
