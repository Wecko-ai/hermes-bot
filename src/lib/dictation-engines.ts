import {
  MISSING_LOCALE,
  preferredLocaleId,
  type DictationAccess,
  type DictationEngine,
  type DictationListenOptions,
  type DictationLocale,
  type DictationSink,
} from './dictation'

// ── Desktop: the speech helper of the Electron shell ─────────────────────────

/** What the Electron shell exposes as `window.hermesBot.dictation` (declared in `desktop.d.ts`). */
export type DictationBridge = NonNullable<NonNullable<Window['hermesBot']>['dictation']>
export type DictationBridgeEvent = Parameters<Parameters<DictationBridge['onEvent']>[0]>[0]

type Prepared = Awaited<ReturnType<DictationBridge['prepare']>>

export class DesktopDictationEngine implements DictationEngine {
  private prepared: { localeId: string; result: Prepared } | null = null
  private unsubscribe: (() => void) | null = null

  constructor(private readonly bridge: DictationBridge, private readonly languageCode: () => string) {}

  private async prepare(localeId: string) {
    if (this.prepared?.localeId === localeId) return this.prepared.result
    const result = await this.bridge.prepare(localeId)
    this.prepared = { localeId, result }
    return result
  }

  async initialize(): Promise<DictationAccess> {
    // One call asks for the permissions and probes the language; `resolveLocale` reuses its answer.
    this.prepared = null
    const { access, microphone } = await this.prepare(preferredLocaleId(this.languageCode()))
    if (access !== 'granted') return access
    return microphone ? 'granted' : 'noMicrophone'
  }

  async resolveLocale(languageCode: string): Promise<DictationLocale> {
    const localeId = preferredLocaleId(languageCode)
    const result = await this.prepare(localeId)
    if (!result.exists) return MISSING_LOCALE
    return { localeId, onDevice: result.onDevice, serverReachable: result.available }
  }

  async listen({ localeId, onDevice, listenForMs, pauseForMs, sink }: DictationListenOptions): Promise<boolean> {
    this.release()
    const unsubscribe = this.bridge.onEvent((event) => this.dispatch(event, sink))
    this.unsubscribe = unsubscribe
    try {
      const started = await this.bridge.start({ localeId, onDevice, listenForMs, pauseForMs })
      if (!started && this.unsubscribe === unsubscribe) this.release()
      return started
    } catch (error) {
      if (this.unsubscribe === unsubscribe) this.release()
      throw error
    }
  }

  private dispatch(event: DictationBridgeEvent, sink: DictationSink) {
    switch (event.type) {
      case 'words': return sink.onWords(event.text, event.final)
      case 'level': return sink.onLevel(event.value)
      case 'audioEnd': return sink.onAudioEnd()
      case 'error': return sink.onError(event.code || 'error_listen_failed')
      case 'done':
        this.release()
        return sink.onDone()
    }
  }

