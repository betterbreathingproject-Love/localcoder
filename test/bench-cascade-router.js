'use strict'

/**
 * Benchmark: Cascade Router
 *
 * Simulates typical agent workload distribution and measures how the cascade
 * router reduces overall compute by routing simple tasks to smaller models.
 *
 * Run: node test/bench-cascade-router.js
 */

const { CascadeRouter } = require('../cascade-router.js')

const TIERS = {
  0: { model: 'fast-0.8b', ms_per_response: 800 },
  1: { model: 'mid-4b', ms_per_response: 3000 },
  2: { model: 'primary-35b', ms_per_response: 18000 },
}

/**
 * Simulated agent tasks — a mix of real-world workloads.
 * Each entry: role, difficulty (0=easy, 2=hard), description.
 */
const WORKLOAD = [
  // Tier 0-suitable (~70% of agent dispatches in real codebases)
  { role: 'code-search', difficulty: 0, desc: 'find function definition' },
  { role: 'code-search', difficulty: 0, desc: 'grep for pattern' },
  { role: 'context-gather', difficulty: 0, desc: 'list files matching spec' },
  { role: 'context-gather', difficulty: 0, desc: 'gather imports' },
  { role: 'code-search', difficulty: 0, desc: 'find references' },
  { role: 'code-search', difficulty: 1, desc: 'analyze symbol usage tree' },
  { role: 'general', difficulty: 0, desc: 'simple lookup' },

  // Tier 1-suitable (~20%)
  { role: 'explore', difficulty: 1, desc: 'analyze module architecture' },
  { role: 'requirements', difficulty: 1, desc: 'list acceptance criteria' },
  { role: 'design', difficulty: 1, desc: 'propose interface' },
  { role: 'explore', difficulty: 2, desc: 'full codebase investigation' },

  // Tier 2 (primary-only) (~10%)
  { role: 'implementation', difficulty: 2, desc: 'write new feature' },
  { role: 'debug', difficulty: 2, desc: 'fix bug' },
  { role: 'tester', difficulty: 2, desc: 'run integration test' },
]

/**
 * Simulate model response quality by difficulty × tier.
 * Higher tier + matching difficulty = clean commit.
 * Lower tier on hard task = low confidence or empty response.
 */
function simulateResponse(role, difficulty, tier) {
  // Primary-only roles always escalate to tier 2 immediately
  const primaryOnly = ['implementation', 'debug', 'tester']
  if (primaryOnly.includes(role)) {
    return {
      tool_calls: [{ function: { name: 'write_file', arguments: '{"path":"x"}' } }],
      finish_reason: 'tool_calls',
    }
  }

  if (tier >= difficulty) {
    // Tier is sufficient — produce a useful response
    const isActionRole = ['code-search', 'context-gather'].includes(role)
    if (isActionRole) {
      return {
        tool_calls: [{ function: { name: 'read_file', arguments: '{"path":"x.js"}' } }],
        finish_reason: 'tool_calls',
      }
    }
    return {
      content: 'Thoughtful response at the right tier.',
      finish_reason: 'stop',
      logprobs: {
        content: [
          { top_logprobs: [{ logprob: -0.1 }, { logprob: -5.0 }] },
          { top_logprobs: [{ logprob: -0.15 }, { logprob: -4.5 }] },
        ],
      },
    }
  } else {
    // Tier too low — either empty or low-confidence text
    if (Math.random() < 0.5) {
      return { content: null, tool_calls: null, finish_reason: 'stop' }
    }
    return {
      content: 'I think maybe... it could be...',
      finish_reason: 'stop',
      logprobs: {
        content: [
          { top_logprobs: [{ logprob: -0.5 }, { logprob: -0.8 }] },
          { top_logprobs: [{ logprob: -0.6 }, { logprob: -0.9 }] },
        ],
      },
    }
  }
}

async function benchCascade(workload) {
  const router = new CascadeRouter({ tiers: TIERS })
  let totalMs = 0
  let totalDispatches = 0
  let escalationCount = 0
  const perTier = { 0: 0, 1: 0, 2: 0 }

  for (const task of workload) {
    let tier = router.startTier(task.role)
    let committed = false
    while (!committed) {
      totalDispatches++
      perTier[tier]++
      totalMs += TIERS[tier].ms_per_response
      const resp = simulateResponse(task.role, task.difficulty, tier)
      const decision = router.evaluate(resp, task.role, tier)
      if (decision.commit) {
        committed = true
        router.recordCommit(tier)
      } else {
        escalationCount++
        tier = decision.next_tier
      }
    }
  }

  return { totalMs, totalDispatches, escalationCount, perTier, stats: router.stats() }
}

async function benchBaseline(workload) {
  // Always dispatch to primary (tier 2)
  let totalMs = 0
  for (const _ of workload) totalMs += TIERS[2].ms_per_response
  return { totalMs, totalDispatches: workload.length }
}

async function main() {
  console.log('='.repeat(70))
  console.log('Cascade Router — Benchmark')
  console.log('='.repeat(70))
  console.log('')
  console.log('Simulated latencies per tier:')
  for (const [t, cfg] of Object.entries(TIERS)) {
    console.log(`  Tier ${t}: ${cfg.model.padEnd(12)} ${cfg.ms_per_response}ms/response`)
  }
  console.log('')
  console.log(`Workload: ${WORKLOAD.length} tasks across roles`)
  const byRole = {}
  for (const t of WORKLOAD) byRole[t.role] = (byRole[t.role] || 0) + 1
  for (const [r, n] of Object.entries(byRole)) console.log(`  ${r.padEnd(18)} ${n} task(s)`)
  console.log('')

  const baseline = await benchBaseline(WORKLOAD)
  const cascade = await benchCascade(WORKLOAD)

  console.log('─── Results ──────────────────────────────────────────────────')
  console.log('')
  console.log(`  Baseline (primary-only):  ${baseline.totalMs.toLocaleString()}ms across ${baseline.totalDispatches} dispatches`)
  console.log(`  Cascade router:           ${cascade.totalMs.toLocaleString()}ms across ${cascade.totalDispatches} dispatches`)
  console.log(`  Savings:                  ${(baseline.totalMs - cascade.totalMs).toLocaleString()}ms (${((1 - cascade.totalMs / baseline.totalMs) * 100).toFixed(1)}%)`)
  console.log('')
  console.log(`  Tier distribution after cascade:`)
  console.log(`    Tier 0 (fast): ${cascade.perTier[0]} dispatches`)
  console.log(`    Tier 1 (mid):  ${cascade.perTier[1]} dispatches`)
  console.log(`    Tier 2 (big):  ${cascade.perTier[2]} dispatches`)
  console.log('')
  console.log(`  Escalations: ${cascade.escalationCount} (${((cascade.escalationCount / WORKLOAD.length) * 100).toFixed(0)}% of tasks escalated at least once)`)
  console.log('')

  console.log('─── Wall-clock impact ────────────────────────────────────────')
  console.log('')
  const savedSeconds = (baseline.totalMs - cascade.totalMs) / 1000
  console.log(`  Per workload run: saves ~${savedSeconds.toFixed(1)}s`)
  console.log(`  If this workload runs 10x/day: saves ~${(savedSeconds * 10 / 60).toFixed(1)}min/day`)
  console.log('')

  console.log('='.repeat(70))
  console.log('TAKEAWAY: Cascade routing gives the biggest win on workloads')
  console.log('dominated by simple dispatch tasks (code-search, context-gather).')
  console.log('A 35B forward pass on a task a 0.8B could answer is pure waste.')
  console.log('='.repeat(70))
}

main().catch(e => { console.error(e); process.exit(1) })
