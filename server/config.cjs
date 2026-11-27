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
// Hermes provider slugs: `custom:<name>` for the providers of config.yaml.
const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9_.:()-]{0,127}$/
const SSH_HOST = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,254}$/

function dataDirectory(env = process.env, platform = process.platform, home = os.homedir()) {
  const raw = typeof env.HERMESBOT_DATA_NAME === 'string' ? env.HERMESBOT_DATA_NAME.trim() : ''
  const folder = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(raw) ? raw : 'HermesBot'
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', folder)
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), folder)
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), folder)
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
// Video folders. Kept here so config load does not import the ESM streamer (this file is CommonJS).
function videoRoots(value, env, home) {
  const fromEnv = typeof env.HERMESBOT_VIDEO_ROOTS === 'string' ? env.HERMESBOT_VIDEO_ROOTS.split(path.delimiter) : []
  const configured = [...fromEnv, ...(Array.isArray(value) ? value : [])]
  const cleaned = []
  for (const item of configured) {
    if (typeof item !== 'string' || !item.trim() || item.length > 4096 || item.includes('\0')) continue
    const expanded = item.trim() === '~' ? home : item.trim().startsWith('~/') ? path.join(home, item.trim().slice(2)) : item.trim()
    if (!path.isAbsolute(expanded) || expanded.split(/[\\/]/).some((part) => part === '.' || part === '..')) continue
    cleaned.push(path.resolve(expanded))
    if (cleaned.length >= 32) break
  }
  if (cleaned.length) return cleaned
  // Keep in step with defaultVideoRoots in server/video-stream.mjs. External volumes go in config `videoRoots`.
  // A config `videoRoots` or HERMESBOT_VIDEO_ROOTS replaces this whole list.
  return [
    path.join(home, 'projects'),
    path.join(home, 'Movies'),
    path.join(home, 'bots-workspace'),
    path.join(home, '.hermes', 'images'),
    path.join(home, '.hermes', 'cache'),
    path.join(home, '.hermes', 'profiles'),
  ]
}
const strings = (value, max = 64) => Array.isArray(value) ? value.map((item) => text(item, 128)).filter(Boolean).slice(0, max) : []
const slugs = (value) => strings(value).filter((item) => SLUG.test(item))
const providers = (value) => strings(value).filter((item) => PROVIDER.test(item))

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

/** This desktop build talks to a gateway and to local model servers on this machine. A remote origin needs an explicit opt-in. */
function isLoopbackOrigin(value) {
  try {
    // Node reports an IPv6 hostname with the brackets (`[::1]`).
    const host = new URL(value).hostname.replace(/^\[|\]$/g, '').toLowerCase()
    return host === '127.0.0.1' || host === 'localhost' || host === '::1'
  } catch {
    return false
  }
}

function pinnedOrigin(value, allowRemote) {
  const candidate = origin(value)
  if (!candidate) return ''
  return allowRemote || isLoopbackOrigin(candidate) ? candidate : ''
}

/** A command is an argument list, never a shell string: nothing is interpreted. */
function command(value) {
  const argv = strings(value, 32)
  return argv.length && path.isAbsolute(argv[0]) ? argv : null
}

/** Secret-reading commands are stricter: no empty/non-string argument is silently dropped. */
function secretCommand(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= 32
    && value.every((argument) => typeof argument === 'string' && argument.trim().length > 0 && argument.length <= 128)
    && path.isAbsolute(value[0]) ? [...value] : null
}

/**
 * Models checked by a tiny live request before the app switches a chat to them: model-id prefix to the
 * base URL of an OpenAI Responses-compatible endpoint on this machine (a local proxy, keyless). A provider
 * that refuses a model for quota still lists it; only an answer tells. A remote base needs the remote opt-in.
 */
function modelProbes(value, allowRemote) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.entries(value).slice(0, 16).flatMap(([prefix, base]) => {
    const cleanPrefix = text(prefix, 64)
    const raw = text(base, 512)
    if (!cleanPrefix || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(cleanPrefix) || !raw) return []
    try {
      const url = new URL(raw)
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.search || url.hash || url.username || url.password) return []
      if (!allowRemote && !isLoopbackOrigin(url.origin)) return []
      return [{ prefix: cleanPrefix, base: `${url.origin}${url.pathname.replace(/\/+$/, '')}` }]
    } catch {
      return []
    }
  })
}

const POSITIVE = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0

