interface Window {
  /** Only present in the Electron app, absent in browser mode. */
  hermesBot?: {
    platform: 'electron'
    restartTunnel: () => Promise<void>
    /** Brings the window to the front (a notification was clicked). */
    focusWindow?: () => Promise<void>
    /** Dictation by the Mac's speech recognition, through the native speech helper. */
    dictation?: {
      /** Asks for the microphone and speech recognition permissions, and probes the language. */
      prepare: (localeId: string) => Promise<{ access: 'granted' | 'denied' | 'unavailable'; microphone: boolean; exists: boolean; onDevice: boolean; available: boolean }>
      start: (options: { localeId: string; onDevice: boolean; listenForMs: number; pauseForMs: number }) => Promise<boolean>
      stop: () => Promise<void>
      cancel: () => Promise<void>
      onEvent: (listener: (event: { type: 'words'; text: string; final: boolean } | { type: 'level'; value: number } | { type: 'audioEnd' } | { type: 'done' } | { type: 'error'; code: string }) => void) => () => void
    }
  }
}
