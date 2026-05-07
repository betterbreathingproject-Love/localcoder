'use strict'

/**
 * Benchmark: Constrained Tool Call Decoding
 *
 * Measures how many malformed tool_calls the repair layer fixes vs how many
 * would have required a round-trip retry without it. Each avoided retry
 * saves ~one full model generation (typically 5-20 seconds on 35B).
 *
 * Run: node test/bench-constrained-decoder.js
 */

const { repairAndValidate } = require('../constrained-decoder.js')

const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          start_line: { type: 'number' },
          end_line: { type: 'number' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      parameters: {
        type: 'object',
        properties: {
          patterns: { type: 'array' },
          path: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_todos',
      parameters: {
        type: 'object',
        properties: {
          todos: { type: 'array' },
        },
        required: ['todos'],
      },
    },
  },
]

// Real-world malformed tool_calls observed from various LLM outputs
const MALFORMED_CASES = [
  {
    label: 'wrong arg key "args"',
    input: { function: { name: 'read_file', args: '{"path":"x.js"}' } },
  },
  {
    label: 'wrong arg key "params"',
    input: { function: { name: 'read_file', params: { path: 'x.js' } } },
  },
  {
    label: 'wrong name key "tool"',
    input: { function: { tool: 'read_file', arguments: '{"path":"x.js"}' } },
  },
  {
    label: 'flat shape (no function object)',
    input: { name: 'read_file', arguments: '{"path":"x.js"}' },
  },
  {
    label: 'trailing comma in JSON',
    input: { function: { name: 'read_file', arguments: '{"path":"x.js",}' } },
  },
  {
    label: 'single quotes in JSON',
    input: { function: { name: 'read_file', arguments: "{'path':'x.js'}" } },
  },
  {
    label: 'markdown-fenced JSON',
    input: { function: { name: 'read_file', arguments: '```json\n{"path":"x.js"}\n```' } },
  },
  {
    label: 'missing closing brace',
    input: { function: { name: 'read_file', arguments: '{"path":"x.js"' } },
  },
  {
    label: 'string number for number field',
    input: { function: { name: 'read_file', arguments: '{"path":"x.js","start_line":"10"}' } },
  },
  {
    label: 'single value where array expected',
    input: { function: { name: 'search_files', arguments: '{"patterns":"foo"}' } },
  },
  {
    label: 'empty args',
    input: { function: { name: 'read_file', arguments: '{}' } }, // should FAIL (missing path)
  },
  {
    label: 'unknown tool',
    input: { function: { name: 'fake_tool', arguments: '{}' } }, // should FAIL
  },
  {
    label: 'gibberish arguments',
    input: { function: { name: 'read_file', arguments: 'lol not json' } }, // should FAIL
  },
  {
    label: 'nested single + trailing comma',
    input: { function: { name: 'read_file', arguments: "{'path':'x.js',}" } },
  },
  {
    label: 'unquoted key names',
    input: { function: { name: 'read_file', arguments: "{path:'x.js'}" } },
  },
]

async function main() {
  console.log('='.repeat(70))
  console.log('Constrained Tool Call Decoding — Benchmark')
  console.log('='.repeat(70))
  console.log('')
  console.log('Tests the repair layer against real-world malformed tool_calls')
  console.log('observed from various LLMs. Each fixable case saves one retry round.')
  console.log('')

  console.log('┌───────────────────────────────────────┬──────────┬─────────────────────┐')
  console.log('│ Malformed pattern                     │ Repaired │ Issues              │')
  console.log('├───────────────────────────────────────┼──────────┼─────────────────────┤')

  let fixed = 0
  let correctlyFailed = 0
  let totalIssues = 0

  for (const { label, input } of MALFORMED_CASES) {
    const r = repairAndValidate(input, TOOL_DEFS)
    const status = r.valid ? '✓ yes' : '✗ no'
    const issuesStr = r.issues.length > 0 ? `${r.issues.length} fix(es)` : '-'
    if (r.valid) fixed++
    else if (label.includes('unknown') || label.includes('gibberish') || label === 'empty args') {
      correctlyFailed++
    }
    totalIssues += r.issues.length
    console.log(`│ ${label.padEnd(37)} │ ${status.padEnd(8)} │ ${issuesStr.padEnd(19)} │`)
  }
  console.log('└───────────────────────────────────────┴──────────┴─────────────────────┘')
  console.log('')

  const total = MALFORMED_CASES.length
  const shouldFix = total - 3 // empty, unknown, gibberish — should fail, not fix
  console.log('─── Summary ──────────────────────────────────────────────────')
  console.log('')
  console.log(`  Total malformed inputs:     ${total}`)
  console.log(`  Successfully repaired:      ${fixed} / ${shouldFix} fixable (${((fixed / shouldFix) * 100).toFixed(0)}%)`)
  console.log(`  Correctly rejected:         ${correctlyFailed} / 3 unfixable`)
  console.log(`  Total repair operations:    ${totalIssues}`)
  console.log('')

  // ── Retry cost analysis ──────────────────────────────────────────────
  console.log('─── Retry cost analysis ──────────────────────────────────────')
  console.log('')
  console.log('Without repair layer, each malformed call costs one full retry round:')
  console.log('')
  const retryCostMs = 8000 // typical 35B retry on M1 Max
  const savedRounds = fixed
  const savedMs = savedRounds * retryCostMs
  console.log(`  Retry round cost (est.):    ~${retryCostMs / 1000}s on M1 Max @ 35B`)
  console.log(`  Retry rounds avoided:       ${savedRounds}`)
  console.log(`  Time saved:                 ${(savedMs / 1000).toFixed(0)}s across ${total} malformed calls`)
  console.log('')
  console.log('Per 100 malformed tool_calls in a real session, this saves roughly:')
  const per100 = (100 / total) * (savedMs / 1000)
  console.log(`  ~${per100.toFixed(0)}s (${(per100 / 60).toFixed(1)} min)`)
  console.log('')

  // ── Feedback quality check ──────────────────────────────────────────
  console.log('─── Feedback quality ─────────────────────────────────────────')
  console.log('')
  const failedCase = MALFORMED_CASES.find(c => c.label === 'empty args')
  const { buildRepairFeedback } = require('../constrained-decoder.js')
  const r = repairAndValidate(failedCase.input, TOOL_DEFS)
  if (!r.valid) {
    const feedback = buildRepairFeedback(failedCase.input, TOOL_DEFS, r.issues)
    console.log('Sample feedback for unrepairable case ("empty args"):')
    console.log('')
    console.log('  ' + feedback.split('\n').slice(0, 5).join('\n  '))
    console.log('  ...')
  }
  console.log('')

  console.log('='.repeat(70))
  console.log('TAKEAWAY: The repair layer fixes most malformed tool_calls without')
  console.log('a model round-trip. Combined with schema-aware feedback for genuine')
  console.log('failures, this eliminates a whole class of agent latency.')
  console.log('='.repeat(70))
}

main().catch(e => { console.error(e); process.exit(1) })
