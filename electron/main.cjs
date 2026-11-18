const { installProcessGuards } = require('./process-guards.cjs')
// The embedded server runs in this process. A missed error is logged (message and stack only)
// and the app stays up. Registered before that server module is imported.
installProcessGuards()

const { app, BrowserWindow, shell, dialog, safeStorage, ipcMain, nativeTheme } = require('electron')
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
const { createSpeech, maySay } = require('./speech.cjs')
const { createDictationGate } = require('./dictation-gate.cjs')
const { revealMedia } = require('./reveal-media.cjs')
const { readEncrypted, writeEncrypted } = require('./encrypted-store.cjs')
const { guardNavigation } = require('./navigation.cjs')
const { grantPermission, grantDevicePermission } = require('./permissions.cjs')
const { sshForwardArgs, stopTunnel } = require('./ssh-tunnel.cjs')
const { adoptEnvironmentVaultToken, currentVaultToken, envWithoutVaultToken, rememberVaultToken } = require('./vault-token.cjs')

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
let pendingSecondInstance = false
// Who may turn the microphone on (dictation-gate.cjs).
let dictationGate
// Proof, for this process's server, that a sign-in without a password comes from this window.
let localKey = ''

// Vault admin token: memory only. Children spawned below get an env without it.
globalThis.__hermesBotVaultToken = ''
adoptEnvironmentVaultToken(process.env)

const storeIo = {
  readFile: (file) => fs.readFileSync(file),
  decrypt: (bytes) => safeStorage.decryptString(bytes),
  writeFile: (file, bytes, options) => fs.writeFileSync(file, bytes, options),
  rename: (from, to) => fs.renameSync(from, to),
  encrypt: (json) => safeStorage.encryptString(json),
  remove: (file) => fs.rmSync(file, { force: true }),
}

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
  fs.mkdirSync(directory, { recursive: true })
  const bind = (file, missing) => ({
    load: () => readEncrypted(file, { readFile: storeIo.readFile, decrypt: storeIo.decrypt, missing }),
    save: (json) => writeEncrypted(file, json, storeIo),
  })
  const sessions = bind(path.join(directory, 'hermes-sessions.bin'), '')
  globalThis.__hermesBotSessionPersistence = sessions
  const credentials = path.join(directory, 'hermes-credentials.bin')
  globalThis.__hermesBotCredentialStore = {
    ...bind(credentials, ''),
    clear: () => fs.rmSync(credentials, { force: true }),
  }
  // Local chat. `null`: no file yet. An unreadable file throws: the server then refuses to write over it.
  globalThis.__hermesBotLocalChatStore = bind(path.join(directory, 'local-chat.bin'), null)
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

function tunnelChildEnv() {
  return envWithoutVaultToken(process.env)
}

async function openHermesTunnel() {
  if (!SSH_HOST) throw new Error(text().noGateway(HERMES_ORIGIN))
  const port = new URL(HERMES_ORIGIN).port || '9120'
  const tunnelCwd = app.getPath('userData')
  fs.mkdirSync(tunnelCwd, { recursive: true })
  let tunnelError = null
  const tunnel = spawn('/usr/bin/ssh', sshForwardArgs(port, SSH_HOST), {
    cwd: tunnelCwd, stdio: 'ignore', env: tunnelChildEnv(),
  })
  hermesTunnelProcess = tunnel
  tunnel.once('error', (error) => { tunnelError = error })
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (tunnelError) throw new Error(text().tunnelFailed(SSH_HOST, tunnelError.message))
    if (await hermesReady()) {
      openVaultTunnel()
      return
    }
    if (tunnel.exitCode !== null || tunnel.signalCode !== null) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(text().tunnelSilent(SSH_HOST))
}

/**
 * Shared Chrome vault on 127.0.0.1:4331. Its own ssh, so a port already in use never
 * blocks the connection to Hermes.
 */
function openVaultTunnel() {
  if (vaultTunnelProcess && vaultTunnelProcess.exitCode === null && vaultTunnelProcess.signalCode === null) return
  const tunnel = spawn('/usr/bin/ssh', sshForwardArgs(4331, SSH_HOST), {
    cwd: app.getPath('userData'), stdio: 'ignore', env: tunnelChildEnv(),
  })
  tunnel.once('error', () => undefined)
  vaultTunnelProcess = tunnel
  fetchVaultToken()
}

