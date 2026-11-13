const { app, BrowserWindow, shell, dialog, safeStorage, ipcMain, session, nativeTheme } = require('electron')
const { execFile, spawn } = require('node:child_process')
const { randomBytes } = require('node:crypto')
const path = require('node:path')
const http = require('node:http')
const { pathToFileURL } = require('node:url')
const fs = require('node:fs')

const { loadConfig } = require('../server/config.cjs')
const { messages } = require('./messages.cjs')
const { externalUrl } = require('./links.cjs')
const { createDictation, UNAVAILABLE } = require('./dictation.cjs')
const { createDictationGate } = require('./dictation-gate.cjs')

const ORIGIN = 'http://127.0.0.1:4330'
// Optional settings: environment variables, then config.json in the app's data folder (see server/config.cjs).
const config = loadConfig()
const HERMES_ORIGIN = config.gatewayOrigin
const SSH_HOST = config.sshHost
// Native dialogs follow the system language; app.getPreferredSystemLanguages() needs the app to be ready.
const text = () => messages(app.isReady() ? app.getPreferredSystemLanguages() : [app.getLocale?.() || ''])
let hermesTunnelProcess
let vaultTunnelProcess
let hermesTunnelRestart
let mainWindow
// The page comes from a server this process did not start (another copy of the app holds the port).
let clientMode = false
// Who may turn the microphone on (dictation-gate.cjs). Created once the mode is known.
let dictationGate
// Proof, for this app's own server, that a sign-in without a password comes from this app's window.
// Only set when this process runs the server: a window on another account's server has no key to give.
let localKey = ''

async function startServer() {
  process.env.NODE_ENV = 'production'
  process.env.PORT = '4330'
  configureSessionPersistence()
  localKey = randomBytes(32).toString('base64url')
  globalThis.__hermesBotLocalKey = localKey
  const { listening } = await import(pathToFileURL(path.join(__dirname, '..', 'server', 'index.mjs')).href)
  try {
    await listening
  } catch (error) {
    if (error.code === 'EADDRINUSE') throw new Error(text().portTaken(error.port || 4330))
    throw error
  }
}

function configureSessionPersistence() {
  if (!safeStorage.isEncryptionAvailable()) return
  const directory = app.getPath('userData')
  const store = path.join(directory, 'hermes-sessions.bin')
  const temporary = `${store}.tmp`
  fs.mkdirSync(directory, { recursive: true })
  globalThis.__hermesBotSessionPersistence = {
    load: () => {
      try { return safeStorage.decryptString(fs.readFileSync(store)) } catch { return '' }
    },
    save: (json) => {
      fs.writeFileSync(temporary, safeStorage.encryptString(json), { mode: 0o600 })
      fs.renameSync(temporary, store)
    },
  }
  const credentials = path.join(directory, 'hermes-credentials.bin')
  globalThis.__hermesBotCredentialStore = {
    load: () => {
      try { return safeStorage.decryptString(fs.readFileSync(credentials)) } catch { return '' }
    },
    save: (json) => {
      fs.writeFileSync(`${credentials}.tmp`, safeStorage.encryptString(json), { mode: 0o600 })
      fs.renameSync(`${credentials}.tmp`, credentials)
    },
    clear: () => fs.rmSync(credentials, { force: true }),
  }
}

function hermesReady() {
  return new Promise((resolve) => {
    const request = http.get(`${HERMES_ORIGIN}/api/auth/providers`, { timeout: 1500 }, (response) => {
      response.resume()
      resolve(response.statusCode < 500)
    })
    request.on('error', () => resolve(false))
    request.on('timeout', () => { request.destroy(); resolve(false) })
  })
}

/**
 * Client mode: another macOS session on the same machine (the bots' account) already runs HermesBot on
 * 127.0.0.1:4330. This copy then only opens a window on that server, with no server, tunnel or keychain.
 */
function hermesBotAlreadyServing() {
  return new Promise((resolve) => {
    const request = http.get(`${ORIGIN}/api/health`, { timeout: 1500 }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        body += chunk
        if (body.length > 512) request.destroy()
      })
      response.on('end', () => {
        try { resolve(response.statusCode === 200 && JSON.parse(body).service === 'hermes-bot') } catch { resolve(false) }
      })
    })
    request.on('error', () => resolve(false))
    request.on('timeout', () => { request.destroy(); resolve(false) })
  })
}

function tunnelHasExited(tunnel) {
  return tunnel.exitCode !== null || tunnel.signalCode !== null
}

async function openHermesTunnel() {
  if (!SSH_HOST) throw new Error(text().noGateway(HERMES_ORIGIN))
  const port = new URL(HERMES_ORIGIN).port || '9120'
  const tunnelCwd = app.getPath('userData')
  fs.mkdirSync(tunnelCwd, { recursive: true })
  let tunnelError = null
  const tunnel = spawn('/usr/bin/ssh', [
    '-N', '-L', `${port}:127.0.0.1:${port}`,
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30', '--', SSH_HOST,
  ], { cwd: tunnelCwd, stdio: 'ignore' })
  hermesTunnelProcess = tunnel
  tunnel.once('error', (error) => { tunnelError = error })
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (tunnelError) throw new Error(text().tunnelFailed(SSH_HOST, tunnelError.message))
    if (await hermesReady()) {
      openVaultTunnel()
      return
    }
    if (tunnelHasExited(tunnel)) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(text().tunnelSilent(SSH_HOST))
}

