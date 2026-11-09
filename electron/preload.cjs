const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('hermesBot', Object.freeze({
  platform: 'electron',
  restartTunnel: () => ipcRenderer.invoke('hermes-bot:restart-tunnel'),
}))
