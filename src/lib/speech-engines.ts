// Speech output of the voice mode: where the bot's reply is spoken.
// - Desktop: the native helper of the Electron shell plays the Mac's own voices and reports levels;
//   no audio reaches the page.
// - Browser (`npm run dev` in a plain browser): `speechSynthesis`, with levels simulated from word boundaries.
// - Fake (unit tests, `?demo=1`): nothing is played, events are scripted.

export type SpeechVoice = HermesBotSpeechVoice
export type SpeechEvent = HermesBotSpeechEvent

export interface SpeechUtterance {
  id: number
  text: string
  /** Voice identifier; empty: the system voice of the language. */
  voice?: string
  /** BCP 47, e.g. `fr-FR`, `en-GB`. */
  language: string
  /** Multiplier of the normal rate, 0.5 to 2. */
  rate?: number
}

export interface SpeechEngine {
  voices: () => Promise<SpeechVoice[]>
  /** `false`: refused (too long, microphone open, nothing to speak with). */
  say: (utterance: SpeechUtterance) => Promise<boolean>
  stop: () => Promise<void>
  onEvent: (listener: (event: SpeechEvent) => void) => () => void
}

export const BAND_COUNT = 12

// ── Desktop ──────────────────────────────────────────────────────────────────

export type SpeechBridge = NonNullable<NonNullable<Window['hermesBot']>['speech']>

export class DesktopSpeechEngine implements SpeechEngine {
  constructor(private readonly bridge: SpeechBridge) {}
  voices() { return this.bridge.voices().catch(() => []) }
  say(utterance: SpeechUtterance) { return this.bridge.say(utterance).catch(() => false) }
  stop() { return this.bridge.stop().catch(() => {}) }
  onEvent(listener: (event: SpeechEvent) => void) { return this.bridge.onEvent(listener) }
}

// ── Shared: an emitter and simulated levels ──────────────────────────────────

class Emitter {
  private readonly listeners = new Set<(event: SpeechEvent) => void>()
  on(listener: (event: SpeechEvent) => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  emit(event: SpeechEvent) {
    for (const listener of [...this.listeners]) listener(event)
  }
}

/** Speech-like levels for engines that cannot measure their audio: syllables beating, a formant shape. */
export function simulatedLevel(tick: number, energy = 1): { rms: number; bands: number[] } {
  const syllable = Math.abs(Math.sin(tick * 0.85)) * (0.65 + 0.35 * Math.sin(tick * 0.31))
  const rms = Math.min(1, Math.max(0, (0.18 + 0.62 * syllable) * energy))
  const bands = Array.from({ length: BAND_COUNT }, (_, band) => {
    // Most energy in the low-mid bands, a little sparkle higher up.
    const shape = Math.exp(-((band - 3.2) ** 2) / 9) + 0.25 * Math.exp(-((band - 8) ** 2) / 4)
    const wobble = 0.75 + 0.25 * Math.sin(tick * 0.6 + band * 1.7)
    return Math.round(Math.min(1, rms * shape * wobble * 1.15) * 1000) / 1000
  })
  return { rms: Math.round(rms * 1000) / 1000, bands }
}

// ── Browser ──────────────────────────────────────────────────────────────────

export class BrowserSpeechEngine implements SpeechEngine {
  private readonly emitter = new Emitter()
  private readonly queue: SpeechUtterance[] = []
  private current: { id: number; timer: ReturnType<typeof setInterval>; utterance: SpeechSynthesisUtterance } | null = null

  async voices(): Promise<SpeechVoice[]> {
    return speechSynthesis.getVoices()
      .filter((voice) => /^(fr|en)/i.test(voice.lang))
      .map((voice) => ({ id: voice.voiceURI, name: voice.name, language: voice.lang.replace('_', '-'), quality: 'default' as const }))
  }

  async say(utterance: SpeechUtterance) {
    if (!utterance.text.trim() || utterance.text.length > 4000) return false
    this.queue.push(utterance)
    if (!this.current) this.next()
    return true
  }

  private next() {
    const item = this.queue.shift()
    if (!item) return
    const spoken = new SpeechSynthesisUtterance(item.text)
    spoken.lang = item.language
    spoken.rate = item.rate ?? 1
    const voice = speechSynthesis.getVoices().find((candidate) => candidate.voiceURI === item.voice)
    if (voice) spoken.voice = voice
    let tick = 0
    const timer = setInterval(() => {
      tick += 1
      this.emitter.emit({ type: 'level', id: item.id, ...simulatedLevel(tick) })
    }, 33)
    this.current = { id: item.id, timer, utterance: spoken }
    spoken.onstart = () => this.emitter.emit({ type: 'start', id: item.id })
    const finish = (interrupted: boolean) => {
      if (this.current?.utterance !== spoken) return
      clearInterval(timer)
      this.current = null
      this.emitter.emit({ type: 'end', id: item.id, interrupted })
      this.next()
    }
    spoken.onend = () => finish(false)
    spoken.onerror = () => finish(true)
    speechSynthesis.speak(spoken)
  }