/** Subscription quota gauges: estimated from analytics in a rolling window, never a provider API. */
function parseUsageQuotas(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const out = []
  for (const [id, entry] of Object.entries(value).slice(0, 16)) {
    const cleanId = text(id, 64)
    if (!cleanId || !PROVIDER.test(cleanId)) continue
    const row = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {}
    const windowHours = POSITIVE(row.windowHours) ? Math.min(row.windowHours, 168) : 5
    const tokenLimit = POSITIVE(row.tokenLimit) ? Math.min(row.tokenLimit, 1_000_000_000) : 0
    if (!tokenLimit) continue
    out.push({
      id: cleanId,
      label: text(row.label, 64) || cleanId,
      windowHours,
      tokenLimit,
      modelPrefixes: strings(row.modelPrefixes, 16).filter((prefix) => /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(prefix)),
    })
  }
  return out
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

function botBudgets(value) {
  const targets = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return targets
  for (const [key, raw] of Object.entries(value)) {
    const id = String(key).trim()
    const tokens = Number(raw)
    if (id && Number.isFinite(tokens) && tokens > 0) targets[id] = Math.floor(tokens)
  }
  return targets
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
  const browserTurn = raw.browserTurn && typeof raw.browserTurn === 'object' ? raw.browserTurn : {}
  const computerPanel = raw.computerPanel && typeof raw.computerPanel === 'object' ? raw.computerPanel : {}
  const llmStats = raw.llmStats && typeof raw.llmStats === 'object' ? raw.llmStats : {}
  const routines = raw.routines && typeof raw.routines === 'object' ? raw.routines : {}
  const connectors = raw.connectors && typeof raw.connectors === 'object' ? raw.connectors : {}
  const sharedMemory = raw.sharedMemory && typeof raw.sharedMemory === 'object' ? raw.sharedMemory : {}
  const features = raw.features && typeof raw.features === 'object' ? raw.features : {}
  const usageQuotas = raw.usageQuotas && typeof raw.usageQuotas === 'object' ? raw.usageQuotas : {}
  const channels = raw.channels && typeof raw.channels === 'object' ? raw.channels : {}
  const push = raw.push && typeof raw.push === 'object' ? raw.push : {}
  const skills = raw.skills && typeof raw.skills === 'object' ? raw.skills : {}
  const autoRouter = raw.autoRouter && typeof raw.autoRouter === 'object' ? raw.autoRouter : {}

  const allowRemoteGateway = raw.allowRemoteGateway === true
  const gatewayOrigin = pinnedOrigin(env.HERMES_ORIGIN, allowRemoteGateway) || pinnedOrigin(raw.gatewayOrigin, allowRemoteGateway) || 'http://127.0.0.1:9120'
  const sshHost = text(env.HERMES_SSH_HOST) || text(raw.sshHost)
  const defaultAnimations = path.join(privateDir, 'animations')

  const hermesHome = [text(env.HERMES_HOME), text(raw.hermesHome)].find((value) => value && path.isAbsolute(value)) || path.join(home, '.hermes')
  const optionalMcps = [text(env.HERMES_OPTIONAL_MCPS_DIR, 4096), text(connectors.optionalMcpsDir, 4096)].find((value) => value && path.isAbsolute(value))
    || path.join(text(env.HERMES_AGENT_DIR, 4096) || path.join(hermesHome, 'hermes-agent'), 'optional-mcps')

  return {
    dataDir,
    gatewayOrigin,
    // Home of the Hermes that runs on this machine. Only read to sign in to a gateway without a password.
    hermesHome,
    // Folders `/api/video` may read. A path outside them is never served from this disk.
    videoRoots: videoRoots(raw.videoRoots, env, home),
    optionalMcpsDir: optionalMcps,
    // Origin header sent to the gateway. A gateway behind a reverse proxy may only trust its public address.
    browserOrigin: origin(env.HERMES_BROWSER_ORIGIN) || origin(raw.browserOrigin) || gatewayOrigin,
    sshHost: SSH_HOST.test(sshHost) ? sshHost : '',
    omlxOrigin: pinnedOrigin(env.OMLX_ORIGIN, allowRemoteGateway) || pinnedOrigin(raw.omlxOrigin, allowRemoteGateway) || 'http://127.0.0.1:8000',
    splashOrigin: pinnedOrigin(env.SPLASH_ORIGIN, allowRemoteGateway) || pinnedOrigin(raw.splashOrigin, allowRemoteGateway) || 'http://127.0.0.1:8098',
    // Optional shared-Chrome arbiter. `command` prints one `tour[team] : <profile>` line per busy browser.
    browserTurn: {
      command: env.BROWSER_TOUR_COMMAND ? command([env.BROWSER_TOUR_COMMAND, 'statut']) : command(browserTurn.command),
      // Run `command` only as this macOS user; anyone else runs `remoteCommand` (for example over SSH).
      user: env.BROWSER_TOUR_COMMAND ? '' : text(browserTurn.user, 64),
      remoteCommand: env.BROWSER_TOUR_COMMAND ? null : command(browserTurn.remoteCommand),
    },
  computerPanel: {
    enabled: env.HERMESBOT_COMPUTER_PANEL === '1' || computerPanel.enabled === true,
    cdpOrigin: pinnedOrigin(env.HERMESBOT_COMPUTER_CDP_ORIGIN, false) || pinnedOrigin(computerPanel.cdpOrigin, false) || '',
  },
    modelProbes: modelProbes(raw.modelProbes, allowRemoteGateway),
    llmStats: {
      // Optional local LLM Stats snapshot, for offline display. Empty on a generic install.
      snapshotPath: [text(env.HERMESBOT_LLM_STATS_SNAPSHOT, 4096), text(llmStats.snapshotPath, 4096)]
        .find((value) => path.isAbsolute(value)) || '',
      // Trusted installation setting: argv only, never a shell string. Its stdout is the key.
      keyCommand: secretCommand(llmStats.keyCommand),
    },
    animationsDir: text(env.HERMESBOT_ANIMATIONS, 4096) || text(raw.animationsDir, 4096)
      || (usePrivate && fs.existsSync(defaultAnimations) ? defaultAnimations : path.join(dataDir, 'animations')),
    sharedMemory: {
      dir: [text(env.HERMESBOT_SHARED_MEMORY_DIR, 4096), text(sharedMemory.dir, 4096)]
        .find((value) => path.isAbsolute(value)) || '',
      // Off by default: injects a short summary into api_text each turn when enabled.
      injectContext: sharedMemory.injectContext === true,
      injectMaxChars: typeof sharedMemory.injectMaxChars === 'number' && sharedMemory.injectMaxChars > 200 && sharedMemory.injectMaxChars <= 8000
        ? Math.floor(sharedMemory.injectMaxChars) : 2000,
    },
    // Optional persistent document library (per bot). Never in the repo.
    pagesLibraryDir: [text(env.HERMESBOT_PAGES_LIBRARY, 4096), text(raw.pagesLibraryDir, 4096)]
      .find((value) => path.isAbsolute(value)) || path.join(dataDir, 'pages-library'),
    features: {
      /** Global usage across roster bots and subscription quota gauges (read-only gateway data). */
      usageGlobal: features.usageGlobal !== false,
      /** Cards, addresses and in-chat secure vault forms (keychain writes). */
      vaultWallet: features.vaultWallet === true,
      /** Persist opened pages per bot, with a library screen. */
      pagesLibrary: features.pagesLibrary === true,
    },
    usageQuotas: parseUsageQuotas(usageQuotas),
    // Interface preferences, sent as is to the window by /api/app-config.
    channels: {
      /** When false (default), the channel wizard is read-only; apply routes refuse to write. */
      wizardWrites: channels.wizardWrites === true,
    },
    push: {
      /** Empty (default): iPhone push relay disabled. Loopback URLs only unless remote gateway opt-in is set. */
      relayUrl: pinnedOrigin(text(env.HERMESBOT_PUSH_RELAY, 512), allowRemoteGateway) || pinnedOrigin(text(push.relayUrl, 512), allowRemoteGateway) || '',
      /** Trusted argv whose stdout is the shared relay secret (never stored on disk by the app). */
      secretCommand: secretCommand(push.secretCommand),
    },
    ui: {
      defaultBot: SLUG.test(text(ui.defaultBot)) ? text(ui.defaultBot) : '',
      sectionOrder: strings(ui.sectionOrder),
      rosterOrder: (() => {
        if (!ui.rosterOrder || typeof ui.rosterOrder !== 'object' || Array.isArray(ui.rosterOrder)) return {}
        const roster = {}
        for (const [key, list] of Object.entries(ui.rosterOrder)) {
          const section = text(key, 128)
          if (!section || !Array.isArray(list)) continue
          const slugs = list.map((item) => text(item)).filter((item) => SLUG.test(item)).slice(0, 200)
          if (slugs.length) roster[section] = slugs
        }
        return roster
      })(),
      userInitial: text(ui.userInitial, 2),
      userName: text(ui.userName, 64),
      hiddenProviders: slugs(ui.hiddenProviders),
      // Providers paid by a flat subscription: zero-spend mode keeps them, as they cost nothing more.
      subscriptionProviders: providers(ui.subscriptionProviders),
      // Used only until the shared file has a zeroSpend value. Generic installs keep the old default.
      zeroSpendDefault: ui.zeroSpendDefault === true,
      contrastAvatars: slugs(ui.contrastAvatars),
      // Name shown for the voice mode (empty: the interface's own name for it).
      voiceModeName: text(ui.voiceModeName, 32),
      // Listen on each assistant reply (macOS speech via Electron). Off by default.
      replyListenButton: ui.replyListenButton === true,
    },
    routines: {
      editable: routines.editable !== false,
      /** Event-driven routines (local webhooks + Gmail polling). Off by default. */
      eventTriggers: routines.eventTriggers === true,
    },
    connectors: {
      enabled: connectors.enabled !== false,
      optionalMcpsDir: optionalMcps,
    },
    skills: {
      hubManage: skills.hubManage !== false,
    },
    autoRouter: {
      /** Automatic model routing (classifier + local scoring table). Off by default. */
      enabled: autoRouter.enabled === true,
      logDir: [text(env.HERMESBOT_AUTO_ROUTER_LOG, 4096), text(autoRouter.logDir, 4096)]
        .find((value) => path.isAbsolute(value)) || '',
      tablePath: [text(env.HERMESBOT_AUTO_ROUTER_TABLE, 4096), text(autoRouter.tablePath, 4096)]
        .find((value) => path.isAbsolute(value)) || '',
      /** Soft daily token targets per bot id, from the (private) config. Empty by default: every bot gets the generic target. */
      botBudgets: botBudgets(autoRouter.botBudgets),
    },
  }
}

module.exports = { loadConfig, dataDirectory, modelProbes }
