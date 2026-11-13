// Dictation of the composer field: the speech recognition of the OS turns the voice into text, which then goes
// through the same draft path as typed text. No audio ever reaches the local server.
//
// Three pieces, framework-free:
// - `DictationEngine`: where the words come from (see `dictation-engines.ts`: desktop bridge, browser, fake);
// - `DictationController`: the state machine (idle, starting, listening, finishing) that writes the transcript
//   into the field, after the text already there;
// - the interface (`Composer`, `DictationPill`), which shows the state and turns notices into toasts.

// ── Engine ───────────────────────────────────────────────────────────────────

/** Access to the microphone and to speech recognition, after the OS prompt if there was one. */
export type DictationAccess = 'granted' | 'denied' | 'unavailable' | 'noMicrophone'

/** The interface language on this machine. */
export interface DictationLocale {
  /** Identifier given to the engine (`fr-FR`, `en-US`); `null` = this language is not available. */
  localeId: string | null
  /** The recognition runs on the Mac. `false`: it goes through the network. */
  onDevice: boolean
  /** The system recognition says it can be reached (matters when it is not on the device). */
  serverReachable: boolean
}

/** What an engine reports during a listening session. */
export interface DictationSink {
  /** The whole transcript of the session (not a delta), partial or final. */
  onWords: (text: string, isFinal: boolean) => void
  /** Microphone level, 0 (silence) to 1. */
  onLevel: (level: number) => void
  /** The microphone is closed (stop, silence, maximum length); the final result may still arrive. */
  onAudioEnd: () => void
  /** The session is over: no result will come any more. */
  onDone: () => void
  /** Error code of the engine (`error_no_match`, `error_network`…). */
  onError: (code: string) => void
}

export interface DictationListenOptions {
  localeId: string
  onDevice: boolean
  listenForMs: number
  pauseForMs: number
  sink: DictationSink
}

export interface DictationEngine {
  /** Asks for the permissions if needed (the OS asks only once) and prepares the engine. */
  initialize: () => Promise<DictationAccess>
  /** The language of the interface (`fr`, `en`) on this machine. */
  resolveLocale: (languageCode: string) => Promise<DictationLocale>
  /** Starts a session. `false`: it did not start. */
  listen: (options: DictationListenOptions) => Promise<boolean>
  /** Stops the microphone; the final result follows in the sink. */
  stop: () => Promise<void>
  /** Drops the session, without a final result. */
  cancel: () => Promise<void>
}

export const MISSING_LOCALE: DictationLocale = { localeId: null, onDevice: false, serverReachable: true }

/** Interface language to dictation language: never the system's. */
export const preferredLocaleId = (languageCode: string) => (languageCode === 'fr' ? 'fr-FR' : 'en-US')