/**
 * Shared Chrome vault: it lives on the bots' machine, with the keychain. Its port 4331 goes through a separate
 * ssh, so that a port already in use never prevents the connection to Hermes.
 */
function openVaultTunnel() {
  if (vaultTunnelProcess && !tunnelHasExited(vaultTunnelProcess)) return
  const tunnel = spawn('/usr/bin/ssh', [
    '-N', '-L', '4331:127.0.0.1:4331',
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30', '--', SSH_HOST,
  ], { cwd: app.getPath('userData'), stdio: 'ignore' })
  tunnel.once('error', () => undefined)
  vaultTunnelProcess = tunnel
  fetchVaultToken()
}

/** Vault admin token, read on the bots' machine over SSH and kept in memory only. */
function fetchVaultToken() {
  if (/^[0-9a-f]{64}$/.test(process.env.HERMESBOT_VAULT_TOKEN || '')) return
  execFile('/usr/bin/ssh', [
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '--', SSH_HOST, 'cat',
    '"Library/Application Support/HermesBot/vault-admin.token"',
  ], { timeout: 15_000 }, (error, stdout) => {
    const value = String(stdout || '').trim()
    if (!error && /^[0-9a-f]{64}$/.test(value)) process.env.HERMESBOT_VAULT_TOKEN = value
  })
}

async function ensureHermes() {
  if (!(await hermesReady())) await openHermesTunnel()
}

function stopHermesTunnel() {
  const tunnel = hermesTunnelProcess
  if (!tunnel || tunnelHasExited(tunnel)) return Promise.resolve()
  return new Promise((resolve) => {
    const force = setTimeout(() => tunnel.kill('SIGKILL'), 2000)
    tunnel.once('exit', () => { clearTimeout(force); resolve() })
    tunnel.kill('SIGTERM')
  })
}

/**
 * ↻ button: after sleep, the ssh started at launch may be dead, or alive but silent
 * and holding port 9120. So we stop it before opening another. With no tunnel at
 * startup (local gateway), there is nothing to restart.
 */
function restartHermesTunnel() {
  hermesTunnelRestart ??= (async () => {
    if (!hermesTunnelProcess) return
    // The vault's ssh may have died on its own during sleep, even if Hermes still answers.
    openVaultTunnel()
    if (await hermesReady()) return
    await stopHermesTunnel()
    await openHermesTunnel()
  })().finally(() => { hermesTunnelRestart = null })
  return hermesTunnelRestart
}

// Dictation: the system's speech recognizer in a helper process (dictation.cjs). The helper ships next to the
// app's resources; in development it is the one scripts/build-dictation.cjs builds. Elsewhere than macOS, none.
const DICTATION_HELPER = process.platform !== 'darwin'
  ? null
  : app.isPackaged
    ? path.join(process.resourcesPath, 'hermesbot-dictation')
    : path.join(__dirname, '..', 'native', 'dictation', '.build', 'hermesbot-dictation')
const dictation = createDictation({
  helperPath: DICTATION_HELPER,
  send: (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('hermes-bot:dictation-event', event)
  },
  // While the microphone is open, a mark on the Dock icon that the page cannot hide (macOS adds its own indicator).
  onMicrophone: (open) => app.dock?.setBadge(open ? '●' : ''),
})

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 860,
    minHeight: 600,
    title: 'HermesBot',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#000000' : '#e9efec',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Chromium's PDF viewer is a plugin: without this setting, the document tab stays empty.
      plugins: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })
  // Links go to the default browser or mail app, filtered by links.cjs (http, https and mailto only, never the
  // app's own server). The window itself never opens another page.
  const openOutside = (url) => {
    const target = externalUrl(url, ORIGIN)
    if (target) shell.openExternal(target).catch(() => { /* no app claims it: nothing to open */ })
  }
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url)
    return { action: 'deny' }
  })
  // Nothing replaces the app's page: a file dropped outside the drop zone stays put, and a link clicked in the
  // app's own page without a target opens outside, like the chat's links.
  const ownPage = (url) => url.startsWith(`${ORIGIN}/`)
  mainWindow.webContents.on('will-navigate', (event) => {
    if (ownPage(event.url)) return
    event.preventDefault()
    openOutside(event.url)
  })
  // Inside a document tab (a sandboxed iframe), a link never leaves the tab and never opens anything.
  const leavesApp = (url) => /^(?:https?|file):/.test(url) && !ownPage(url)
  mainWindow.webContents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame && leavesApp(event.url)) event.preventDefault()
  })
  // The key rides on one request only, from this window, and never reaches the page's own code.
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [`${ORIGIN}/api/auth/local`] }, (details, callback) => {
    const headers = { ...details.requestHeaders }
    if (localKey && mainWindow && details.webContentsId === mainWindow.webContents.id) headers['X-HermesBot-Local-Key'] = localKey
    callback({ requestHeaders: headers })
  })
  // Dictation: a deliberate press of the user in this window (a click, Enter or Space), seen here, is what may
  // open a session; a page cannot fake it, and typing does not count (dictation-gate.cjs). The microphone closes
  // as soon as the window is no longer in front (the page does too, but the main process does not count on it):
  // `stop` turns it off at once and lets the words already said through.
  mainWindow.webContents.on('before-input-event', (_event, input) => dictationGate?.noteInput(input))
  mainWindow.webContents.on('before-mouse-event', (_event, mouse) => dictationGate?.noteInput(mouse))
  for (const name of ['blur', 'hide', 'minimize']) {
    mainWindow.on(name, () => {
      dictationGate?.disarm()
      dictation.stop()
    })
  }
  // A dictation never outlives the page that asked for it: reload, navigation, crash, closed window.
  mainWindow.webContents.on('did-start-navigation', (event) => {
    if (event.isMainFrame && !event.isSameDocument) dictation.cancel()
  })
  mainWindow.webContents.on('render-process-gone', () => dictation.cancel())
  await mainWindow.loadURL(ORIGIN)
  mainWindow.on('closed', () => {
    dictation.cancel()
    mainWindow = null
  })
}

