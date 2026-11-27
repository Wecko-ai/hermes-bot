import { describe, expect, it } from 'vitest'
import { DEFAULT_TARGET, botTarget, evaluateBotBudget, sanitizeBotBudgets } from './bot-budget.mjs'

// Generic ids only: the real per-bot targets live in the private config.
const targets = { 'bot-large': 15_000_000, 'bot-mid': 10_000_000, 'bot-small': 6_000_000 }

describe('bot-budget', () => {
  it('has per-bot soft targets with a default', () => {
    expect(botTarget('bot-large', targets)).toBe(15_000_000)
    expect(botTarget('bot-mid', targets)).toBe(10_000_000)
    expect(botTarget('bot-small', targets)).toBe(6_000_000)
    expect(botTarget('unknown-bot', targets)).toBe(3_000_000)
    expect(botTarget('', targets)).toBe(3_000_000)
  })

  it('falls back to the default target with no configured targets', () => {
    expect(botTarget('bot-large')).toBe(DEFAULT_TARGET)
    expect(botTarget('bot-large', null)).toBe(DEFAULT_TARGET)
    expect(botTarget('constructor', {})).toBe(DEFAULT_TARGET)
  })

  it('sanitizes configured budgets', () => {
    expect(sanitizeBotBudgets({ ' a ': 5_000_000.9, b: 0, c: -1, d: 'x', e: '2000000' })).toEqual({ a: 5_000_000, e: 2_000_000 })
    expect(sanitizeBotBudgets(null)).toEqual({})
    expect(sanitizeBotBudgets([1, 2])).toEqual({})
  })

  it('reports ok below 70%', () => {
    const r = evaluateBotBudget({ botId: 'bot-mid', dailyTokens: 6_999_999, interactive: false, targets })
    expect(r.level).toBe('ok')
    expect(r.alert).toBe(false)
    expect(r.downgrade).toBe(false)
    expect(r.pct).toBeGreaterThan(0.69)
    expect(r.pct).toBeLessThan(0.70)
  })

  it('warns at 70-85% without downgrading', () => {
    const r = evaluateBotBudget({ botId: 'bot-mid', dailyTokens: 7_000_000, interactive: false, targets })
    expect(r.level).toBe('warn_70')
    expect(r.alert).toBe(true)
    expect(r.downgrade).toBe(false)
    expect(r.pct).toBeCloseTo(0.70, 5)
  })

  it('does not warn below 85% for interactive at 84%', () => {
    const r = evaluateBotBudget({ botId: 'bot-mid', dailyTokens: 8_499_999, interactive: true, targets })
    expect(r.level).toBe('warn_70')
    expect(r.downgrade).toBe(false)
  })

  it('downgrades non-interactive at >= 85%', () => {
    const r = evaluateBotBudget({ botId: 'bot-mid', dailyTokens: 8_500_000, interactive: false, targets })
    expect(r.level).toBe('downgrade_85')
    expect(r.alert).toBe(true)
    expect(r.downgrade).toBe(true)
    expect(r.targetTier).toBe('T2_OR_T0')
  })

  it('never downgrades interactive at >= 85%', () => {
    const r = evaluateBotBudget({ botId: 'bot-mid', dailyTokens: 9_500_000, interactive: true, targets })
    expect(r.level).toBe('downgrade_85')
    expect(r.alert).toBe(true)
    expect(r.downgrade).toBe(false)
    expect(r.targetTier).toBeNull()
  })

  it('uses default target and treats missing tokens as 0', () => {
    const r = evaluateBotBudget({ botId: 'unknown', dailyTokens: undefined, interactive: false })
    expect(r.level).toBe('ok')
    expect(r.pct).toBe(0)
  })

  it('respects each bot target scale', () => {
    const r0 = evaluateBotBudget({ botId: 'bot-large', dailyTokens: 10_499_999, interactive: false, targets })
    expect(r0.level).toBe('ok') // 69.99% of 15M
    const r1 = evaluateBotBudget({ botId: 'bot-large', dailyTokens: 10_500_000, interactive: false, targets })
    expect(r1.level).toBe('warn_70')
  })
})
