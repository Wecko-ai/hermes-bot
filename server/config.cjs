// Local settings for one installation. Nothing here is a secret: tokens and passwords never go in this file.
//
// Sources, highest priority first:
//   1. environment variables (HERMES_ORIGIN, HERMES_SSH_HOST, ...);
//   2. the user's config.json (HERMESBOT_CONFIG, or the app's data folder);
//   3. private/hermesbot.config.json, next to the app (a private build can ship its own defaults);
//      HERMESBOT_NO_PRIVATE=1 skips it, as the tests do;
//   4. the defaults below.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const SSH_HOST = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,254}$/

function dataDirectory(env = process.env, platform = process.platform, home = os.homedir()) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'HermesBot')
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'HermesBot')
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'HermesBot')
}

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

const text = (value, max = 256) => typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : ''
const strings = (value, max = 64) => Array.isArray(value) ? value.map((item) => text(item, 128)).filter(Boolean).slice(0, max) : []
const slugs = (value) => strings(value).filter((item) => SLUG.test(item))

function origin(value) {
  const candidate = text(value, 512)
  if (!candidate) return ''
  try {
    const url = new URL(candidate)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.pathname === '/' && !url.search && !url.hash ? url.origin : ''
  } catch {
    return ''
  }
}

/** A command is an argument list, never a shell string: nothing is interpreted. */
function command(value) {
  const argv = strings(value, 32)
  return argv.length && path.isAbsolute(argv[0]) ? argv : null
}

function merge(...layers) {
  const result = {}
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
      result[key] = value && typeof value === 'object' && !Array.isArray(value) && result[key] && typeof result[key] === 'object'
        ? merge(result[key], value)
        : value
    }
  }
  return result
}

function loadConfig({ env = process.env, platform = process.platform, home = os.homedir(), root = ROOT } = {}) {
  const dataDir = dataDirectory(env, platform, home)
  const privateDir = path.join(root, 'private')
  const usePrivate = env.HERMESBOT_NO_PRIVATE !== '1'
  const raw = merge(
    usePrivate ? readJson(path.join(privateDir, 'hermesbot.config.json')) : {},
    readJson(env.HERMESBOT_CONFIG || path.join(dataDir, 'config.json')),
  )
  const ui = raw.ui && typeof raw.ui === 'object' ? raw.ui : {}
  const localChat = raw.localChat && typeof raw.localChat === 'object' ? raw.localChat : {}
  const browserTurn = raw.browserTurn && typeof raw.browserTurn === 'object' ? raw.browserTurn : {}

  const gatewayOrigin = origin(env.HERMES_ORIGIN) || origin(raw.gatewayOrigin) || 'http://127.0.0.1:9120'
  const sshHost = text(env.HERMES_SSH_HOST) || text(raw.sshHost)
  const defaultAnimations = path.join(privateDir, 'animations')

  return {
    dataDir,
    gatewayOrigin,
    // Origin header sent to the gateway. A gateway behind a reverse proxy may only trust its public address.
    browserOrigin: origin(env.HERMES_BROWSER_ORIGIN) || origin(raw.browserOrigin) || gatewayOrigin,
    sshHost: SSH_HOST.test(sshHost) ? sshHost : '',
    ollamaOrigin: origin(env.OLLAMA_ORIGIN) || origin(raw.ollamaOrigin) || 'http://127.0.0.1:11434',
    localChat: {
      model: text(env.HERMESBOT_LOCAL_MODEL) || text(localChat.model),
      name: text(localChat.name, 64),
    },
    // Optional shared-Chrome arbiter. `command` prints one `tour[team] : <profile>` line per busy browser.
    browserTurn: {
      command: env.BROWSER_TOUR_COMMAND ? command([env.BROWSER_TOUR_COMMAND, 'statut']) : command(browserTurn.command),
      // Run `command` only as this macOS user; anyone else runs `remoteCommand` (for example over SSH).
      user: env.BROWSER_TOUR_COMMAND ? '' : text(browserTurn.user, 64),
      remoteCommand: env.BROWSER_TOUR_COMMAND ? null : command(browserTurn.remoteCommand),
    },
    animationsDir: text(env.HERMESBOT_ANIMATIONS, 4096) || text(raw.animationsDir, 4096)
      || (usePrivate && fs.existsSync(defaultAnimations) ? defaultAnimations : path.join(dataDir, 'animations')),
    // Interface preferences, sent as is to the window by /api/app-config.
    ui: {
      defaultBot: SLUG.test(text(ui.defaultBot)) ? text(ui.defaultBot) : '',
      sectionOrder: strings(ui.sectionOrder),
      userInitial: text(ui.userInitial, 2),
      userName: text(ui.userName, 64),
      hiddenProviders: slugs(ui.hiddenProviders),
      contrastAvatars: slugs(ui.contrastAvatars),
    },
  }
}

module.exports = { loadConfig, dataDirectory }
