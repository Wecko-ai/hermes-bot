import { describe, expect, it } from 'vitest'
import { autoCompactionPoint, blocksSending, clampGauge, compactingTokens, evaluateGuard, limitTokens, parseCompressResult, showsWarning, snoozeFor } from './compaction'
import { parseSettings } from './settings'

const usage = (contextUsed: number, contextMax = 1_000_000) => ({ contextUsed, contextMax })

describe('compaction du contexte : maths de la jauge', () => {
  it('turns a gauge into tokens of the model window', () => {
    expect(limitTokens(1_000_000, 0.5)).toBe(500_000)
    expect(limitTokens(200_000, 0.1)).toBe(20_000)
    expect(limitTokens(1_000_000, 7)).toBe(1_000_000)
    expect(clampGauge(0.03)).toBe(0.1)
    expect(clampGauge(Number.NaN)).toBe(1)
  })
  it('guards only in manual mode, with numbers', () => {
    expect(evaluateGuard('auto', 0.5, usage(900_000)).level).toBe('off')
    expect(evaluateGuard('manual', 0.5, null).level).toBe('off')
    expect(evaluateGuard('manual', 0.5, usage(1, 0)).level).toBe('off')
  })
  it('is ok under 90 % of the limit, warns from 90 %, blocks from 100 %', () => {
    expect(evaluateGuard('manual', 0.5, usage(449_999)).level).toBe('ok')
    expect(evaluateGuard('manual', 0.5, usage(450_000)).level).toBe('warn')
    const warn = evaluateGuard('manual', 0.5, usage(460_000))
    expect(warn).toMatchObject({ level: 'warn', limit: 500_000, percent: 92 })
    expect(evaluateGuard('manual', 0.5, usage(499_999)).level).toBe('warn')
    expect(evaluateGuard('manual', 0.5, usage(500_000)).level).toBe('full')
    expect(evaluateGuard('manual', 0.5, usage(512_000)).percent).toBe(102)
  })
  it('a 100 % gauge still warns at 90 % of the window and blocks at the end of it', () => {
    expect(evaluateGuard('manual', 1, usage(900_000)).level).toBe('warn')
    expect(blocksSending(evaluateGuard('manual', 1, usage(1_000_000)))).toBe(true)
    expect(blocksSending(evaluateGuard('manual', 1, usage(999_000)))).toBe(false)
  })
})

describe('compaction du contexte : « Plus tard »', () => {
  const warn = evaluateGuard('manual', 0.5, usage(460_000))
  const full = evaluateGuard('manual', 0.5, usage(520_000))
  it('shows the warning, then hides it after Later for this conversation', () => {
    expect(showsWarning(warn, null, 'orion', 2)).toBe(true)
    const later = snoozeFor('orion', 2)
    expect(showsWarning(warn, later, 'orion', 2)).toBe(false)
  })
  it('shows it again after a compaction (the count moves) and in another conversation', () => {
    const later = snoozeFor('orion', 2)
    expect(showsWarning(warn, later, 'orion', 3)).toBe(true)
    expect(showsWarning(warn, later, 'nova', 2)).toBe(true)
    expect(showsWarning(warn, snoozeFor('orion', undefined), 'orion', undefined)).toBe(false)
  })
  it('never hides the limit: it is not a warning', () => {
    expect(showsWarning(full, snoozeFor('orion', 2), 'orion', 2)).toBe(false)
    expect(blocksSending(full)).toBe(true)
  })
})

describe('compaction du contexte : notices et résultats de Hermes', () => {
  it('reads the token count of the live notice', () => {
    expect(compactingTokens('📦 Preflight compression: ~61,760 tokens >= 60,000 threshold…')).toBe(61_760)
    expect(compactingTokens('compressing 40 messages')).toBeNull()
    expect(compactingTokens(undefined)).toBeNull()
  })
  it('reads session.compress', () => {
    const done = parseCompressResult({ status: 'compressed', before_tokens: 460_000, after_tokens: 120_000, usage: { context_tokens: 118_000, context_length: 1_000_000, compression_count: 3 } })
    expect(done).toMatchObject({ status: 'compressed', before: 460_000, after: 120_000 })
    expect(done.usage).toMatchObject({ contextUsed: 118_000, compressions: 3 })
    expect(parseCompressResult({ status: 'aborted' }).status).toBe('aborted')
    expect(parseCompressResult({ compressed: false, lock_held: true, message: 'busy' })).toMatchObject({ status: 'failed', message: 'busy' })
  })
  it('names the point where Hermes compacts a bot on its own', () => {
    expect(autoCompactionPoint({ threshold: 0.5, threshold_tokens: 200_000 }, 1_000_000)).toBe(200_000)
    expect(autoCompactionPoint({ threshold: 0.5, threshold_tokens: null }, 1_000_000)).toBe(500_000)
    expect(autoCompactionPoint({ threshold: null, threshold_tokens: null }, 200_000)).toBe(150_000)
    expect(autoCompactionPoint(undefined, 1_000_000)).toBeNull()
  })
})

describe('compaction du contexte : réglage local', () => {
  it('defaults to Auto at 100 %, and keeps a valid manual gauge', () => {
    expect(parseSettings(null)).toMatchObject({ compactionMode: 'auto', compactionGauge: 1 })
    expect(parseSettings(JSON.stringify({ compactionMode: 'manual', compactionGauge: 0.4 }))).toMatchObject({ compactionMode: 'manual', compactionGauge: 0.4 })
    expect(parseSettings(JSON.stringify({ compactionMode: 'x', compactionGauge: 9 }))).toMatchObject({ compactionMode: 'auto', compactionGauge: 1 })
  })
})
