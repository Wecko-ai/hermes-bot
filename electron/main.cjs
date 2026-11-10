const { app, BrowserWindow, shell, dialog, safeStorage, ipcMain } = require('electron')
const { spawn } = require('node:child_process')
const path = require('node:path')
const http = require('node:http')
const { pathToFileURL } = require('node:url')
const fs = require('node:fs')

const ORIGIN = 'http://127.0.0.1:4330'
// Réglages facultatifs : variables d’environnement, sinon config.json dans le dossier de données de l’app.
const config = readConfig()
const HERMES_ORIGIN = process.env.HERMES_ORIGIN || config.gatewayOrigin || 'http://127.0.0.1:9120'
const HERMES_BROWSER_ORIGIN = process.env.HERMES_BROWSER_ORIGIN || config.browserOrigin || ''
const SSH_HOST = process.env.HERMES_SSH_HOST || config.sshHost || ''
let hermesTunnelProcess
let vaultTunnelProcess
let hermesTunnelRestart
let mainWindow

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'config.json'), 'utf8'))
  } catch {
    return {}
  }
}

async function startServer() {
  process.env.NODE_ENV = 'production'
  process.env.PORT = '4330'
  process.env.HERMES_ORIGIN = HERMES_ORIGIN
  if (HERMES_BROWSER_ORIGIN) process.env.HERMES_BROWSER_ORIGIN = HERMES_BROWSER_ORIGIN
  configureSessionPersistence()
  const { listening } = await import(pathToFileURL(path.join(__dirname, '..', 'server', 'index.mjs')).href)
  try {
    await listening
  } catch (error) {
    if (error.code === 'EADDRINUSE') throw new Error(`Le port ${error.port || 4330} est déjà pris. Quitte l’autre copie de HermesBot, puis relance.`)
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

function tunnelHasExited(tunnel) {
  return tunnel.exitCode !== null || tunnel.signalCode !== null
}

async function openHermesTunnel() {
  if (!SSH_HOST) throw new Error(`Hermes ne répond pas sur ${HERMES_ORIGIN}. Lance la gateway, ou renseigne sshHost pour ouvrir un tunnel SSH.`)
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
    if (tunnelError) throw new Error(`Tunnel SSH ${SSH_HOST}: ${tunnelError.message}`)
    if (await hermesReady()) {
      openVaultTunnel()
      return
    }
    if (tunnelHasExited(tunnel)) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Hermes est absent. Le tunnel SSH ${SSH_HOST} ne répond pas.`)
}

/**
 * Coffre du Chrome partagé : il vit sur la machine des bots, avec le trousseau. Son port 4331 passe par un ssh à
 * part, pour qu’un port déjà pris n’empêche jamais la connexion à Hermes.
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
 * Bouton ↻ : après une veille, le ssh lancé au démarrage peut être mort, ou vivant mais muet
 * et gardant le port 9120. On l'arrête donc avant d'en ouvrir un autre. Sans tunnel au
 * démarrage (gateway locale), il n'y a rien à relancer.
 */
function restartHermesTunnel() {
  hermesTunnelRestart ??= (async () => {
    if (!hermesTunnelProcess) return
    // Le ssh du coffre a pu mourir seul pendant une veille, même si Hermes répond encore.
    openVaultTunnel()
    if (await hermesReady()) return
    await stopHermesTunnel()
    await openHermesTunnel()
  })().finally(() => { hermesTunnelRestart = null })
  return hermesTunnelRestart
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 860,
    minHeight: 600,
    title: 'HermesBot',
    backgroundColor: '#e9efec',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Le lecteur PDF de Chromium est un plugin : sans ce réglage, l’onglet document reste vide.
      plugins: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  // Un fichier lâché hors de la zone de dépôt, ou un lien d’une page de bot, ne doit jamais remplacer l’app.
  const leavesApp = (url) => /^(?:https?|file):/.test(url) && !url.startsWith(`${ORIGIN}/`)
  mainWindow.webContents.on('will-navigate', (event) => { if (leavesApp(event.url)) event.preventDefault() })
  mainWindow.webContents.on('will-frame-navigate', (event) => { if (leavesApp(event.url)) event.preventDefault() })
  await mainWindow.loadURL(ORIGIN)
  mainWindow.on('closed', () => { mainWindow = null })
}

ipcMain.handle('hermes-bot:restart-tunnel', (event) => {
  if (!event.senderFrame?.url.startsWith(`${ORIGIN}/`)) throw new Error('Origine refusée.')
  return restartHermesTunnel()
})

app.whenReady().then(async () => {
  await ensureHermes()
  await startServer()
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
  if (hermesTunnelProcess && !hermesTunnelProcess.killed) hermesTunnelProcess.kill('SIGTERM')
  if (vaultTunnelProcess && !vaultTunnelProcess.killed) vaultTunnelProcess.kill('SIGTERM')
})
