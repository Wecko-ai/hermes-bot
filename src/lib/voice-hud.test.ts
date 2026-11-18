import { describe, expect, it } from 'vitest'
import { createHudMemory, drawHud, HUD_BARS, hudTargets, shapeVoice, stepHud, withAlpha, type HudFrame } from './voice-hud'

const BANDS = [0.1, 0.9, 0.3, 0.7, 0.2, 1, 0.4, 0.6, 0.5, 0.8, 0.15, 0.35]

const frame = (overrides: Partial<HudFrame> = {}): HudFrame => ({
  state: 'idle', level: 0, bands: [], time: 0, width: 200, height: 200, dpr: 2, accent: '#ff8800', askingAccent: '#00aaff', reducedMotion: false, ...overrides,
})

describe('hudTargets', () => {
  it('has 48 values in 0..1', () => {
    for (const state of ['idle', 'listening', 'thinking', 'speaking', 'asking'] as const) {
      const targets = hudTargets(frame({ state, level: 0.7, bands: BANDS, time: 1234 }))
      expect(targets).toHaveLength(HUD_BARS)
      for (const value of targets) expect(value >= 0 && value <= 1).toBe(true)
    }
  })
  it('idle is a constant 0.04 whatever the time', () => {
    const a = hudTargets(frame({ time: 0 }))
    const b = hudTargets(frame({ time: 98765, level: 0.9 }))
    expect(a).toEqual(b)
    expect(new Set(a)).toEqual(new Set([0.04]))
  })
  it('speaking is symmetric about the vertical axis and follows the bands', () => {
    const targets = hudTargets(frame({ state: 'speaking', level: 1, bands: BANDS }))
    for (let i = 1; i < HUD_BARS; i += 1) expect(targets[i]).toBeCloseTo(targets[HUD_BARS - i], 10)
    expect(targets[0]).toBeCloseTo(BANDS[0], 5)
    expect(targets[HUD_BARS / 2]).toBeCloseTo(BANDS[BANDS.length - 1], 5)
    const louder = hudTargets(frame({ state: 'speaking', level: 1, bands: BANDS.map((b) => b * 0.5) }))
    expect(louder[5]).toBeLessThan(targets[5])
  })
  it('speaking scales with the level (0.35 floor of the gain)', () => {
    const quiet = hudTargets(frame({ state: 'speaking', level: 0, bands: BANDS }))
    const loud = hudTargets(frame({ state: 'speaking', level: 1, bands: BANDS }))
    expect(quiet[0]).toBeCloseTo(loud[0] * 0.35, 5)
  })
  it('speaking without bands still reacts to the level', () => {
    const targets = hudTargets(frame({ state: 'speaking', level: 0.8, bands: [] }))
    expect(targets.every((v) => v > 0.3)).toBe(true)
  })
  it('listening follows the level with a gentle variation', () => {
    const low = hudTargets(frame({ state: 'listening', level: 0.2, time: 500 }))
    const high = hudTargets(frame({ state: 'listening', level: 0.9, time: 500 }))
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
    expect(mean(high)).toBeGreaterThan(mean(low) * 2)
    expect(hudTargets(frame({ state: 'listening', level: 0.5, time: 500 }))).toEqual(hudTargets(frame({ state: 'listening', level: 0.5, time: 500 })))
    expect(new Set(high).size).toBeGreaterThan(1)
    expect(Math.max(...high)).toBeLessThanOrEqual(0.9)
  })
  it('thinking and asking are a low traveling wave', () => {
    for (const state of ['thinking', 'asking'] as const) {
      const a = hudTargets(frame({ state, time: 0 }))
      const b = hudTargets(frame({ state, time: 700 }))
      expect(a).not.toEqual(b)
      for (const v of [...a, ...b]) expect(v >= 0.06 - 1e-9 && v <= 0.12 + 1e-9).toBe(true)
    }
  })
  it('reduced motion quantizes to 4 steps and freezes idle, thinking and asking', () => {
    const steps = [0, 1 / 3, 2 / 3, 1]
    for (const state of ['idle', 'thinking', 'asking'] as const) {
      expect(hudTargets(frame({ state, time: 0, reducedMotion: true }))).toEqual(hudTargets(frame({ state, time: 9999, reducedMotion: true })))
    }
    for (const state of ['listening', 'speaking'] as const) {
      for (const v of hudTargets(frame({ state, level: 0.63, bands: BANDS, time: 321, reducedMotion: true }))) {
        expect(steps.some((s) => Math.abs(s - v) < 1e-9)).toBe(true)
      }
    }
  })
})

