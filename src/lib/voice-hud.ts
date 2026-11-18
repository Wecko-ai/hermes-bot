// The voice HUD: concentric rings and 48 radial bars around the bot avatar, driven by the voice level.
// The maths (targets, smoothing, rotation) are pure helpers; drawHud only paints on a 2D canvas.

export type HudState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'asking'

export const HUD_BARS = 48

export interface HudMemory {
  bars: Float32Array
  ringAngle: number
  tickAngle: number
  lastTime: number | null
  glow: number
  /** Running peaks of the voice (automatic gain of `shapeVoice`). */
  voicePeak: number
  levelPeak: number
}

export interface HudFrame {
  state: HudState
  /** 0..1: microphone level while listening, voice rms while speaking. */
  level: number
  /** 12 bands 0..1 while speaking; may be empty. */
  bands: number[]
  /** Milliseconds, performance.now(). */
  time: number
  /** CSS pixel size of the canvas and the device pixel ratio. */
  width: number
  height: number
  dpr: number
  accent: string
  askingAccent: string
  reducedMotion: boolean
}

export const createHudMemory = (): HudMemory => ({ bars: new Float32Array(HUD_BARS), ringAngle: 0, tickAngle: 0, lastTime: null, glow: 0, voicePeak: 0, levelPeak: 0 })

const PEAK_HALF_LIFE_MS = 1_800
const PEAK_FLOOR = 0.3
const EXPANSION = 2.2

/**
 * A synthesized voice is loud and its low bands dominate: raw, every bar would sit near the top. Like a
 * music visualizer, the bands are tilted towards the highs, divided by a slowly decaying running peak
 * (automatic gain), then expanded so syllables and pauses stand apart.
 */
export function shapeVoice(memory: HudMemory, level: number, bands: number[], elapsedMs: number): { level: number; bands: number[] } {
  const decay = Math.pow(0.5, Math.max(0, elapsedMs) / PEAK_HALF_LIFE_MS)
  const tilted = bands.map((value, index) => clamp01(value) * (0.82 + 0.035 * index))
  memory.voicePeak = Math.max(Math.max(0, ...tilted), memory.voicePeak * decay)
  memory.levelPeak = Math.max(clamp01(level), memory.levelPeak * decay)
  const voicePeak = Math.max(PEAK_FLOOR, memory.voicePeak)
  const levelPeak = Math.max(PEAK_FLOOR, memory.levelPeak)
  return {
    level: clamp01(Math.pow(clamp01(level) / levelPeak, EXPANSION)),
    bands: tilted.map((value) => clamp01(Math.pow(value / voicePeak, EXPANSION))),
  }
}

const clamp01 = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0)
const quantize = (value: number) => Math.round(clamp01(value) * 3) / 3

const IDLE_AMPLITUDE = 0.04
const ATTACK = 0.5
const RELEASE = 0.15
const FRAME_MS = 16
const MAX_STEP_MS = 100

/** Deterministic pseudo-noise in 0..1 from a bar index and a time in seconds. */
const noise = (index: number, seconds: number) => 0.5 + 0.5 * Math.sin(index * 2.399 + seconds * 5.1) * Math.cos(index * 0.7 - seconds * 2.3)

/** Bands (any count) spread over one half circle: `points` values, from the top pole to the bottom pole. */
function halfCircle(bands: number[], points: number, fallback: number) {
  const source = bands.length ? bands : [fallback]
  return Array.from({ length: points }, (_, j) => {
    const position = points === 1 ? 0 : (j / (points - 1)) * (source.length - 1)
    const low = Math.floor(position)
    const high = Math.min(source.length - 1, low + 1)
    const mix = position - low
    return clamp01(source[low] * (1 - mix) + source[high] * mix)
  })
}

/** The 48 target amplitudes (0..1) for a state. */
export function hudTargets(frame: Pick<HudFrame, 'state' | 'level' | 'bands' | 'time' | 'reducedMotion'>): number[] {
  const { state, reducedMotion } = frame
  const level = clamp01(frame.level)
  const seconds = reducedMotion ? 0 : frame.time / 1000
  let raw: number[]
  if (state === 'speaking') {
    // Half circle from the top (index 0) to the bottom (index 24), mirrored on the left: symmetric about the vertical axis.
    const half = halfCircle(frame.bands, HUD_BARS / 2 + 1, level)
    const gain = 0.35 + 0.65 * level
    raw = Array.from({ length: HUD_BARS }, (_, i) => half[Math.min(i, HUD_BARS - i)] * gain)
  } else if (state === 'listening') {
    raw = Array.from({ length: HUD_BARS }, (_, i) => Math.max(IDLE_AMPLITUDE, level * (0.7 + 0.3 * noise(i, seconds))))
  } else if (state === 'thinking' || state === 'asking') {
    raw = Array.from({ length: HUD_BARS }, (_, i) => (reducedMotion ? 0.09 : 0.06 + 0.06 * (0.5 + 0.5 * Math.sin((i / HUD_BARS) * Math.PI * 4 - seconds * Math.PI * 1.2))))
  } else {
    raw = new Array<number>(HUD_BARS).fill(IDLE_AMPLITUDE)
  }
  return raw.map((value) => (reducedMotion ? quantize(value) : clamp01(value)))
}

