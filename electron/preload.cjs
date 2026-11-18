const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('hermesBot', Object.freeze({
  platform: 'electron',
  restartTunnel: () => ipcRenderer.invoke('hermes-bot:restart-tunnel'),
  focusWindow: () => ipcRenderer.invoke('hermes-bot:focus-window'),
  revealInFinder: (path) => ipcRenderer.invoke('hermes-bot:reveal-media', path),
  // Dictation with the system's speech recognizer (main.cjs, dictation.cjs). `prepare` answers "unavailable"
  // where the app has no recognizer: the page then uses its own fallback.
  dictation: Object.freeze({
    prepare: (localeId) => ipcRenderer.invoke('hermes-bot:dictation-prepare', localeId),
    start: (options) => ipcRenderer.invoke('hermes-bot:dictation-start', options),
    stop: () => ipcRenderer.invoke('hermes-bot:dictation-stop'),
    cancel: () => ipcRenderer.invoke('hermes-bot:dictation-cancel'),
    onEvent: (listener) => {
      const forward = (_event, payload) => listener(payload)
      ipcRenderer.on('hermes-bot:dictation-event', forward)
      return () => { ipcRenderer.removeListener('hermes-bot:dictation-event', forward) }
    },
  }),
  // Speech output with the Mac's voices (main.cjs, speech.cjs). No audio reaches the page.
  speech: Object.freeze({
    voices: () => ipcRenderer.invoke('hermes-bot:speech-voices'),
    say: (utterance) => ipcRenderer.invoke('hermes-bot:speech-say', utterance),
    stop: () => ipcRenderer.invoke('hermes-bot:speech-stop'),
    onEvent: (listener) => {
      const forward = (_event, payload) => listener(payload)
      ipcRenderer.on('hermes-bot:speech-event', forward)
      return () => { ipcRenderer.removeListener('hermes-bot:speech-event', forward) }
    },
  }),
}))
