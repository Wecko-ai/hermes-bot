const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('hermesBot', Object.freeze({
  platform: 'electron',
  restartTunnel: () => ipcRenderer.invoke('hermes-bot:restart-tunnel'),
  focusWindow: () => ipcRenderer.invoke('hermes-bot:focus-window'),
}))
