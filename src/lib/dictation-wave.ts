// The wave of the dictation pill: rounded vertical bars that follow the microphone level. Each step pushes the
// current level on the right and the older bars slide to the left; at silence they fall back to dots.
// With reduced motion nothing scrolls: the bars keep a fixed silhouette whose height follows the level in four steps.

export const WAVE_BAR_WIDTH = 3
export const WAVE_GAP = 3
export const WAVE_STEP_MS = 70
const CAPACITY = 160

/** A fixed, irregular silhouette: a voice, not an equalizer. */
const STILL_SHAPE = [0.45, 0.7, 0.55, 0.9, 0.65, 1, 0.6, 0.8, 0.5, 0.75]

const clamp01 = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0)

/** Number of bars that fit in `width`. */
export const barCount = (width: number) => Math.max(0, Math.floor((width + WAVE_GAP) / (WAVE_BAR_WIDTH + WAVE_GAP)))

/** Reduced motion: the level in four steps, 0 (dots) to 3. */
export const quantizeLevel = (level: number) => Math.round(clamp01(level) * 3)

export class WaveSampler {
  private readonly samples = new Array<number>(CAPACITY).fill(0)
  private head = 0
  private smooth = 0

  /** Adds one step. A light smoothing: the raw level jumps from one audio buffer to the next. */
  push(level: number) {
    this.smooth += (clamp01(level) - this.smooth) * 0.6
    this.samples[this.head] = this.smooth
    this.head = (this.head + 1) % CAPACITY
    return this.smooth
  }

  /** The `count` most recent samples, oldest first (the newest is the last one, on the right). */
  recent(count: number) {
    const n = Math.min(count, CAPACITY)
    const out: number[] = []
    for (let index = n; index >= 1; index -= 1) out.push(this.samples[(this.head - index + CAPACITY * 2) % CAPACITY])
    return out
  }
}

/** Heights (0..1 of the free height) for the still wave. */
export const stillBars = (step: number, count: number) => Array.from({ length: count }, (_, index) => (step / 3) * STILL_SHAPE[index % STILL_SHAPE.length])