describe('stepHud', () => {
  it('converges towards the targets', () => {
    const memory = createHudMemory()
    const f = frame({ state: 'speaking', level: 1, bands: BANDS })
    // A steady voice: the automatic gain settles on its own peak.
    const target = hudTargets({ ...f, ...shapeVoice(createHudMemory(), f.level, f.bands, 16) })
    for (let t = 0; t < 2000; t += 16) stepHud(memory, { ...f, time: t })
    for (let i = 0; i < HUD_BARS; i += 1) expect(memory.bars[i]).toBeCloseTo(target[i], 2)
    expect(memory.glow).toBeCloseTo(1, 2)
  })
  it('attacks faster than it releases', () => {
    const up = createHudMemory()
    stepHud(up, frame({ state: 'speaking', level: 1, bands: BANDS, time: 0 }))
    const rise = up.bars[0] - 0
    const down = createHudMemory()
    down.bars.fill(1)
    stepHud(down, frame({ state: 'idle', time: 0 }))
    const fall = 1 - down.bars[0]
    const speaking = frame({ state: 'speaking', level: 1, bands: BANDS })
    expect(rise / hudTargets({ ...speaking, ...shapeVoice(createHudMemory(), 1, BANDS, 16) })[0]).toBeGreaterThan(fall / (1 - 0.04))
  })
  it('is frame-rate independent: two 8 ms steps equal one 16 ms step', () => {
    const f = frame({ state: 'speaking', level: 0.8, bands: BANDS })
    const one = createHudMemory()
    one.lastTime = 0
    stepHud(one, { ...f, time: 16 })
    const two = createHudMemory()
    two.lastTime = 0
    stepHud(two, { ...f, time: 8 })
    stepHud(two, { ...f, time: 16 })
    for (let i = 0; i < HUD_BARS; i += 1) expect(two.bars[i]).toBeCloseTo(one.bars[i], 6)
    expect(two.glow).toBeCloseTo(one.glow, 6)
  })
  it('caps very long gaps', () => {
    const memory = createHudMemory()
    memory.lastTime = 0
    stepHud(memory, frame({ state: 'thinking', time: 60_000 }))
    expect(memory.ringAngle).toBeCloseTo(0.35 * 0.1, 6)
  })
  it('rotates the rings only in the documented states', () => {
    const run = (state: HudFrame['state'], reducedMotion = false) => {
      const memory = createHudMemory()
      memory.lastTime = 0
      stepHud(memory, frame({ state, time: 100, reducedMotion }))
      return memory
    }
    expect(run('thinking').ringAngle).toBeCloseTo(0.035, 6)
    expect(run('asking').ringAngle).toBeCloseTo(0.035, 6)
    expect(run('thinking').tickAngle).toBeCloseTo(-0.012, 6)
    expect(run('speaking').ringAngle).toBeCloseTo(0.008, 6)
    expect(run('speaking').tickAngle).toBe(0)
    for (const state of ['idle', 'listening'] as const) {
      expect(run(state).ringAngle).toBe(0)
      expect(run(state).tickAngle).toBe(0)
    }
    for (const state of ['thinking', 'asking', 'speaking'] as const) {
      expect(run(state, true).ringAngle).toBe(0)
      expect(run(state, true).tickAngle).toBe(0)
    }
  })
  it('lets the glow fade at idle and sit at 0.08 while thinking', () => {
    const memory = createHudMemory()
    for (let t = 0; t < 3000; t += 16) stepHud(memory, frame({ state: 'thinking', time: t }))
    expect(memory.glow).toBeCloseTo(0.08, 3)
    for (let t = 3000; t < 8000; t += 16) stepHud(memory, frame({ state: 'idle', time: t }))
    expect(memory.glow).toBeCloseTo(0, 3)
  })
})

describe('withAlpha', () => {
  it('converts hex and rgb colors', () => {
    expect(withAlpha('#f80', 0.5)).toBe('rgba(255, 136, 0, 0.5)')
    expect(withAlpha('#ff8800', 1)).toBe('rgba(255, 136, 0, 1)')
    expect(withAlpha('rgb(1, 2, 3)', 0.25)).toBe('rgba(1, 2, 3, 0.25)')
    expect(withAlpha('rgba(1 2 3 / 0.9)', 0.25)).toBe('rgba(1, 2, 3, 0.25)')
  })
  it('falls back to color-mix for other syntaxes', () => {
    expect(withAlpha('hsl(20 90% 50%)', 0.4)).toBe('color-mix(in srgb, hsl(20 90% 50%) 40%, transparent)')
  })
})

