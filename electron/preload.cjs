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
}))
