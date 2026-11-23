import { describe, expect, it } from 'vitest'
import { allowedForSpend, estimateTokenCost, pickModel, scoreCandidates } from './scorer.mjs'

const table = {
  weights: { quality: 1, cost: 0.1, quota: 0.5, latency: 0.1 },
  models: {
    'example/fast-lite': { quality: { quick: 0.95, coding: 0.4 }, costPerMToken: { in: 0, out: 0 }, baselineLatencyMs: 500 },
    'example/code-strong': { quality: { quick: 0.5, coding: 0.95 }, costPerMToken: { in: 2, out: 4 }, baselineLatencyMs: 2000 },
  },
}

describe('auto-router scorer', () => {
  it('ranks by category quality', () => {
    const candidates = [
      { provider: 'example', model: 'fast-lite' },
      { provider: 'example', model: 'code-strong' },
    ]
    const scored = scoreCandidates({ table, category: 'coding', candidates, quotaPercents: new Map() })
    const picked = pickModel(scored)
    expect(picked.chosen).toBe('example/code-strong')
    expect(picked.candidates[0].score).toBeGreaterThan(0)
  })

  it('estimates token cost from the table', () => {
    expect(estimateTokenCost(table, 'example/code-strong', 1_000_000, 500_000)).toBe(4)
  })

  it('mentions high quota in the pick reason', () => {
    const candidates = [{ provider: 'kimi-coding', model: 'kimi-for-coding' }, { provider: 'anthropic', model: 'claude-sonnet-5-5' }]
    const rich = {
      ...table,
      models: {
        'kimi-coding/kimi-for-coding': { quality: { coding: 0.99 }, costPerMToken: { in: 0, out: 0 }, baselineLatencyMs: 1000 },
        'anthropic/claude-sonnet-5-5': { quality: { coding: 0.7 }, costPerMToken: { in: 0, out: 0 }, baselineLatencyMs: 1200 },
      },
    }
    const scored = scoreCandidates({ table: rich, category: 'coding', candidates, quotaPercents: new Map([['kimi-coding', 92]]) })
    const picked = pickModel(scored, { quotaPercents: new Map([['kimi-coding', 92]]) })
    expect(picked.reason).toContain('quota 92%')
    expect(picked.chosen).toBe('anthropic/claude-sonnet-5-5')
  })

  it('respects zero-spend paid block', () => {
    const option = { provider: 'paid', model: 'pro', free: false }
    const allowed = allowedForSpend(option, {
      zeroSpend: true,
      subscriptionProviders: ['sub'],
      isPaidBlocked: (o) => o.provider === 'paid',
    })
    expect(allowed).toBe(false)
  })
})