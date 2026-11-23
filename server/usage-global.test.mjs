import { describe, expect, it } from 'vitest'
import { aggregateAnalytics, estimateQuotas, profilesFromQuery } from './usage-global.mjs'

describe('usage-global', () => {
  it('agrège les profils et les modèles', () => {
    const summary = aggregateAnalytics([
      {
        profile: 'orion',
        body: {
          totals: { total_input: 100, total_output: 10, total_sessions: 1, total_api_calls: 2, total_estimated_cost: 0.1 },
          daily: [{ day: '2026-11-22', input_tokens: 100, output_tokens: 10, estimated_cost: 0.1 }],
          by_model: [{ model: 'kimi-coding/kimi-for-coding', input_tokens: 100, output_tokens: 10, estimated_cost: 0.1 }],
        },
      },
      {
        profile: 'nova',
        body: {
          totals: { total_input: 50, total_output: 5, total_sessions: 2, total_api_calls: 1, total_estimated_cost: 0.05 },
          daily: [{ day: '2026-11-22', input_tokens: 50, output_tokens: 5, estimated_cost: 0.05 }],
          by_model: [{ model: 'custom:cursor/cursor/auto', input_tokens: 50, output_tokens: 5, estimated_cost: 0.05 }],
        },
      },
    ], 30)
    expect(summary.inputTokens).toBe(150)
    expect(summary.bots).toHaveLength(2)
    expect(summary.models).toHaveLength(2)
    expect(summary.daily[0].tokens).toBe(165)
  })

  it('estime les quotas par préfixe de modèle', () => {
    const summary = aggregateAnalytics([{
      profile: 'atlas',
      body: {
        totals: { total_input: 40_000, total_output: 1_000 },
        daily: [{ day: '2026-11-22', input_tokens: 40_000, output_tokens: 1_000 }],
        by_model: [{ model: 'kimi-coding/kimi-for-coding', input_tokens: 40_000, output_tokens: 1_000 }],
      },
    }], 30)
    const gauges = estimateQuotas(summary, [{
      id: 'kimi-coding',
      label: 'Kimi',
      windowHours: 5,
      tokenLimit: 100_000,
      modelPrefixes: ['kimi-coding'],
    }], new Date('2026-11-22T12:00:00Z'))
    expect(gauges[0].usedTokens).toBe(41_000)
    expect(gauges[0].usedPercent).toBeCloseTo(41)
  })

  it('filtre les slugs de profils', () => {
    expect(profilesFromQuery('orion, bad slug, nova')).toEqual(['orion', 'nova'])
  })
})