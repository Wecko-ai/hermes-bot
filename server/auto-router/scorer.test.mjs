import { describe, expect, it } from 'vitest'
import { allowedForSpend, estimateTokenCost, isStrictlyFree, normalizeCandidate, pickModel, scoreCandidates } from './scorer.mjs'

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

  it('keeps zero-cost SambaNova, Cloudflare, NVIDIA, local and OpenRouter :free', () => {
    const priced = {
      models: {
        'sambanova/gemma-4-31B-it': { costPerMToken: { in: 0, out: 0 } },
        'sambanova/paid': { costPerMToken: { in: 0.2, out: 0.4 } },
        'cloudflare/@cf/meta/llama-3.1-8b-instruct-fp8-fast': { costPerMToken: { in: 0, out: 0 } },
      },
    }
    expect(isStrictlyFree({ provider: 'sambanova', model: 'gemma-4-31B-it' }, priced)).toBe(true)
    expect(isStrictlyFree({ provider: 'custom:sambanova', model: 'gemma-4-31B-it' }, priced)).toBe(true)
    expect(isStrictlyFree({ provider: 'sambanova', model: 'paid' }, priced)).toBe(false)
    expect(isStrictlyFree({ provider: 'cloudflare', model: '@cf/meta/llama-3.1-8b-instruct-fp8-fast' }, priced)).toBe(true)
    expect(isStrictlyFree({ provider: 'custom:cloudflare', model: '@cf/meta/llama-3.1-8b-instruct-fp8-fast' }, priced)).toBe(true)
    expect(isStrictlyFree({ provider: 'nvidia', model: 'z-ai/glm-5.3' }, priced)).toBe(true)
    expect(isStrictlyFree({ provider: 'omlx', model: 'qwen-local' }, priced)).toBe(true)
    expect(isStrictlyFree({ provider: 'openrouter', model: 'z-ai/glm-5.2:free' }, priced)).toBe(true)
    expect(isStrictlyFree({ provider: 'openrouter', model: 'anthropic/claude-opus-5.5' }, priced)).toBe(false)
    expect(isStrictlyFree({ provider: 'cursor', model: 'cursor/claude-opus-5-5', free: true }, priced)).toBe(false)
    expect(isStrictlyFree({ provider: 'gemini', model: 'gemini-3.8-flash' }, priced)).toBe(false)
    expect(normalizeCandidate({ provider: 'cloudflare', model: '@cf/meta/llama-3.1-8b-instruct-fp8-fast' })?.fullModel)
      .toBe('cloudflare/@cf/meta/llama-3.1-8b-instruct-fp8-fast')
    expect(normalizeCandidate({ provider: 'openrouter', model: 'z-ai/glm-5.2:free' })).not.toBeNull()
    expect(normalizeCandidate({ provider: 'nvidia', model: '../secret' })).toBeNull()
    expect(normalizeCandidate({ provider: 'nvidia', model: 'bad id' })).toBeNull()
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

  it('diversifies fallbacks across providers and includes a free fallback behind subscriptions', () => {
    const rich = {
      weights: { quality: 1, cost: 0, quota: 0, latency: 0 },
      models: {
        'kimi-coding/k3.1-pro': { quality: { coding: 0.96 }, costPerMToken: { in: 0, out: 0 } },
        'kimi-coding/kimi-for-coding': { quality: { coding: 0.92 }, costPerMToken: { in: 0, out: 0 } },
        'cursor/cursor/grok-4.7': { quality: { coding: 0.9 }, costPerMToken: { in: 0, out: 0 } },
        'cursor/cursor/composer-2.5': { quality: { coding: 0.88 }, costPerMToken: { in: 0, out: 0 } },
        'nvidia/moonshotai/kimi-k3': { quality: { coding: 0.86 }, costPerMToken: { in: 0, out: 0 } },
      },
    }
    const candidates = [
      { provider: 'kimi-coding', model: 'k3.1-pro' },
      { provider: 'kimi-coding', model: 'kimi-for-coding' },
      { provider: 'cursor', model: 'cursor/grok-4.7' },
      { provider: 'cursor', model: 'cursor/composer-2.5' },
      { provider: 'nvidia', model: 'moonshotai/kimi-k3' },
    ]
    const scored = scoreCandidates({ table: rich, category: 'coding', candidates, quotaPercents: new Map() })
    const picked = pickModel(scored, { table: rich })
    expect(picked.chosen).toBe('kimi-coding/k3.1-pro')
    expect(picked.fallbacks.map((row) => row.fullId)).toEqual([
      'cursor/cursor/grok-4.7',
      'nvidia/moonshotai/kimi-k3',
    ])
  })
})