interface Call { name: string; args: unknown[] }
function fakeContext() {
  const calls: Call[] = []
  const props: Record<string, unknown> = {}
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(_t, name: string) {
      if (name in props) return props[name]
      if (name === 'createRadialGradient') return (...args: unknown[]) => { calls.push({ name, args }); return { addColorStop: (...a: unknown[]) => calls.push({ name: 'addColorStop', args: a }) } }
      return (...args: unknown[]) => { calls.push({ name, args }) }
    },
    set(_t, name: string, value) { props[name] = value; calls.push({ name: `set:${name}`, args: [value] }); return true },
  })
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls }
}

describe('drawHud', () => {
  it('scales by dpr, draws 48 bars and balances save/restore', () => {
    const { ctx, calls } = fakeContext()
    const memory = createHudMemory()
    const f = frame({ state: 'speaking', level: 0.8, bands: BANDS, time: 16 })
    stepHud(memory, f)
    drawHud(ctx, memory, f)
    expect(calls.find((c) => c.name === 'setTransform')?.args).toEqual([2, 0, 0, 2, 0, 0])
    expect(calls.filter((c) => c.name === 'save')).toHaveLength(1)
    expect(calls.filter((c) => c.name === 'restore')).toHaveLength(1)
    const bars = calls.filter((c) => c.name === 'moveTo').slice(0, HUD_BARS)
    expect(bars).toHaveLength(HUD_BARS)
    expect(calls.some((c) => c.name === 'set:shadowBlur')).toBe(false)
  })
  it('leaves the avatar hole free: the glow starts at 0.34R and bars start at 0.42R', () => {
    const { ctx, calls } = fakeContext()
    const f = frame({ state: 'speaking', level: 1, bands: BANDS })
    drawHud(ctx, createHudMemory(), f)
    const R = 100 * 0.94
    const gradient = calls.find((c) => c.name === 'createRadialGradient')!
    expect(gradient.args[2]).toBeCloseTo(R * 0.34, 6)
    const firstBar = calls.find((c) => c.name === 'moveTo')!
    expect(Math.hypot((firstBar.args[0] as number) - 100, (firstBar.args[1] as number) - 100)).toBeCloseTo(R * 0.42, 6)
  })
  it('uses the asking accent for everything in asking', () => {
    const { ctx, calls } = fakeContext()
    drawHud(ctx, createHudMemory(), frame({ state: 'asking', accent: '#ff0000', askingAccent: '#0000ff' }))
    const styles = calls.filter((c) => c.name === 'set:strokeStyle').map((c) => String(c.args[0]))
    expect(styles.length).toBeGreaterThan(0)
    for (const style of styles) expect(style.startsWith('rgba(0, 0, 255')).toBe(true)
  })
  it('skips the glow at idle with no residual glow, and draws nothing for an empty canvas', () => {
    const idle = fakeContext()
    drawHud(idle.ctx, createHudMemory(), frame())
    expect(idle.calls.some((c) => c.name === 'createRadialGradient')).toBe(false)
    const none = fakeContext()
    drawHud(none.ctx, createHudMemory(), frame({ width: 0, height: 0 }))
    expect(none.calls).toHaveLength(0)
  })
})

describe('shapeVoice', () => {
  it('spreads a loud voice instead of pinning every bar to the top', () => {
    const memory = createHudMemory()
    const loud = [0.9, 0.95, 0.9, 0.98, 0.85, 0.5, 0.45, 0.4, 0.45, 0.6, 0.4, 0.35]
    const first = shapeVoice(memory, 0.92, loud, 16)
    expect(Math.max(...first.bands)).toBeCloseTo(1, 5)
    expect(Math.min(...first.bands)).toBeLessThan(0.45)
    // A quieter syllable right after: clearly lower than the peak.
    const quiet = shapeVoice(memory, 0.5, loud.map((value) => value * 0.6), 33)
    expect(Math.max(...quiet.bands)).toBeLessThan(0.45)
    expect(quiet.level).toBeLessThan(0.35)
  })

  it('lets the gain recover after a loud moment, without dividing by nothing', () => {
    const memory = createHudMemory()
    shapeVoice(memory, 1, new Array(12).fill(1), 16)
    for (let i = 0; i < 300; i += 1) shapeVoice(memory, 0.4, new Array(12).fill(0.4), 33)
    expect(shapeVoice(memory, 0.4, new Array(12).fill(0.4), 33).level).toBeGreaterThan(0.9)
    const silent = shapeVoice(createHudMemory(), 0, new Array(12).fill(0), 16)
    expect(silent.level).toBe(0)
    expect(silent.bands.every((value) => value === 0)).toBe(true)
  })
})
