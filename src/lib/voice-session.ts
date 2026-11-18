// Voice mode: one spoken conversation with one bot, framework-free.
//
// Listening reuses the dictation controller (the OS speech recognition, behind the main-process gate):
// each push of the Talk button is one gesture and one listen. What the user says is sent like a typed
// message, with the voice note in `api_text`. The replies of the turns this session started are spoken
// sentence by sentence by the speech engine; the sentence being spoken is the caption.
//
// Rules kept here:
// - only the turns started by this session are spoken (a FIFO of expected turn ends: a turn already
//   running when a message is queued is someone else's);
// - silent replies are never spoken (the caller passes `meaningful`);
// - approvals are never answered by voice: the bot says to look at the screen;
// - a clarify question with choices is answered by a number or a choice label, a free question by the
//   words themselves; anything unclear leaves the card on screen;
// - the microphone and the voice never run together (the main process enforces it as well).

import { DictationController, type DictationBlock, type DictationEngine, type DictationNotice } from './dictation'
import type { PendingPrompt } from './hermes'
import type { SpeechEngine, SpeechEvent, SpeechVoice } from './speech-engines'
import { guessLanguage, matchChoice, toSpokenText, voiceCommand, type SpokenLanguage } from './spoken-text'

export type VoicePhase = 'idle' | 'listening' | 'thinking' | 'speaking' | 'asking'
export type VoiceNotice = DictationNotice | 'notSent' | 'noMatch' | 'cancelled' | 'speechFailed' | 'answerOnScreen'

export interface VoiceSnapshot {
  phase: VoicePhase
  /** What the user is saying (live), or said last. */
  transcript: string
  /** The sentence being spoken, or the last one spoken. */
  caption: string
  /** A bot question waiting for a spoken answer. */
  question: PendingPrompt | null
  /** An approval waits on screen: it is never given by voice. */
  approval: boolean
  /** The microphone cannot be used (permission, no microphone, language). */
  blocked: DictationBlock | null
  notice: VoiceNotice | null
  /** Changes at each notice, so the same notice twice is shown twice. */
  noticeKey: number
}

export interface VoiceSettings {
  /** Voice identifier per language; empty: the system voice of the language. */
  voices: Partial<Record<SpokenLanguage, string>>
  rate: number
  /** Also speak the short steps the bot writes before its tools ("I'm searching…"). */
  speakSteps: boolean
}

/** Spoken by the session itself (not from the bot): translated by the caller. */
export type VoicePhraseKey = 'approval' | 'noMatch' | 'multiSelect'

export interface VoiceSessionOptions {
  dictation: DictationEngine
  speech: SpeechEngine
  /** Dictation language (`fr`, `en`): what the user speaks, and the fallback for the replies. */
  languageCode: () => SpokenLanguage
  settings: () => VoiceSettings
  /** Sends a spoken message. `cutShort`: the user interrupted the previous spoken reply. */
  send: (text: string, options: { cutShort: boolean }) => Promise<boolean>
  /** Answers a clarify question; `false` or a throw: not answered, the card stays. */
  answer: (prompt: PendingPrompt, answer: string) => Promise<boolean | void>
  /** The user said "stop" (or pressed ×): the overlay closes. */
  onEnd: () => void
  phrase: (key: VoicePhraseKey, language: SpokenLanguage) => string
  isOffline?: () => boolean
  /** Silence that ends a tap-to-talk listen. */
  pauseForMs?: number
  /** A press held longer than this is push-to-talk: the release ends the listen. */
  holdMs?: number
  /** Without any turn event for this long after the bot stopped, expected replies are dropped. */
  staleTurnMs?: number
  now?: () => number
}

const DEFAULT_TAG: Record<SpokenLanguage, string> = { fr: 'fr-FR', en: 'en-GB' }
const STEP_MAX_CHARS = 240
const NO_BANDS: number[] = []

export class VoiceSession {
  /** Voice level 0..1 while speaking (the HUD reads it every frame; too frequent for a render). */
  level = 0
  bands: number[] = NO_BANDS

