import { describe, expect, it } from 'vitest'
import { autoCompactKey, fallbackRouteId, nearAutoLimit, parseModelFallback, shouldCheckAutoCompact } from './auto-context'

describe('auto context', () => {
  it('reads Hermes\'s fallback notice', () => {
    const fallback = parseModelFallback('⚠️ Model fallback: cursor/gpt-5.6-sol via cursor unavailable (rate limit); using cursor/composer-2.5 via cursor. Primary retry eligible in ~60 s')
    expect(fallback).toEqual({ fromModel: 'cursor/gpt-5.6-sol', fromProvider: 'cursor', reason: 'rate limit', toModel: 'cursor/composer-2.5', toProvider: 'cursor' })
    expect(fallbackRouteId(fallback!)).toBe('cursor/cursor/composer-2.5')
    expect(fallbackRouteId(parseModelFallback('Model fallback: a via kimi-coding unavailable; using z-ai/glm-5.3-flash via nvidia.')!)).toBe('nvidia/z-ai/glm-5.3-flash')
    expect(parseModelFallback('Compacting 61,760 tokens')).toBeNull()
    expect(parseModelFallback(undefined)).toBeNull()
  })

  it('acts from 80 % of the running model\'s window', () => {
    expect(nearAutoLimit({ contextUsed: 188_000, contextMax: 200_000 })).toBe(true)
    expect(nearAutoLimit({ contextUsed: 159_000, contextMax: 200_000 })).toBe(false)
    expect(nearAutoLimit({ contextUsed: 160_000, contextMax: 200_000 })).toBe(true)
    expect(nearAutoLimit({ contextUsed: 10, contextMax: 0 })).toBe(false)
  })

  it('checks an idle Auto chat once per compaction count', () => {
    const usage = { contextUsed: 188_000, contextMax: 200_000, compressions: 2 }
    const base = { autoActive: true, running: false, compacting: false, sessionId: 's1', usage, lastKey: '' }
    expect(shouldCheckAutoCompact(base)).toBe(true)
    expect(shouldCheckAutoCompact({ ...base, lastKey: autoCompactKey('s1', usage) })).toBe(false)
    expect(shouldCheckAutoCompact({ ...base, lastKey: autoCompactKey('s1', { compressions: 1 }) })).toBe(true)
    expect(shouldCheckAutoCompact({ ...base, running: true })).toBe(false)
    expect(shouldCheckAutoCompact({ ...base, autoActive: false })).toBe(false)
    expect(shouldCheckAutoCompact({ ...base, usage: { ...usage, contextUsed: 100_000 } })).toBe(false)
  })
})
