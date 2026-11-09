const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('hermesBot', Object.freeze({ platform: 'electron' }))
