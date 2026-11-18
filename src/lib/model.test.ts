import { describe, expect, it } from 'vitest'
import { chipModelLabel, formatUsage, modelLabel } from './model'

describe('modèles et usage', () => {
  it('raccourcit les noms de modèles', () => {
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5')
    expect(modelLabel('claude-fable-5-2')).toBe('Fable 5.2')
    expect(modelLabel('claude-fable-5.1')).toBe('Fable 5.1')
    expect(modelLabel('claude-opus-4-20250514')).toBe('Opus 4')
    expect(modelLabel('claude-opus-4-5-20251101')).toBe('Opus 4.5')
    expect(modelLabel('deepseek/deepseek-v4-flash')).toBe('DeepSeek V4 Flash')
    expect(modelLabel('kimi-k3')).toBe('Kimi K3')
    expect(modelLabel('k3.1-pro')).toBe('K3.1 Pro')
  })

  it('dit Cursor dans la pastille du champ, pas dans les lignes du sélecteur', () => {
    expect(modelLabel('cursor/claude-sonnet-5-5')).toBe('Sonnet 5.5')
    expect(chipModelLabel('cursor/claude-sonnet-5-5')).toBe('Sonnet 5.5 · Cursor')
    expect(chipModelLabel('cursor/gpt-5.6-sol')).toBe('GPT Sol 5.6 · Cursor')
    expect(chipModelLabel('claude-sonnet-5-5')).toBe('Sonnet 5.5')
    expect(chipModelLabel('openrouter/anthropic/claude-sonnet-5.5')).toBe('Sonnet 5.5')
  })

  it('affiche le contexte et le débit, ou des tirets sans donnée', () => {
    expect(formatUsage(null)).toBe('Contexte — · — tok/s')
    expect(formatUsage({ contextUsed: 41_000, contextMax: 1_000_000, contextPercent: 4.1, averageTps: 62.6, inputTokens: 0, outputTokens: 0, totalTokens: 0 }))
      .toBe('Contexte 4 % (41k/1M) · 63 tok/s')
  })
})