/** Vault admin token, read over SSH when it is not already in memory. Never stored in the environment. */
function fetchVaultToken() {
  if (/^[0-9a-f]{64}$/.test(currentVaultToken())) return
  execFile('/usr/bin/ssh', [
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '--', SSH_HOST, 'cat',
    '"Library/Application Support/HermesBot/vault-admin.token"',
  ], { timeout: 15_000, env: tunnelChildEnv() }, (error, stdout) => {
    if (!error) rememberVaultToken(String(stdout || '').trim())
  })
}

async function ensureHermes() {
  if (!(await hermesReady())) await openHermesTunnel()
}

function stopHermesTunnel() {
  return stopTunnel(hermesTunnelProcess)
}

function stopVaultTunnel() {
  return stopTunnel(vaultTunnelProcess)
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
  onMicrophone: (open) => {
    microphoneOpen = open
    app.dock?.setBadge(open ? '●' : '')
  },
})
// Speech output (speech.cjs): the same helper, `speak` mode. Output only, so no gesture is needed; the
// half-duplex rule (no voice while the microphone is open) is enforced in the `speech-say` handler.
let microphoneOpen = false
const speech = createSpeech({
  helperPath: DICTATION_HELPER,
  onEvent: (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('hermes-bot:speech-event', event)
  },
})

function installPermissionHandlers(ses) {
  ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    callback(grantPermission(permission, {
      origin: ORIGIN,
      isMainFrame: details?.isMainFrame === true,
      requestingUrl: details?.requestingUrl,
    }))
  })
  ses.setPermissionCheckHandler((_webContents, permission, _requestingOrigin, details) => grantPermission(permission, {
    origin: ORIGIN,
    isMainFrame: details?.isMainFrame === true,
    requestingUrl: details?.requestingUrl,
  }))
  ses.setDevicePermissionHandler(() => grantDevicePermission())
}

function windowInFront(win = mainWindow) {
  if (!win || win.isDestroyed()) return false
  return win.isFocused() && win.isVisible() && !win.isMinimized()
}

function showMainWindow() {
  const win = mainWindow
  if (!win || win.isDestroyed()) return false
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  return true
}

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
  // app's own page without a target opens outside, like the chat's links. A redirect is held to the same rule.
  // A document iframe may load only /api/document, plus the PDF viewer and about:blank (navigation.cjs).
  mainWindow.webContents.on('will-navigate', (event) => {
    guardNavigation(
      { url: event.url, isMainFrame: true, preventDefault: () => event.preventDefault() },
      { origin: ORIGIN, openOutside },
    )
  })
  mainWindow.webContents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) return
    guardNavigation(event, { origin: ORIGIN })
  })
  mainWindow.webContents.on('will-redirect', (event, url, _isInPlace, isMainFrame) => {
    const details = {
      url: typeof event.url === 'string' ? event.url : url,
      isMainFrame: typeof event.isMainFrame === 'boolean' ? event.isMainFrame : isMainFrame === true,
      preventDefault() { event.preventDefault() },
    }
    guardNavigation(details, { origin: ORIGIN, openOutside })
  })
  const ses = mainWindow.webContents.session
  installPermissionHandlers(ses)
  // The key rides on one request only, from this window, and never reaches the page's own code.
  ses.webRequest.onBeforeSendHeaders({ urls: [`${ORIGIN}/api/auth/local`] }, (details, callback) => {
    const headers = { ...details.requestHeaders }
    if (localKey && mainWindow && details.webContentsId === mainWindow.webContents.id) headers['X-HermesBot-Local-Key'] = localKey
    callback({ requestHeaders: headers })
  })
  // Dictation: a deliberate press in this window, seen here, is what may open a session: a click,
  // or Enter pressed once. Space is ordinary typing and does not count (dictation-gate.cjs).
  // One gesture authorizes one prepare. A page cannot fake the gesture. The microphone closes
  // as soon as the window is no longer in front (the page does too, but the main process does not
  // count on it): `stop` turns it off at once and lets the words already said through.
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
    if (event.isMainFrame && !event.isSameDocument) {
      dictationGate?.disarm()
      dictation.cancel()
      speech.stop()
    }
  })
  mainWindow.webContents.on('render-process-gone', () => {
    dictationGate?.disarm()
    dictation.cancel()
    speech.stop()
  })
  mainWindow.on('closed', () => {
    dictationGate?.disarm()
    dictation.cancel()
    speech.dispose()
    mainWindow = null
  })
  await mainWindow.loadURL(ORIGIN)
}

