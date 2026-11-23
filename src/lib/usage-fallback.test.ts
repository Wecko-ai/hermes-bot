import { describe, expect, it } from 'vitest'
import { usageLooksLikeFallback } from './usage-fallback'

describe('usage fallback', () => {
  it('détecte un modèle différent du profil', () => {
    expect(usageLooksLikeFallback('kimi-coding/kimi-for-coding', { model: 'kimi-coding/kimi-k3', contextUsed: 1, contextMax: 1, contextPercent: 1, averageTps: 1, inputTokens: 1, outputTokens: 0, totalTokens: 1 })).toBe(true)
    expect(usageLooksLikeFallback('kimi-coding/kimi-for-coding', { model: 'kimi-coding/kimi-for-coding', contextUsed: 1, contextMax: 1, contextPercent: 1, averageTps: 1, inputTokens: 1, outputTokens: 0, totalTokens: 1 })).toBe(false)
  })
})