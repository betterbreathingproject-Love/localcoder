'use strict'

/**
 * Benchmark: Speculative Tool Execution
 *
 * Simulates the scenario: model streams a tool_call over ~500ms while we could
 * be executing the tool in parallel. Measures wall-clock time difference
 * between sequential (baseline) and speculative execution.
 *
 * Run: node test/bench-tool-speculator.js
 */

const { ToolSpeculator } = require('../tool-speculator.js')

// Simulated tools with realistic latencies
const TOOL_LATENCIES = {
  read_file: 15,      // small file
  read_files: 40,     // batch of 5
  list_dir: 25,
  search_files: 200,  // grep across project
  ast_search: 180,
  lsp_get_definition: 60,
  lsp_get_references: 120,
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function makeExecutor() {
  return async (name, args) => {
    await sleep(TOOL_LATENCIES[name] ?? 30)
    return { ok: true, name, args }
  }
}

// Simulated model streaming: tool_call args fill in over time
async function simulateStreaming(spec, toolName, args, streamMs = 500) {
  // The model starts emitting args partway through; by 40% we have enough
  const emitAt = Math.floor(streamMs * 0.4)
  await sleep(emitAt)
  // Fire speculation with the best-guess args
  spec.speculate(toolName, args)
  // Continue "streaming"
  await sleep(streamMs - emitAt)
  // Now resolve
  return spec.resolve(toolName, args)
}

async function benchSequential(toolName, args, streamMs) {
  const exec = makeExecutor()
  const t0 = Date.now()
  // Sequential: wait full stream, then execute
  await sleep(streamMs)
  await exec(toolName, args)
  return Date.now() - t0
}

async function benchSpeculative(toolName, args, streamMs) {
  const exec = makeExecutor()
  const spec = new ToolSpeculator({ execute: exec })
  const t0 = Date.now()
  await simulateStreaming(spec, toolName, args, streamMs)
  return Date.now() - t0
}

async function benchMixed(tools, streamMs) {
  // Run N tool calls in sequence — typical agent round
  const exec = makeExecutor()
  const spec = new ToolSpeculator({ execute: exec })

  // Sequential baseline
  let seqMs = 0
  const t0 = Date.now()
  for (const { name, args } of tools) {
    await sleep(streamMs)
    await exec(name, args)
  }
  seqMs = Date.now() - t0

  // Speculative
  const t1 = Date.now()
  for (const { name, args } of tools) {
    await simulateStreaming(spec, name, args, streamMs)
  }
  const specMs = Date.now() - t1

  return { seqMs, specMs, stats: spec.stats() }
}

async function main() {
  console.log('='.repeat(70))
  console.log('Speculative Tool Execution — Benchmark')
  console.log('='.repeat(70))
  console.log('')
  console.log('Scenario: the model is streaming a tool_call over a configurable')
  console.log('window. With speculation, we fire the tool halfway through.')
  console.log('')

  // ── Single-tool benchmarks ────────────────────────────────────────────
  console.log('┌───────────────────────────┬──────────────┬──────────────┬───────────┐')
  console.log('│ Tool                      │ Sequential   │ Speculative  │ Speedup   │')
  console.log('├───────────────────────────┼──────────────┼──────────────┼───────────┤')

  const streamMs = 500 // typical token-streaming time
  const scenarios = [
    ['read_file (small)',     'read_file',          { path: 'src/main.js' }],
    ['read_files (batch=5)',  'read_files',         { paths: Array(5).fill('x.js') }],
    ['search_files (grep)',   'search_files',       { patterns: ['foo'], path: 'src' }],
    ['ast_search',            'ast_search',         { query: 'function foo' }],
    ['lsp_get_references',    'lsp_get_references', { file_path: 'x', line: 1, column: 1 }],
  ]

  for (const [label, tool, args] of scenarios) {
    const seqMs = await benchSequential(tool, args, streamMs)
    const specMs = await benchSpeculative(tool, args, streamMs)
    const speedup = (seqMs / specMs).toFixed(2) + 'x'
    const saved = seqMs - specMs
    console.log(`│ ${label.padEnd(25)} │ ${String(seqMs).padStart(5)}ms      │ ${String(specMs).padStart(5)}ms (-${String(saved).padStart(3)}ms) │ ${speedup.padStart(9)} │`)
  }
  console.log('└───────────────────────────┴──────────────┴──────────────┴───────────┘')
  console.log('')

  // ── Multi-tool round ──────────────────────────────────────────────────
  console.log('Agent round simulation: 6 tool calls, each streamed over 500ms')
  console.log('')
  const toolMix = [
    { name: 'list_dir', args: { path: '.' } },
    { name: 'read_file', args: { path: 'config.js' } },
    { name: 'search_files', args: { patterns: ['import'], path: 'src' } },
    { name: 'lsp_get_definition', args: { file_path: 'x', line: 1, column: 1 } },
    { name: 'ast_search', args: { query: 'class' } },
    { name: 'read_file', args: { path: 'README.md' } },
  ]
  const { seqMs, specMs, stats } = await benchMixed(toolMix, 500)
  const roundSpeedup = (seqMs / specMs).toFixed(2)
  const roundSaved = seqMs - specMs
  console.log(`  Sequential round:   ${seqMs}ms`)
  console.log(`  Speculative round:  ${specMs}ms (saved ${roundSaved}ms, ${roundSpeedup}x faster)`)
  console.log(`  Hit rate: ${(stats.hit_rate * 100).toFixed(0)}%`)
  console.log('')

  // ── Hit/miss sensitivity ──────────────────────────────────────────────
  console.log('Miss penalty analysis: what if our speculation guesses are wrong?')
  console.log('')
  console.log('  Speculation guess differs from actual args → speculation is discarded,')
  console.log('  fresh execution runs. Worst case: full sequential time + miss overhead.')
  console.log('')

  // Miss scenario: we speculate wrong args, then fresh-exec on actual
  const exec = makeExecutor()
  const spec = new ToolSpeculator({ execute: exec })

  const tMissStart = Date.now()
  // Streaming: speculate wrong, resolve with different
  await sleep(200)
  spec.speculate('read_file', { path: 'wrong.js' })
  await sleep(300)
  await spec.resolve('read_file', { path: 'actual.js' })
  const missMs = Date.now() - tMissStart

  const tBaseStart = Date.now()
  await sleep(500)
  await exec('read_file', { path: 'actual.js' })
  const baseMs = Date.now() - tBaseStart

  console.log(`  Baseline (no spec):      ${baseMs}ms`)
  console.log(`  Speculation miss:        ${missMs}ms  (+${missMs - baseMs}ms overhead)`)
  console.log('')
  console.log('  Miss overhead is small because read_file finishes in parallel with')
  console.log('  streaming; only the useless speculation result is discarded.')
  console.log('')

  console.log('='.repeat(70))
  console.log('TAKEAWAY: For tool-heavy agent rounds (typical case), speculation')
  console.log('eliminates tool latency from the critical path when streaming time')
  console.log('exceeds tool execution time. Gains scale with tool count per turn.')
  console.log('='.repeat(70))
}

main().catch(e => { console.error(e); process.exit(1) })
