import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BAND_COUNT, FakeSpeechEngine, simulatedLevel, type SpeechEvent } from './speech-engines'

describe('simulatedLevel', () => {
  it('stays within 0..1 with one value per band', () => {
    for (let tick = 0; tick < 200; tick += 1) {
      const { rms, bands } = simulatedLevel(tick)
      expect(rms).toBeGreaterThanOrEqual(0)
      expect(rms).toBeLessThanOrEqual(1)
      expect(bands).toHaveLength(BAND_COUNT)
      for (const band of bands) expect(band >= 0 && band <= 1).toBe(true)
    }
  })
})

describe('FakeSpeechEngine', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('plays utterances in order, reports levels, and ends the current one interrupted on stop', async () => {
    const engine = new FakeSpeechEngine({ msPerChar: 10, levelEveryMs: 20 })
    const events: SpeechEvent[] = []
    engine.onEvent((event) => events.push(event))
    expect(await engine.say({ id: 1, text: 'Bonjour à tous.', language: 'fr-FR' })).toBe(true)
    expect(await engine.say({ id: 2, text: 'Second sentence here.', language: 'en-GB' })).toBe(true)
    await vi.advanceTimersByTimeAsync(60)
    expect(events[0]).toEqual({ type: 'start', id: 1 })
    expect(events.some((event) => event.type === 'level' && event.id === 1)).toBe(true)
    await vi.advanceTimersByTimeAsync(200)
    expect(events).toContainEqual({ type: 'end', id: 1, interrupted: false })
    expect(events).toContainEqual({ type: 'start', id: 2 })
    await engine.stop()
    expect(events.at(-1)).toEqual({ type: 'end', id: 2, interrupted: true })
    expect(engine.speaking).toBe(false)
  })

  it('refuses empty, too long, or refused utterances', async () => {
    const engine = new FakeSpeechEngine()
    expect(await engine.say({ id: 1, text: '  ', language: 'fr-FR' })).toBe(false)
    expect(await engine.say({ id: 2, text: 'x'.repeat(4001), language: 'fr-FR' })).toBe(false)
    engine.refuse = true
    expect(await engine.say({ id: 3, text: 'Bonjour', language: 'fr-FR' })).toBe(false)
  })
})