ipcMain.handle('hermes-bot:restart-tunnel', (event) => {
  if (!event.senderFrame?.url.startsWith(`${ORIGIN}/`)) throw new Error(text().forbiddenOrigin())
  return restartHermesTunnel()
})

ipcMain.handle('hermes-bot:focus-window', (event) => {
  if (!event.senderFrame?.url.startsWith(`${ORIGIN}/`)) throw new Error(text().forbiddenOrigin())
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  app.focus({ steal: true })
  mainWindow.focus()
})

// Dictation requests: only from this window's own top frame, on the app's origin.
const fromWindow = (event) => Boolean(mainWindow)
  && event.sender === mainWindow.webContents
  && Boolean(event.senderFrame) && !event.senderFrame.parent
  && event.senderFrame.url.startsWith(`${ORIGIN}/`)

// In client mode, the user's agreement to the microphone, for this launch only: nothing is kept on disk.
let consentAsked = null
async function askConsent() {
  const copy = text().dictationConsent()
  const options = { type: 'question', message: copy.message, detail: copy.detail, buttons: copy.buttons, defaultId: 1, cancelId: 1 }
  const { response } = await (mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options))
  return response === 0
}

ipcMain.handle('hermes-bot:dictation-prepare', async (event, localeId) => {
  const gate = dictationGate
  if (!fromWindow(event) || !gate || !gate.mayPrepare()) return { ...UNAVAILABLE }
  gate.disarm()
  if (gate.refused()) return { ...UNAVAILABLE }
  if (gate.needsConsent()) {
    // One dialog at a time, whatever the page asks meanwhile.
    consentAsked ??= askConsent().finally(() => { consentAsked = null })
    gate.setConsent((await consentAsked) ? 'granted' : 'denied')
    if (gate.refused()) return { ...UNAVAILABLE }
  }
  const state = await dictation.prepare(localeId)
  if (state.access === 'granted') gate.armStart()
  return state
})
ipcMain.handle('hermes-bot:dictation-start', (event, options) => {
  if (!fromWindow(event) || !dictationGate) return false
  const visible = mainWindow.isVisible() && !mainWindow.isMinimized()
  if (!dictationGate.takeStart({ focused: mainWindow.isFocused(), visible })) return false
  return dictation.start(options, { maxListenMs: dictationGate.maxListenMs() })
})
// Stopping is always safe: it only turns the microphone off.
ipcMain.handle('hermes-bot:dictation-stop', (event) => { if (fromWindow(event)) dictation.stop() })
ipcMain.handle('hermes-bot:dictation-cancel', (event) => { if (fromWindow(event)) dictation.cancel() })

app.whenReady().then(async () => {
  if (await hermesBotAlreadyServing()) {
    clientMode = true
    console.log(`HermesBot : mode client sur ${ORIGIN}`)
  } else {
    await ensureHermes()
    await startServer()
  }
  dictationGate = createDictationGate({ clientMode })
  // An agreement an earlier build kept on disk no longer counts: gone.
  fs.rmSync(path.join(app.getPath('userData'), 'dictation-consent.json'), { force: true })
  await createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch((error) => {
  console.error(error.message)
  dialog.showErrorBox('HermesBot', error.message)
  app.quit()
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  dictation.cancel()
  if (hermesTunnelProcess && !hermesTunnelProcess.killed) hermesTunnelProcess.kill('SIGTERM')
  if (vaultTunnelProcess && !vaultTunnelProcess.killed) vaultTunnelProcess.kill('SIGTERM')
})