// Dictation and reveal: only from this window's own top frame, on the app's origin.
// restart-tunnel and focus-window use the same check.
function fromWindow(event) {
  return Boolean(mainWindow)
    && event.sender === mainWindow.webContents
    && Boolean(event.senderFrame) && !event.senderFrame.parent
    && event.senderFrame.url.startsWith(`${ORIGIN}/`)
}

ipcMain.handle('hermes-bot:restart-tunnel', (event) => {
  if (!fromWindow(event)) throw new Error(text().forbiddenOrigin())
  return restartHermesTunnel()
})

// A notification click brings the window forward. This is not a dictation gesture, and it is not
// the focus check that arms the microphone (that check reads the window after prepare returns).
ipcMain.handle('hermes-bot:focus-window', (event) => {
  if (!fromWindow(event)) throw new Error(text().forbiddenOrigin())
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  app.focus({ steal: true })
  mainWindow.focus()
})

// A media path named by a bot opens in this Mac's Finder, never as a file: URL in the page.
ipcMain.handle('hermes-bot:reveal-media', (event, mediaPath) => {
  if (!fromWindow(event)) return false
  return revealMedia(mediaPath, { reveal: (localPath) => shell.showItemInFolder(localPath) })
})

ipcMain.handle('hermes-bot:dictation-prepare', async (event, localeId) => {
  const gate = dictationGate
  if (!fromWindow(event) || !gate) return { ...UNAVAILABLE }
  const token = gate.mayPrepare()
  if (!token) return { ...UNAVAILABLE }
  const state = await dictation.prepare(localeId)
  if (state.access === 'granted' && windowInFront()) gate.armStart(token)
  return state
})
ipcMain.handle('hermes-bot:dictation-start', (event, options) => {
  if (!fromWindow(event) || !dictationGate || !mainWindow || mainWindow.isDestroyed()) return false
  const visible = mainWindow.isVisible() && !mainWindow.isMinimized()
  if (!dictationGate.takeStart({ focused: mainWindow.isFocused(), visible })) return false
  // Half-duplex: the voice is silenced before the microphone opens.
  if (speech.isSpeaking()) speech.stop()
  return dictation.start(options, { maxListenMs: dictationGate.maxListenMs() })
})
// Stopping is always safe: it only turns the microphone off.
ipcMain.handle('hermes-bot:dictation-stop', (event) => { if (fromWindow(event)) dictation.stop() })
ipcMain.handle('hermes-bot:dictation-cancel', (event) => { if (fromWindow(event)) dictation.cancel() })

// Speech output: same origin check, no gesture (output only). Refused while the microphone is open.
ipcMain.handle('hermes-bot:speech-voices', (event) => (fromWindow(event) ? speech.voices() : []))
ipcMain.handle('hermes-bot:speech-say', (event, utterance) => {
  if (!fromWindow(event)) return false
  if (!maySay({ microphoneOpen, dictationActive: dictation.active })) return false
  return speech.say(utterance)
})
ipcMain.handle('hermes-bot:speech-stop', (event) => { if (fromWindow(event)) speech.stop() })

// Quit through the app so before-quit runs: both ssh tunnels, then the dictation helper.
let tunnelsClosed = false
let closingTunnels = false
app.on('before-quit', (event) => {
  if (tunnelsClosed) return
  event.preventDefault()
  if (closingTunnels) return
  closingTunnels = true
  try { dictation.dispose() } catch { /* helper already gone */ }
  try { speech.dispose() } catch { /* helper already gone */ }
  Promise.all([stopHermesTunnel(), stopVaultTunnel()]).finally(() => {
    tunnelsClosed = true
    app.quit()
  })
})
app.on('window-all-closed', () => app.quit())
process.on('SIGTERM', () => app.quit())
process.on('SIGINT', () => app.quit())

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!showMainWindow()) pendingSecondInstance = true
  })
  app.whenReady().then(async () => {
    await ensureHermes()
    await startServer()
    dictationGate = createDictationGate()
    // An agreement an earlier build kept on disk is never read. Remove the leftover.
    fs.rmSync(path.join(app.getPath('userData'), 'dictation-consent.json'), { force: true })
    await createWindow()
    if (pendingSecondInstance) {
      pendingSecondInstance = false
      showMainWindow()
    }
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : 'startup failed')
    dialog.showErrorBox('HermesBot', error instanceof Error ? error.message : 'startup failed')
    app.quit()
  })
}