  private readonly options: VoiceSessionOptions
  private readonly dictation: DictationController
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribeSpeech: () => void
  private readonly unsubscribeDictation: () => void
  private readonly now: () => number
  private snapshot: VoiceSnapshot = { phase: 'idle', transcript: '', caption: '', question: null, approval: false, blocked: null, notice: null, noticeKey: 0 }
  private voiceList: SpeechVoice[] = []
  /** Turn ends still expected, oldest first: `mine` is spoken, `foreign` is not. */
  private turns: ('mine' | 'foreign')[] = []
  /** Utterances queued or playing, with their sentence (the caption). */
  private readonly spoken = new Map<number, string>()
  private nextId = 1 + Math.floor(Math.random() * 1_000_000) * 1_000
  private heard = ''
  private wasListening = false
  private pressedAt: number | null = null
  private sending = false
  /** The bot is running a turn (from the caller): a message sent now is queued behind it. */
  private running = false
  private cutShort = false
  private pendingReply: { text: string; maxSentences?: number } | null = null
  private staleTimer: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  constructor(options: VoiceSessionOptions) {
    this.options = options
    this.now = options.now ?? Date.now
    this.dictation = new DictationController({
      engine: options.dictation,
      languageCode: options.languageCode,
      getText: () => '',
      setText: (text) => this.onTranscript(text),
      isOffline: options.isOffline,
      onNotice: (notice) => this.notify(notice),
      listenForMs: 60_000,
      pauseForMs: options.pauseForMs ?? 1_600,
      finalWaitMs: 800,
      now: this.now,
    })
    this.unsubscribeDictation = this.dictation.subscribe(() => this.onDictationChange())
    this.unsubscribeSpeech = options.speech.onEvent((event) => this.onSpeechEvent(event))
    void options.speech.voices().then((voices) => { this.voiceList = voices }).catch(() => {})
  }

  // For `useSyncExternalStore`.
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  getSnapshot = () => this.snapshot

  /** What the HUD draws: the microphone while listening, the voice while speaking. */
  get hudLevel() { return this.dictation.active ? this.dictation.level : this.spoken.size ? this.level : 0 }
  get hudBands() { return this.spoken.size && !this.dictation.active ? this.bands : NO_BANDS }
  get listening() { return this.dictation.active }
  get speaking() { return this.spoken.size > 0 }

  // ── The user ───────────────────────────────────────────────────────────────

  /** Talk button pressed (mouse down, Enter down): a real gesture, seen by the main process. */
  pressTalk() {
    if (this.disposed) return
    if (this.dictation.active) {
      // A second tap while listening: that is all, send what was heard.
      void this.dictation.stop()
      return
    }
    if (this.spoken.size) this.stopSpeaking()
    this.pendingReply = null
    this.pressedAt = this.now()
    void this.dictation.start()
  }

  /** Talk button released: after a long press, the release ends the listen (push-to-talk). */
  releaseTalk() {
    const pressedAt = this.pressedAt
    this.pressedAt = null
    if (pressedAt === null || !this.dictation.active) return
    if (this.now() - pressedAt >= (this.options.holdMs ?? 450)) void this.dictation.stop()
  }

  /** Stops the voice now. The bot is told, with the next message, that its reply was cut short. */
  stopSpeaking() {
    if (!this.spoken.size && !this.pendingReply) return
    if (this.spoken.size) this.cutShort = true
    this.spoken.clear()
    this.pendingReply = null
    this.level = 0
    this.bands = NO_BANDS
    void this.options.speech.stop().catch(() => {})
    this.refresh()
  }

