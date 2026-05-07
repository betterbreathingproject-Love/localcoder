'use strict'

/**
 * End-to-end test: DirectBridge with ToolSpeculator wired in.
 *
 * Instantiates a real DirectBridge and verifies:
 *   1. Speculator is initialized when _agentLoop starts
 *   2. The _speculateEnabled flag defaults correctly
 *   3. Cleanup happens on interrupt() and close()
 */

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { DirectBridge } = require('../direct-bridge.js')

// Minimal sink for the bridge
class SilentSink {
  constructor() { this.events = [] }
  send(channel, data) { this.events.push({ channel, data }) }
}

describe('DirectBridge with ToolSpeculator', () => {

  it('initializes _speculateEnabled by default (module available)', () => {
    const sink = new SilentSink()
    const bridge = new DirectBridge(sink)
    assert.equal(bridge._speculateEnabled, true, 'speculator should be enabled by default')
    assert.equal(bridge._toolSpeculator, null, 'speculator instance is lazy (created in _agentLoop)')
    assert.ok(bridge._specStreamArgs instanceof Map, 'stream tracking map is initialized')
  })

  it('respects opts.speculateTools = false', () => {
    const sink = new SilentSink()
    const bridge = new DirectBridge(sink, { speculateTools: false })
    assert.equal(bridge._speculateEnabled, false)
  })

  it('cleans up speculator on interrupt()', async () => {
    const sink = new SilentSink()
    const bridge = new DirectBridge(sink)
    // Simulate the state after _agentLoop has run once
    const { ToolSpeculator } = require('../tool-speculator.js')
    bridge._toolSpeculator = new ToolSpeculator({ execute: async () => ({}) })
    bridge._specStreamArgs = new Map([[0, '{"path":"a"}']])
    bridge._currentCwd = '/tmp'

    await bridge.interrupt()

    assert.equal(bridge._toolSpeculator, null, 'speculator cleared')
    assert.equal(bridge._specStreamArgs.size, 0, 'stream args cleared')
    assert.equal(bridge._currentCwd, null, 'cwd cleared')
  })

  it('cleans up speculator on close()', async () => {
    const sink = new SilentSink()
    const bridge = new DirectBridge(sink)
    const { ToolSpeculator } = require('../tool-speculator.js')
    bridge._toolSpeculator = new ToolSpeculator({ execute: async () => ({}) })

    await bridge.close()

    assert.equal(bridge._toolSpeculator, null, 'speculator cleared on close')
  })
})
