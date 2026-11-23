import { describe, expect, it } from 'vitest'
import { candidateWindow, filterByContext, fitsContext, nearContextLimit, UNKNOWN_CONTEXT_WINDOW } from './context.mjs'

const table = {
  models: {
    'cursor/cursor/composer-2.5': { contextWindow: 200_000 },
    'cursor/cursor/gpt-5.6-sol': { contextWindow: 272_000 },
    'kimi-coding/k3.1-pro': { contextWindow: 1_048_576 },
  },
}
const row = (fullModel) => ({ provider: fullModel.split('/')[0], model: fullModel.split('/').slice(1).join('/'), fullModel })

describe('auto-router context windows', () => {
  it('keeps a quarter of the window free', () => {
    expect(fitsContext(200_000, 150_000)).toBe(true)
    expect(fitsContext(200_000, 150_001)).toBe(false)
  })

  it('uses the gateway figure for the running model when it is smaller', () => {
    const options = { table, currentModel: 'cursor/gpt-5.6-sol', contextMax: 200_000 }
    expect(candidateWindow(row('cursor/cursor/gpt-5.6-sol'), options)).toBe(200_000)
    expect(candidateWindow(row('kimi-coding/k3.1-pro'), options)).toBe(1_048_576)
    expect(candidateWindow(row('nvidia/x/unknown'), options)).toBe(UNKNOWN_CONTEXT_WINDOW)
  })

  it('drops models a 188k conversation does not fit in (the Atelier case)', () => {
    const candidates = ['cursor/cursor/composer-2.5', 'cursor/cursor/gpt-5.6-sol', 'kimi-coding/k3.1-pro'].map(row)
    const sized = filterByContext(candidates, 188_000, { table, currentModel: 'cursor/composer-2.5', contextMax: 200_000 })
    // 188k fits in 272k with a quarter free; not in Composer's 200k.
    expect(sized.candidates.map((item) => item.fullModel)).toEqual(['cursor/cursor/gpt-5.6-sol', 'kimi-coding/k3.1-pro'])
    expect(sized.excluded).toEqual(['cursor/cursor/composer-2.5'])
    expect(sized.needsCompaction).toBe(false)
  })

  it('keeps the largest window and asks for compaction when nothing fits', () => {
    const candidates = ['cursor/cursor/composer-2.5', 'cursor/cursor/gpt-5.6-sol'].map(row)
    const sized = filterByContext(candidates, 260_000, { table })
    expect(sized.candidates.map((item) => item.fullModel)).toEqual(['cursor/cursor/gpt-5.6-sol'])
    expect(sized.needsCompaction).toBe(true)
  })

  it('flags the 80 % threshold', () => {
    expect(nearContextLimit(160_000, 200_000)).toBe(true)
    expect(nearContextLimit(159_999, 200_000)).toBe(false)
  })
})
