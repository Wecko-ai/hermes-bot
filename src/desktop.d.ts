interface Window {
  /** Only present in the Electron app, absent in browser mode. */
  hermesBot?: {
    platform: 'electron'
    restartTunnel: () => Promise<void>
    /** Brings the window to the front (a notification was clicked). */
    focusWindow?: () => Promise<void>
    /** Reveals an existing local media file in Finder; false when this Mac does not have it. */
    revealInFinder?: (path: string) => Promise<boolean>
    /** Dictation by the Mac's speech recognition, through the native speech helper. */
    dictation?: {
      /** Asks for the microphone and speech recognition permissions, and probes the language. */
      prepare: (localeId: string) => Promise<{ access: 'granted' | 'denied' | 'unavailable'; microphone: boolean; exists: boolean; onDevice: boolean; available: boolean }>
      start: (options: { localeId: string; onDevice: boolean; listenForMs: number; pauseForMs: number }) => Promise<boolean>
      stop: () => Promise<void>
      cancel: () => Promise<void>
      onEvent: (listener: (event: { type: 'words'; text: string; final: boolean } | { type: 'level'; value: number } | { type: 'audioEnd' } | { type: 'done' } | { type: 'error'; code: string }) => void) => () => void
    }
    /**
     * Speech output (voice mode) by the Mac's own voices, through the same native helper.
     * The helper plays the audio itself and reports levels for the animation: no audio reaches the page.
     * The microphone and the voice never run together: a `say` while dictation listens is refused,
     * and a dictation start stops the voice first.
     */
    speech?: {
      /** The French and English voices installed on this Mac. */
      voices: () => Promise<HermesBotSpeechVoice[]>
      /** Queues one utterance; `false` when refused (too long, dictation listening, helper missing). */
      say: (utterance: { id: number; text: string; voice?: string; language: string; rate?: number }) => Promise<boolean>
      /** Stops the voice now and drops the queue; the current utterance ends with `interrupted: true`. */
      stop: () => Promise<void>
      onEvent: (listener: (event: HermesBotSpeechEvent) => void) => () => void
    }
  }
}

interface HermesBotSpeechVoice {
  /** `AVSpeechSynthesisVoice.identifier`. */
  id: string
  name: string
  /** BCP 47, e.g. `fr-FR`, `en-GB`. */
  language: string
  quality: 'default' | 'enhanced' | 'premium'
}

type HermesBotSpeechEvent =
  | { type: 'start'; id: number }
  /** About 30 per second while audio plays: overall level and 12 frequency bands, all 0..1. */
  | { type: 'level'; id: number; rms: number; bands: number[] }
  | { type: 'end'; id: number; interrupted: boolean }
  | { type: 'error'; id?: number; code: string }