/** Advances smoothing and rotation by the time elapsed since the previous frame. */
export function stepHud(memory: HudMemory, frame: HudFrame): void {
  const elapsed = memory.lastTime === null ? FRAME_MS : Math.min(MAX_STEP_MS, Math.max(0, frame.time - memory.lastTime))
  memory.lastTime = frame.time
  // Per-16 ms factors converted to the real step, so two 8 ms steps equal one 16 ms step.
  const attack = 1 - Math.pow(1 - ATTACK, elapsed / FRAME_MS)
  const release = 1 - Math.pow(1 - RELEASE, elapsed / FRAME_MS)
  const smooth = (current: number, target: number) => current + (target - current) * (target > current ? attack : release)

  const shaped = frame.state === 'speaking' ? { ...frame, ...shapeVoice(memory, frame.level, frame.bands, elapsed) } : frame
  const targets = hudTargets(shaped)
  for (let i = 0; i < HUD_BARS; i += 1) memory.bars[i] = smooth(memory.bars[i], targets[i])

  const glowTarget = frame.state === 'idle' ? 0 : frame.state === 'listening' || frame.state === 'speaking' ? clamp01(shaped.level) : 0.08
  memory.glow = smooth(memory.glow, glowTarget)

  if (frame.reducedMotion) return
  const seconds = elapsed / 1000
  const busy = frame.state === 'thinking' || frame.state === 'asking'
  const ringSpeed = busy ? 0.35 : frame.state === 'speaking' ? 0.08 : 0
  memory.ringAngle += ringSpeed * seconds
  if (busy) memory.tickAngle -= 0.12 * seconds
}

/** `color` with an alpha, whatever CSS syntax it uses. */
export function withAlpha(color: string, alpha: number): string {
  const a = Math.min(1, Math.max(0, alpha))
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())
  if (hex) {
    const digits = hex[1].length === 3 ? hex[1].replace(/./g, '$&$&') : hex[1]
    const n = parseInt(digits, 16)
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
  }
  const rgb = /^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)/i.exec(color.trim())
  if (rgb) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${a})`
  return `color-mix(in srgb, ${color} ${Math.round(a * 100)}%, transparent)`
}

const DEG = Math.PI / 180

export function drawHud(ctx: CanvasRenderingContext2D, memory: HudMemory, frame: HudFrame): void {
  const { width, height, dpr } = frame
  const color = frame.state === 'asking' ? frame.askingAccent : frame.accent
  const cx = width / 2
  const cy = height / 2
  const R = (Math.min(width, height) / 2) * 0.94
  if (!(R > 0)) return

  ctx.save()
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  ctx.lineCap = 'round'

  // Glow: one radial gradient that leaves the avatar hole untouched.
  if (frame.state !== 'idle' || memory.glow > 0.005) {
    const gradient = ctx.createRadialGradient(cx, cy, R * 0.34, cx, cy, R)
    gradient.addColorStop(0, withAlpha(color, 0.08 + 0.35 * memory.glow))
    gradient.addColorStop(1, withAlpha(color, 0))
    ctx.globalCompositeOperation = 'lighter'
    ctx.fillStyle = gradient
    ctx.beginPath()
    ctx.arc(cx, cy, R, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalCompositeOperation = 'source-over'
  }

  // Thin inner ring.
  ctx.lineWidth = 1
  ctx.strokeStyle = withAlpha(color, 0.45)
  ctx.beginPath()
  ctx.arc(cx, cy, R * 0.37, 0, Math.PI * 2)
  ctx.stroke()

  // Radial bars, from the top, clockwise.
  ctx.lineWidth = 3
  const inner = R * 0.42
  for (let i = 0; i < HUD_BARS; i += 1) {
    const amp = clamp01(memory.bars[i])
    const angle = (i / HUD_BARS) * Math.PI * 2 - Math.PI / 2
    const outer = inner + 3 + amp * R * 0.34
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    ctx.strokeStyle = withAlpha(color, 0.45 + 0.55 * amp)
    ctx.beginPath()
    ctx.moveTo(cx + cos * inner, cy + sin * inner)
    ctx.lineTo(cx + cos * outer, cy + sin * outer)
    ctx.stroke()
  }

  // Arc ring: three 80 degree arcs with gaps, each ending in a short bright cap.
  const arcRadius = R * 0.8
  ctx.lineWidth = 1.5
  ctx.strokeStyle = withAlpha(color, 0.55)
  for (let k = 0; k < 3; k += 1) {
    const start = memory.ringAngle + k * 120 * DEG
    ctx.beginPath()
    ctx.arc(cx, cy, arcRadius, start, start + 80 * DEG)
    ctx.stroke()
  }
  ctx.lineWidth = 3
  ctx.strokeStyle = withAlpha(color, 0.95)
  for (let k = 0; k < 3; k += 1) {
    const end = memory.ringAngle + k * 120 * DEG + 80 * DEG
    ctx.beginPath()
    ctx.arc(cx, cy, arcRadius, end - 8 * DEG, end)
    ctx.stroke()
  }

  // Tick ring: 72 ticks, every sixth one longer.
  const tickRadius = R * 0.93
  ctx.lineWidth = 1
  ctx.strokeStyle = withAlpha(color, 0.35)
  ctx.beginPath()
  for (let i = 0; i < 72; i += 1) {
    const angle = memory.tickAngle + (i / 72) * Math.PI * 2
    const length = i % 6 === 0 ? 8 : 4
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    ctx.moveTo(cx + cos * (tickRadius - length), cy + sin * (tickRadius - length))
    ctx.lineTo(cx + cos * tickRadius, cy + sin * tickRadius)
  }
  ctx.stroke()

  ctx.restore()
}
