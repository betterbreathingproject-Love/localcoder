'use strict'

/**
 * Integration smoke test — validates that the three new modules plug into the
 * existing codebase without breaking core flows.
 *
 * Runs:
 *   1. Load direct-bridge.js (which now requires tool-speculator + constrained-decoder)
 *   2. Load agent-pool.js (which now requires cascade-router)
 *   3. Exercise the constrained-decoder path with malformed inputs
 *   4. Instantiate an AgentPool with cascade enabled
 *   5. Run a ToolSpeculator round to confirm it works in-process
 *
 * This is the JS side; the semantic-kv-cache.py will be validated separately
 * with a real MLX server.
 *
 * Run: node test/integration-smoke.js
 */

const assert = require('node:assert/strict')

async function main() {
  console.log('='.repeat(70))
  console.log('Integration smoke test — wiring verification')
  console.log('='.repeat(70))
  console.log('')

  // ── 1. Module load check ─────────────────────────────────────────────
  console.log('[1/5] Loading modules...')
  const directBridge = require('../direct-bridge.js')
  const { AgentPool } = require('../agent-pool.js')
  const { ToolSpeculator } = require('../tool-speculator.js')
  const { CascadeRouter } = require('../cascade-router.js')
  const constrained = require('../constrained-decoder.js')
  console.log('    ✓ direct-bridge.js loaded')
  console.log('    ✓ agent-pool.js loaded')
  console.log('    ✓ tool-speculator.js loaded')
  console.log('    ✓ cascade-router.js loaded')
  console.log('    ✓ constrained-decoder.js loaded')
  console.log('')

  // ── 2. constrained-decoder real-world repair ────────────────────────
  console.log('[2/5] Exercising constrained-decoder on malformed tool calls...')
  const toolDefs = [
    { type: 'function', function: { name: 'read_file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'write_file',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  ]

  const inputs = [
    { name: 'read_file', arguments: '{"path":"x.js"}' },            // clean
    { name: 'read_file', args: '{"path":"y.js"}' },                 // args → arguments
    { name: 'read_file', arguments: "{'path':'z.js'}" },            // single quotes
    { name: 'read_file', arguments: '{"path":"a.js",}' },           // trailing comma
    { name: 'read_file', arguments: '```json\n{"path":"b.js"}\n```' }, // markdown
    { name: 'read_file', arguments: '{}' },                         // missing required → should fail
  ]

  let repaired = 0
  let rejected = 0
  for (const input of inputs) {
    const r = constrained.repairAndValidate({ function: input }, toolDefs)
    if (r.valid) repaired++
    else rejected++
    console.log(`    ${r.valid ? '✓' : '✗'} ${JSON.stringify(input).slice(0, 55).padEnd(58)} issues: ${r.issues.length}`)
  }
  assert.equal(repaired, 5, '5 repairable cases should pass')
  assert.equal(rejected, 1, '1 unfixable case should fail')
  console.log(`    → ${repaired} repaired, ${rejected} correctly rejected`)
  console.log('')

  // ── 3. AgentPool with cascade enabled ───────────────────────────────
  console.log('[3/5] AgentPool with cascade router...')
  const pool = new AgentPool({
    maxConcurrency: 2,
    cascade: {
      tiers: {
        0: { model: 'fast-0.8b' },
        1: { model: 'mid-4b' },
        2: { model: 'primary-35b' },
      },
    },
  })
  const router = pool.getCascadeRouter()
  assert.ok(router, 'router should be instantiated')
  console.log(`    ✓ AgentPool with cascade router created`)
  assert.equal(router.startTier('code-search'), 0)
  assert.equal(router.startTier('implementation'), 2)
  console.log(`    ✓ startTier('code-search') → 0`)
  console.log(`    ✓ startTier('implementation') → 2`)
  console.log('')

  // ── 4. ToolSpeculator in-process round ─────────────────────────────
  console.log('[4/5] ToolSpeculator in-process...')
  let calls = 0
  const spec = new ToolSpeculator({
    execute: async (name, args) => {
      calls++
      await new Promise(r => setTimeout(r, 10))
      return { name, args, ok: true }
    },
  })
  const sig = spec.speculate('read_file', { path: 'test.js' })
  assert.ok(sig, 'should return signature for safe tool')
  await new Promise(r => setTimeout(r, 20))
  const result = await spec.resolve('read_file', { path: 'test.js' })
  assert.equal(result.hit, true, 'should hit the speculation')
  assert.equal(calls, 1, 'execute should be called once only')
  console.log(`    ✓ speculation fired (sig=${sig.slice(0, 12)}...)`)
  console.log(`    ✓ resolve returned hit=true with ${calls} execute call(s)`)
  console.log('')

  // ── 5. Unsafe tool rejection ────────────────────────────────────────
  console.log('[5/5] ToolSpeculator rejects unsafe tools...')
  const unsafeSig = spec.speculate('write_file', { path: 'x.js', content: 'mutation' })
  assert.equal(unsafeSig, null, 'should refuse to speculate on write_file')
  console.log(`    ✓ write_file speculation refused (unsafe)`)
  console.log('')

  // ── Done ────────────────────────────────────────────────────────────
  console.log('='.repeat(70))
  console.log('All integration checks passed ✓')
  console.log('')
  console.log('Wired modules:')
  console.log('  • constrained-decoder → direct-bridge.js tool_call parse path')
  console.log('  • cascade-router      → agent-pool.js (opt-in via ctor option)')
  console.log('  • tool-speculator     → loadable, awaiting direct-bridge hook')
  console.log('  • semantic-kv-cache   → Python module, awaits server.py import')
  console.log('='.repeat(70))
}

main().catch(e => {
  console.error('FAILED:', e)
  process.exit(1)
})
