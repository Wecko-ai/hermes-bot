import { describe, expect, it } from 'vitest'
import { formatUsage, modelLabel } from './model'

describe('modèles et usage', () => {
  it('raccourcit les noms de modèles', () => {
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5')
    expect(modelLabel('deepseek/deepseek-v4-flash')).toBe('deepseek-v4-flash')
    expect(modelLabel('kimi-k3')).toBe('kimi-k3')
  })

  it('affiche le contexte et le débit, ou des tirets sans donnée', () => {
    expect(formatUsage(null)).toBe('Contexte — · — tok/s')
    expect(formatUsage({ contextUsed: 41_000, contextMax: 1_000_000, contextPercent: 4.1, averageTps: 62.6, inputTokens: 0, outputTokens: 0, totalTokens: 0 }))
      .toBe('Contexte 4 % (41k/1M) · 63 tok/s')
  })
})