  async stop() {
    this.queue.length = 0
    const current = this.current
    if (!current) return
    clearInterval(current.timer)
    this.current = null
    speechSynthesis.cancel()
    this.emitter.emit({ type: 'end', id: current.id, interrupted: true })
  }

  onEvent(listener: (event: SpeechEvent) => void) { return this.emitter.on(listener) }
}

// ── Fake ─────────────────────────────────────────────────────────────────────

export interface FakeSpeechOptions {
  voices?: SpeechVoice[]
  /** Spoken time per character; `null`: an utterance only ends when a test calls `finish`. */
  msPerChar?: number | null
  levelEveryMs?: number
  /** `say` answers `false` (as when the microphone is open). */
  refuse?: boolean
}

export const DEMO_VOICES: SpeechVoice[] = [
  { id: 'demo.en-GB.daniel', name: 'Daniel', language: 'en-GB', quality: 'enhanced' },
  { id: 'demo.fr-FR.thomas', name: 'Thomas', language: 'fr-FR', quality: 'enhanced' },
]

export class FakeSpeechEngine implements SpeechEngine {
  readonly said: SpeechUtterance[] = []
  stopCalls = 0
  refuse: boolean
  private readonly emitter = new Emitter()
  private readonly queue: SpeechUtterance[] = []
  private current: SpeechUtterance | null = null
  private readonly msPerChar: number | null
  private readonly levelEveryMs: number
  private readonly voiceList: SpeechVoice[]
  private levels: ReturnType<typeof setInterval> | undefined
  private ending: ReturnType<typeof setTimeout> | undefined

  constructor(options: FakeSpeechOptions = {}) {
    this.voiceList = options.voices ?? DEMO_VOICES
    this.msPerChar = options.msPerChar === undefined ? 45 : options.msPerChar
    this.levelEveryMs = options.levelEveryMs ?? 33
    this.refuse = options.refuse ?? false
  }

  get speaking() { return this.current !== null }
  get currentId() { return this.current?.id ?? null }

  async voices() { return this.voiceList }

  async say(utterance: SpeechUtterance) {
    if (this.refuse || !utterance.text.trim() || utterance.text.length > 4000) return false
    this.said.push(utterance)
    this.queue.push(utterance)
    if (!this.current) this.next()
    return true
  }

  private next() {
    const item = this.queue.shift()
    if (!item) return
    this.current = item
    this.emitter.emit({ type: 'start', id: item.id })
    let tick = 0
    this.levels = setInterval(() => {
      tick += 1
      this.emitter.emit({ type: 'level', id: item.id, ...simulatedLevel(tick) })
    }, this.levelEveryMs)
    if (this.msPerChar !== null) this.ending = setTimeout(() => this.finish(), Math.max(200, item.text.length * this.msPerChar))
  }

  /** Ends the current utterance normally (tests with `msPerChar: null`). */
  finish() {
    const item = this.current
    if (!item) return
    this.clearTimers()
    this.current = null
    this.emitter.emit({ type: 'end', id: item.id, interrupted: false })
    this.next()
  }

  async stop() {
    this.stopCalls += 1
    this.queue.length = 0
    const item = this.current
    this.clearTimers()
    this.current = null
    if (item) this.emitter.emit({ type: 'end', id: item.id, interrupted: true })
  }

  emitError(code: string, id = this.current?.id) {
    const item = this.current
    if (item && item.id === id) {
      this.clearTimers()
      this.current = null
    }
    this.emitter.emit({ type: 'error', id, code })
    if (item && item.id === id) this.next()
  }

  onEvent(listener: (event: SpeechEvent) => void) { return this.emitter.on(listener) }

  private clearTimers() {
    clearInterval(this.levels)
    clearTimeout(this.ending)
  }
}

// ── Choice ───────────────────────────────────────────────────────────────────

/** `null`: nothing can speak here, the interface shows no voice button. */
export function createSpeechEngine({ demo }: { demo: boolean }): SpeechEngine | null {
  if (demo) return new FakeSpeechEngine()
  const bridge = typeof window === 'undefined' ? undefined : window.hermesBot?.speech
  if (bridge) return new DesktopSpeechEngine(bridge)
  if (typeof window !== 'undefined' && window.hermesBot?.platform !== 'electron' && 'speechSynthesis' in window) return new BrowserSpeechEngine()
  return null
}