  private release() {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  async stop() {
    await this.bridge.stop()
  }

  async cancel() {
    this.release()
    await this.bridge.cancel()
  }
}

// ── Browser: the Web Speech API (`npm run dev`, a plain browser) ─────────────

/** Minimal shape of `SpeechRecognition`, which TypeScript does not ship. */
interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  onstart: (() => void) | null
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onend: (() => void) | null
  onerror: ((event: { error?: string }) => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike

const speechConstructor = (): SpeechRecognitionConstructor | undefined => {
  const scope = window as unknown as { SpeechRecognition?: SpeechRecognitionConstructor; webkitSpeechRecognition?: SpeechRecognitionConstructor }
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition
}

/** Web Speech error to the engine error codes of the controller. */
export function browserErrorCode(error: string | undefined) {
  switch (error) {
    case 'not-allowed':
    case 'service-not-allowed': return 'error_permission'
    case 'audio-capture': return 'error_no_microphone'
    case 'language-not-supported': return 'error_language_not_supported'
    case 'network': return 'error_network'
    case 'no-speech': return 'error_speech_timeout'
    case 'aborted': return 'error_aborted'
    default: return 'error_listen_failed'
  }
}

export class BrowserDictationEngine implements DictationEngine {
  private recognition: SpeechRecognitionLike | null = null
  private maxTimer: ReturnType<typeof setTimeout> | undefined

  async initialize(): Promise<DictationAccess> {
    // The browser asks for the microphone when the recognition starts.
    return speechConstructor() ? 'granted' : 'unavailable'
  }

  async resolveLocale(languageCode: string): Promise<DictationLocale> {
    return { localeId: preferredLocaleId(languageCode), onDevice: false, serverReachable: true }
  }

  listen({ localeId, listenForMs, sink }: DictationListenOptions): Promise<boolean> {
    const Recognition = speechConstructor()
    if (!Recognition) return Promise.resolve(false)
    this.teardown()
    const recognition = new Recognition()
    this.recognition = recognition
    recognition.lang = localeId
    recognition.continuous = true
    recognition.interimResults = true
    return new Promise<boolean>((resolve) => {
      let settled = false
      const settle = (value: boolean) => { if (!settled) { settled = true; resolve(value) } }
      const opening = setTimeout(() => settle(false), 3_000)
      recognition.onstart = () => { clearTimeout(opening); settle(true) }
      recognition.onresult = (event) => {
        let transcript = ''
        let final = true
        for (let index = 0; index < event.results.length; index += 1) {
          transcript += event.results[index][0].transcript
          final = event.results[index].isFinal
        }
        sink.onWords(transcript, final)
      }
      recognition.onerror = (event) => {
        clearTimeout(opening)
        if (this.recognition !== recognition) return
        const code = browserErrorCode(event.error)
        if (code === 'error_aborted') return
        settle(true)
        sink.onError(code)
      }
      recognition.onend = () => {
        clearTimeout(opening)
        if (this.recognition !== recognition) return
        settle(false)
        clearTimeout(this.maxTimer)
        sink.onAudioEnd()
        sink.onDone()
      }
      // The API has no maximum length of its own.
      this.maxTimer = setTimeout(() => recognition.stop(), listenForMs)
      try { recognition.start() } catch { clearTimeout(opening); settle(false) }
    })
  }

  async stop() {
    this.recognition?.stop()
  }

  async cancel() {
    this.teardown()
  }

  private teardown() {
    clearTimeout(this.maxTimer)
    const recognition = this.recognition
    this.recognition = null
    if (recognition) { try { recognition.abort() } catch { /* already stopped */ } }
  }
}

// ── Fake: scripted words and levels (unit tests, `?demo=1`) ──────────────────

export interface FakeDictationOptions {
  /** Said word by word; empty: nothing is said alone, tests push words with `emitWords`. */
  text?: string
  access?: DictationAccess
  localeAvailable?: boolean
  onDevice?: boolean
  serverReachable?: boolean
  startSucceeds?: boolean
  wordEveryMs?: number
  levelEveryMs?: number
  /** Delay of the final result after `stop`; `null`: never (the controller must cope without it). */
  finalDelayMs?: number | null
  /** Stops by itself after `pauseForMs` of silence, like the real engine. */
  honorPause?: boolean
}

export class FakeDictationEngine implements DictationEngine {
  access: DictationAccess
  localeAvailable: boolean
  onDevice: boolean
  serverReachable: boolean
  startSucceeds: boolean
  text: string
  initializeCalls = 0
  listenCalls = 0
  stopCalls = 0
  cancelCalls = 0
  lastLocaleId: string | undefined
  lastOnDevice: boolean | undefined
  lastListenForMs: number | undefined
  lastPauseForMs: number | undefined

  private readonly wordEveryMs: number
  private readonly levelEveryMs: number
  private readonly finalDelayMs: number | null
  private readonly honorPause: boolean
  private sink: DictationSink | null = null
  private words: ReturnType<typeof setInterval> | undefined
  private levels: ReturnType<typeof setInterval> | undefined
  private pause: ReturnType<typeof setTimeout> | undefined
  private final: ReturnType<typeof setTimeout> | undefined
  private spoken = 0
  private tick = 0
  private heard = ''

  constructor(options: FakeDictationOptions = {}) {
    this.text = options.text ?? ''
    this.access = options.access ?? 'granted'
    this.localeAvailable = options.localeAvailable ?? true
    this.onDevice = options.onDevice ?? true
    this.serverReachable = options.serverReachable ?? true
    this.startSucceeds = options.startSucceeds ?? true
    this.wordEveryMs = options.wordEveryMs ?? 280
    this.levelEveryMs = options.levelEveryMs ?? 60
    this.finalDelayMs = options.finalDelayMs === undefined ? 120 : options.finalDelayMs
    this.honorPause = options.honorPause ?? false
  }

  get listening() { return this.sink !== null }

  async initialize() {
    this.initializeCalls += 1
    return this.access
  }

  async resolveLocale(languageCode: string): Promise<DictationLocale> {
    if (!this.localeAvailable) return MISSING_LOCALE
    return { localeId: preferredLocaleId(languageCode), onDevice: this.onDevice, serverReachable: this.serverReachable }
  }

  async listen({ localeId, onDevice, listenForMs, pauseForMs, sink }: DictationListenOptions) {
    this.listenCalls += 1
    this.lastLocaleId = localeId
    this.lastOnDevice = onDevice
    this.lastListenForMs = listenForMs
    this.lastPauseForMs = pauseForMs
    if (!this.startSucceeds) return false
    this.clearTimers()
    this.sink = sink
    this.spoken = 0
    this.tick = 0
    this.heard = ''
    const words = this.text.split(/\s+/).filter(Boolean)
    if (words.length) {
      this.words = setInterval(() => {
        if (this.spoken >= words.length) {
          clearInterval(this.words)
          if (this.honorPause) this.pause = setTimeout(() => this.endSession(), pauseForMs)
          return
        }
        this.spoken += 1
        this.emitWords(words.slice(0, this.spoken).join(' '))
      }, this.wordEveryMs)
      this.levels = setInterval(() => {
        this.tick += 1
        const speaking = this.spoken < words.length
        // Syllables: two sines beating, a low floor between words.
        const value = speaking ? 0.25 + 0.55 * Math.abs(0.5 + 0.5 * Math.sin(this.tick * 0.9)) * (0.6 + 0.4 * Math.sin(this.tick * 0.37)) : 0.03
        this.emitLevel(Math.min(1, Math.max(0, value)))
      }, this.levelEveryMs)
    }
    return true
  }

  private endSession() {
    const sink = this.sink
    if (!sink) return
    this.clearTimers()
    sink.onAudioEnd()
    if (this.heard) sink.onWords(this.heard, true)
    this.sink = null
    sink.onDone()
  }

  async stop() {
    this.stopCalls += 1
    const sink = this.sink
    if (!sink) return
    this.clearTimers()
    if (this.finalDelayMs === null) return
    this.final = setTimeout(() => { if (this.sink === sink) this.endSession() }, this.finalDelayMs)
  }

  async cancel() {
    this.cancelCalls += 1
    this.clearTimers()
    this.sink = null
  }

  emitWords(text: string, isFinal = false) {
    this.heard = text
    this.sink?.onWords(text, isFinal)
  }

  emitLevel(level: number) {
    this.sink?.onLevel(level)
  }

  /** The end of the session comes from the engine: the microphone closes, then, if `done`, nothing more arrives. */
  emitDone(done = true) {
    const sink = this.sink
    this.clearTimers()
    sink?.onAudioEnd()
    if (!done) return
    this.sink = null
    sink?.onDone()
  }

  emitError(code: string) {
    const sink = this.sink
    this.clearTimers()
    this.sink = null
    sink?.onError(code)
    sink?.onDone()
  }

  private clearTimers() {
    clearInterval(this.words)
    clearInterval(this.levels)
    clearTimeout(this.pause)
    clearTimeout(this.final)
  }
}

/** The sentence the demo "dictates", in the interface language. */
export const DEMO_DICTATION: Record<'en' | 'fr', string> = {
  en: 'Summarize the three things to handle before the end of the day.',
  fr: 'Résume-moi les trois points à traiter avant la fin de la journée.',
}

// ── Choice of the engine ─────────────────────────────────────────────────────

export interface EngineContext {
  demo: boolean
  language: 'en' | 'fr'
  languageCode: () => string
}

/** `null`: nothing can dictate here, the interface shows no mic button. */
export function createDictationEngine({ demo, language, languageCode }: EngineContext): DictationEngine | null {
  if (demo) return new FakeDictationEngine({ text: DEMO_DICTATION[language] })
  const bridge = typeof window === 'undefined' ? undefined : window.hermesBot?.dictation
  if (bridge) return new DesktopDictationEngine(bridge, languageCode)
  // In the desktop app the Web Speech API exists but cannot work: only a plain browser uses it.
  if (typeof window !== 'undefined' && window.hermesBot?.platform !== 'electron' && speechConstructor()) return new BrowserDictationEngine()
  return null
}