  /** The overlay closes. */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    clearTimeout(this.staleTimer)
    this.unsubscribeDictation()
    this.dictation.dispose()
    this.unsubscribeSpeech()
    if (this.spoken.size) void this.options.speech.stop().catch(() => {})
    this.spoken.clear()
    this.listeners.clear()
  }

  /** The window is back in front: a microphone refusal may have been lifted in System Settings. */
  recheckAccess() {
    this.dictation.recheckAccess()
    this.dictation.recheckLanguage()
    this.refresh()
  }

  // ── The bot (fed by the gateway events of this bot's open conversation) ────

  /** The bot is running or not. A lost turn end must not leave the session "thinking" for ever. */
  setRunning(running: boolean) {
    this.running = running
    clearTimeout(this.staleTimer)
    if (!running && this.turns.length && !this.sending) {
      this.staleTimer = setTimeout(() => {
        if (this.disposed || this.sending) return
        this.turns = []
        this.refresh()
      }, this.options.staleTurnMs ?? 15_000)
    }
  }

  /** A step sealed before the bot's tools ("I'm looking it up…"). */
  turnStep(text: string) {
    if (this.disposed || this.turns[0] !== 'mine' || !this.options.settings().speakSteps) return
    if (!text.trim() || text.length > STEP_MAX_CHARS) return
    this.speak(text, 2)
  }

  /** A turn of this bot ended (`meaningful`: not silent, not empty). */
  turnEnded(reply: { text: string; meaningful: boolean }) {
    if (this.disposed) return
    const head = this.turns.shift()
    if (this.snapshot.question || this.snapshot.approval) this.update({ question: null, approval: false })
    if (head === 'mine' && reply.meaningful) this.speak(reply.text)
    this.refresh()
  }

  /** A question or an approval from the bot, during a turn of this session. */
  prompt(prompt: PendingPrompt) {
    if (this.disposed || !this.turns.includes('mine')) return
    const language = guessLanguage(prompt.question || prompt.description, this.options.languageCode())
    if (prompt.kind === 'approval') {
      this.update({ approval: true })
      this.speak(this.options.phrase('approval', language), 1)
      return
    }
    this.update({ question: prompt })
    if (prompt.multiSelect) {
      this.speak(`${prompt.question} ${this.options.phrase('multiSelect', language)}`)
      return
    }
    const choices = prompt.choices.map((choice, index) => `${index + 1}. ${choice}.`).join(' ')
    this.speak([prompt.question, choices].filter(Boolean).join(' '), 8)
  }

  /** Answered here or elsewhere (the card, another device). */
  promptSettled(promptId: string) {
    const { question } = this.snapshot
    if (question?.promptId === promptId) this.update({ question: null })
    else if (this.snapshot.approval) this.update({ approval: false })
    this.refresh()
  }

  // ── Inside ─────────────────────────────────────────────────────────────────

  private onTranscript(text: string) {
    this.heard = text
    this.update({ transcript: text })
  }

  private onDictationChange() {
    const { blocked } = this.dictation.getSnapshot()
    if (blocked !== this.snapshot.blocked) this.update({ blocked })
    const listening = this.dictation.active
    if (this.wasListening && !listening) {
      const text = this.heard.trim()
      this.heard = ''
      void this.handleUtterance(text)
    }
    this.wasListening = listening
    this.refresh()
  }

  private async handleUtterance(text: string) {
    if (this.disposed) return
    const pending = this.pendingReply
    this.pendingReply = null
    if (!text) {
      // Nothing said: a reply that came in while listening is spoken now.
      if (pending) this.speak(pending.text, pending.maxSentences)
      return
    }
    const command = voiceCommand(text)
    if (command === 'end') {
      this.options.onEnd()
      return
    }
    if (command === 'cancel') {
      this.update({ transcript: '' })
      this.notify('cancelled')
      return
    }
    const question = this.snapshot.question
    if (question && !question.multiSelect) return this.answerQuestion(question, text)
    await this.sendText(text)
  }

  private async answerQuestion(question: PendingPrompt, text: string) {
    let answer = text
    if (question.choices.length) {
      const index = matchChoice(text, question.choices)
      if (index === null) {
        this.notify('noMatch')
        this.speak(this.options.phrase('noMatch', this.options.languageCode()), 1)
        return
      }
      answer = question.choices[index]
    }
    try {
      const answered = await this.options.answer(question, answer)
      if (answered === false) throw new Error('not_answered')
      if (this.snapshot.question?.promptId === question.promptId) this.update({ question: null })
    } catch {
      this.notify('answerOnScreen')
    }
    this.refresh()
  }

  private async sendText(text: string) {
    // A turn already running when this message goes in ends first, and it is not ours.
    const expected: ('mine' | 'foreign')[] = this.turns.length === 0 && this.running ? ['foreign', 'mine'] : ['mine']
    this.turns.push(...expected)
    this.sending = true
    clearTimeout(this.staleTimer)
    this.refresh()
    const cutShort = this.cutShort
    this.cutShort = false
    let sent = false
    try { sent = await this.options.send(text, { cutShort }) } catch { sent = false }
    this.sending = false
    if (this.disposed) return
    if (!sent) {
      // Not sent: the expected turn ends will not come.
      for (const entry of expected.reverse()) {
        const index = this.turns.lastIndexOf(entry)
        if (index >= 0) this.turns.splice(index, 1)
      }
      this.cutShort = cutShort
      this.notify('notSent')
    }
    this.refresh()
  }

  private speak(text: string, maxSentences?: number) {
    if (this.disposed) return
    if (this.dictation.active) {
      // The microphone is open: the reply waits for the end of this listen.
      this.pendingReply = { text, maxSentences }
      return
    }
    const language = guessLanguage(text, this.options.languageCode())
    const { sentences } = toSpokenText(text, { language, maxSentences })
    if (!sentences.length) return
    const settings = this.options.settings()
    const voice = settings.voices[language] || undefined
    const tag = this.voiceList.find((item) => item.id === voice)?.language || DEFAULT_TAG[language]
    for (const sentence of sentences) {
      const id = this.nextId++
      this.spoken.set(id, sentence)
      const utterance = { id, text: sentence, voice, language: tag, rate: settings.rate }
      const refused = () => {
        if (!this.spoken.has(id)) return
        this.spoken.delete(id)
        this.notify('speechFailed')
        this.refresh()
      }
      void this.options.speech.say(utterance).then((accepted) => {
        if (accepted || !this.spoken.has(id)) return
        // Right after a listen, the main process may not have seen the microphone close yet: once more.
        setTimeout(() => {
          if (this.disposed || !this.spoken.has(id)) return
          void this.options.speech.say(utterance).then((again) => { if (!again) refused() }, refused)
        }, 400)
      }, refused)
    }
    this.refresh()
  }

  private onSpeechEvent(event: SpeechEvent) {
    if (this.disposed) return
    if (event.type === 'level') {
      if (!this.spoken.has(event.id)) return
      this.level = event.rms
      this.bands = event.bands
      return
    }
    if (event.type === 'start') {
      const sentence = this.spoken.get(event.id)
      if (sentence !== undefined) this.update({ caption: sentence })
      return
    }
    const id = event.id
    if (id === undefined || !this.spoken.has(id)) return
    this.spoken.delete(id)
    if (event.type === 'error') this.notify('speechFailed')
    if (!this.spoken.size) {
      this.level = 0
      this.bands = NO_BANDS
    }
    this.refresh()
  }

  private phaseNow(): VoicePhase {
    if (this.dictation.active) return 'listening'
    if (this.spoken.size) return 'speaking'
    if (this.snapshot.question || this.snapshot.approval) return 'asking'
    if (this.sending || this.turns.includes('mine')) return 'thinking'
    return 'idle'
  }

  private notify(notice: VoiceNotice) {
    this.update({ notice, noticeKey: this.snapshot.noticeKey + 1 })
  }

  private refresh() {
    const phase = this.phaseNow()
    if (phase !== this.snapshot.phase) this.update({ phase })
  }

  private update(patch: Partial<VoiceSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch }
    if (patch.phase === undefined) {
      const phase = this.phaseNow()
      if (phase !== this.snapshot.phase) this.snapshot = { ...this.snapshot, phase }
    }
    if (this.disposed) return
    for (const listener of [...this.listeners]) listener()
  }
}