/** `m:ss`, from a number of milliseconds. */
export function formatTimer(ms: number) {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** The transcript goes after the text already in the field, separated by a space. */
export function joinTranscript(base: string, words: string) {
  if (!words) return base
  return base ? `${base} ${words}` : words
}

// ── Controller ───────────────────────────────────────────────────────────────

export type DictationPhase = 'idle' | 'starting' | 'listening' | 'finishing'

/** What durably prevents dictating: the mic button then looks disabled, and a click repeats the reason. */
export type DictationBlock = 'permission' | 'unavailable' | 'noMicrophone' | 'language'

/** What the interface has to say (toast). `offline` and `failed` leave the button usable. */
export type DictationNotice = DictationBlock | 'offline' | 'failed'

export interface DictationSnapshot {
  phase: DictationPhase
  blocked: DictationBlock | null
  /** `now()` at the moment the microphone started listening; `null` before. */
  listeningSince: number | null
}

export interface DictationControllerOptions {
  engine: DictationEngine
  languageCode: () => string
  /** The field as it is right now (what the user typed included). */
  getText: () => string
  /** Writes the field. The caret goes to the end (the interface does it). */
  setText: (text: string) => void
  isOffline?: () => boolean
  onNotice?: (notice: DictationNotice) => void
  listenForMs?: number
  pauseForMs?: number
  /** Longest wait for the final result after a stop. */
  finalWaitMs?: number
  now?: () => number
}

const PERMISSION_ERRORS = new Set(['error_permission', 'error_insufficient_permissions', 'error_speech_recognizer_request_not_authorized'])
const LANGUAGE_ERRORS = new Set(['error_language_not_supported', 'error_language_unavailable', 'error_assets_not_installed'])
const NETWORK_ERRORS = ['error_network', 'error_server', 'error_speech_recognizer_connection', 'error_too_many_requests']

const noticeFor = (block: DictationBlock): DictationNotice => block

export class DictationController {
  readonly listenForMs: number
  readonly pauseForMs: number
  readonly finalWaitMs: number
  /** Microphone level 0..1, read by the wave (it changes too often for a render). */
  level = 0

  private readonly options: DictationControllerOptions
  private readonly now: () => number
  private readonly listeners = new Set<() => void>()
  private snapshot: DictationSnapshot = { phase: 'idle', blocked: null, listeningSince: null }
  private session = 0
  private disposed = false
  private onDevice = false
  private base = ''
  private words = ''
  private completeFinal: (() => void) | null = null
  private finishing: Promise<void> | null = null

  constructor(options: DictationControllerOptions) {
    this.options = options
    this.listenForMs = options.listenForMs ?? 60_000
    this.pauseForMs = options.pauseForMs ?? 4_500
    this.finalWaitMs = options.finalWaitMs ?? 600
    this.now = options.now ?? Date.now
  }

  // For `useSyncExternalStore`: stable references, replaced at each change.
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  getSnapshot = () => this.snapshot

  get phase() { return this.snapshot.phase }
  get blocked() { return this.snapshot.blocked }
  /** Starting, listening or finishing: the composer is in dictation mode. */
  get active() { return this.snapshot.phase !== 'idle' }
  /** Something was heard during this session. */
  get heardSomething() { return this.words.length > 0 }

  /** The mic button. */
  async start(): Promise<void> {
    if (this.disposed || this.snapshot.phase !== 'idle') return
    const blocked = this.snapshot.blocked
    if (blocked) {
      // Disabled: the reason is repeated, the OS is not asked again.
      this.notice(noticeFor(blocked))
      return
    }
    const session = ++this.session
    this.base = this.options.getText().trimEnd()
    this.words = ''
    this.level = 0
    this.update({ phase: 'starting', listeningSince: null })

    let access: DictationAccess
    try { access = await this.options.engine.initialize() } catch { access = 'unavailable' }
    if (!this.starting(session)) return
    if (access !== 'granted') {
      this.block(access === 'denied' ? 'permission' : access === 'noMicrophone' ? 'noMicrophone' : 'unavailable')
      return
    }

    let locale: DictationLocale
    try { locale = await this.options.engine.resolveLocale(this.options.languageCode()) } catch { locale = MISSING_LOCALE }
    if (!this.starting(session)) return
    if (locale.localeId === null) {
      this.block('language')
      return
    }
    this.onDevice = locale.onDevice
    if (!locale.onDevice && (!locale.serverReachable || (this.options.isOffline?.() ?? false))) {
      this.toIdle()
      this.notice('offline')
      return
    }

    let started: boolean
    try {
      started = await this.options.engine.listen({
        localeId: locale.localeId,
        onDevice: locale.onDevice,
        listenForMs: this.listenForMs,
        pauseForMs: this.pauseForMs,
        sink: this.sinkFor(session),
      })
    } catch {
      started = false
    }
    if (session !== this.session || this.disposed) {
      // Stopped (or unmounted) while the microphone was opening: give it back.
      if (started) void this.options.engine.cancel().catch(() => {})
      return
    }
    if (!started) {
      this.toIdle()
      this.notice('failed')
      return
    }
    if (this.phase === 'starting') this.update({ phase: 'listening', listeningSince: this.now() })
  }

  /** Stop button, Escape, hidden window: the text stays in the field. */
  stop(): Promise<void> {
    const { phase } = this.snapshot
    if (phase === 'starting') {
      this.session += 1
      this.toIdle()
      // The engine may be opening the microphone right now: it is given back when `listen` returns.
      return Promise.resolve()
    }
    if (phase === 'finishing') return this.finishing ?? Promise.resolve()
    if (phase !== 'listening') return Promise.resolve()
    return this.beginFinish(true)
  }

  /** Send while dictating: stop and wait briefly for the final result; the caller then sends the field. */
  finish(): Promise<void> {
    return this.stop()
  }

  /** Immediate abandon (the bot changed, the field unmounts): what is written stays, nothing else arrives. */
  cancel() {
    if (!this.active) return
    this.session += 1
    void this.options.engine.cancel().catch(() => {})
    this.toIdle()
  }

  /** The window is back in front: a refusal may have been lifted in System Settings. The next click tries again. */
  recheckAccess() {
    const { blocked } = this.snapshot
    if (blocked === 'permission' || blocked === 'noMicrophone') this.update({ blocked: null })
  }

  dispose() {
    const wasActive = this.active
    this.disposed = true
    this.session += 1
    this.completeFinal?.()
    if (wasActive) void this.options.engine.cancel().catch(() => {})
    this.listeners.clear()
  }

  private beginFinish(callEngine: boolean): Promise<void> {
    const session = this.session
    let release = () => {}
    const done = new Promise<void>((resolve) => { release = resolve })
    this.completeFinal = release
    this.level = 0
    this.update({ phase: 'finishing' })
    const run = async () => {
      if (callEngine) { try { await this.options.engine.stop() } catch { /* the wait below still ends it */ } }
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, this.finalWaitMs) })
      await Promise.race([done, timeout])
      clearTimeout(timer)
      if (session !== this.session || this.disposed) return
      this.finishing = null
      this.completeFinal = null
      this.toIdle()
    }
    return (this.finishing = run())
  }

  private sinkFor(session: number): DictationSink {
    const stale = () => session !== this.session || this.disposed
    return {
      onWords: (text, isFinal) => {
        if (stale() || !this.active) return
        this.words = text.trim()
        this.write()
        if (isFinal && this.snapshot.phase === 'finishing') this.completeFinal?.()
      },
      onLevel: (value) => {
        if (stale() || this.snapshot.phase !== 'listening') return
        this.level = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
      },
      // Long silence, maximum length or end decided by the OS: like a stop, the final result has `finalWaitMs` left.
      onAudioEnd: () => {
        if (stale()) return
        if (this.snapshot.phase === 'listening') void this.beginFinish(false)
      },
      onDone: () => {
        if (stale()) return
        if (this.snapshot.phase === 'listening') void this.beginFinish(false)
        if (this.snapshot.phase === 'finishing') this.completeFinal?.()
      },
      onError: (code) => {
        if (stale() || !this.active) return
        this.fail(code)
      },
    }
  }

  private fail(code: string) {
    const heard = this.heardSomething
    const lower = code.toLowerCase()
    if (PERMISSION_ERRORS.has(lower)) return this.block('permission', true)
    if (lower === 'error_no_microphone') return this.block('noMicrophone', true)
    if (LANGUAGE_ERRORS.has(lower) && !heard) return this.block('language', true)
    this.session += 1
    this.toIdle()
    void this.options.engine.cancel().catch(() => {})
    if (heard) return // the text stays, nothing to say
    if (!this.onDevice && NETWORK_ERRORS.some((prefix) => lower.startsWith(prefix))) this.notice('offline')
    else if (lower === 'error_listen_failed') this.notice('failed')
    // error_no_match, error_speech_timeout, error_busy…: nothing was said, back to rest without a toast.
  }

  private write() {
    this.options.setText(joinTranscript(this.base, this.words))
  }

  private starting(session: number) {
    return !this.disposed && session === this.session && this.snapshot.phase === 'starting'
  }

  private block(block: DictationBlock, cancel = false) {
    this.session += 1
    if (cancel) void this.options.engine.cancel().catch(() => {})
    this.toIdle()
    this.update({ blocked: block })
    this.notice(noticeFor(block))
  }

  private toIdle() {
    this.completeFinal?.()
    this.completeFinal = null
    this.finishing = null
    this.level = 0
    this.update({ phase: 'idle', listeningSince: null })
  }

  private update(patch: Partial<DictationSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch }
    if (this.disposed) return
    for (const listener of [...this.listeners]) listener()
  }

  private notice(notice: DictationNotice) {
    if (!this.disposed) this.options.onNotice?.(notice)
  }
}
