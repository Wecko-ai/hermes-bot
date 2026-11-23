import http from 'node:http'
import { readFileSync } from 'node:fs'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable, pipeline } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { browserTurnCommand, readBrowserTurns } from './browser-turn.mjs'
import { createComputerPanelService } from './computer-panel/service.mjs'
import { ComputerPanelError } from './computer-panel/errors.mjs'
import configModule from './config.cjs'
import { attachGatewayUpgrade } from './gateway-upgrade.mjs'
import { DOCUMENT_TEXT_MAX_BYTES, IMAGE_MAX_BYTES, createByteCap, forwardRequestHeaders, isApiPath, readCappedText, relayLimitStatus, staticCacheControl } from './http-limits.mjs'
import { createLocalGateway } from './local-gateway.mjs'
import { LOCAL_HISTORY_LIMITS, createLocalChatHistory } from './local-chat-history.mjs'
import { LOCAL_CHAT_IDLE, LOCAL_CHAT_KEEP, LOCAL_CHAT_OPTIONS, createLocalMemory } from './local-memory.mjs'
import { createModelProbe } from './model-probe.mjs'
import { createModelScores } from './model-scores.mjs'
import { installProcessGuards } from './process-guards.mjs'
import { createSessionStore, credentialsForRestore } from './sessions.mjs'
import { SHARED_SETTINGS_MAX_BYTES, SHARED_SETTINGS_PATH, relaySharedSettingsGet, relaySharedSettingsPut, sharedSettingsFrom, sharedSettingsText, parseSharedSettings, withKeptCompaction } from './shared-settings.mjs'
import { COMPACTION_BODY_MAX_BYTES, applyCompaction, compactionFrom, compressionOfConfig, gaugeFrom, profilesFrom } from './compaction.mjs'
import {
  MEMORY_BODY_MAX_BYTES, MEMORY_ENTRY_MAX_BYTES, MEMORY_TYPES, ensureStore, filePath, memoryDir, memoryType, parseMemoryFile,
  removeEntry, searchEntries, summarizeForTurn, upsertEntry,
} from './shared-memory.mjs'
import { listSkillsCatalog, skillToggleBody } from './skills-catalog.mjs'
import {
  PROFILE_SLUG, SOUL_MAX_BYTES, TEMPLATE_MAX_BYTES, diffLines, exportTemplate, importTemplateBody, modelFromConfig,
  soulPath, toolsetsBody, toolsetsFromConfig,
} from './bot-profile.mjs'
import {
  backupPath, channelStatusFromKeys, configPatchFor, envKeysPresent, mergeEnvText, profileConfigPath, profileEnvPath,
  validateChannelEnvBody, validateChannelRequest,
} from './channels.mjs'
import { createPushRelay } from './push-relay.mjs'
import { pushAccountId } from './push-account.mjs'
import { loadUiLayout, normalizeUiLayout, saveUiLayout } from './ui-layout.mjs'
import { postVaultLogout, reduceVaultPoll, selectVaultToken, vaultRequestHeaders } from './vault-client.mjs'
import { previewSchedule } from './cron-schedule.mjs'
import { createMissingEmailAdapter } from './routine-events/email-adapter.mjs'
import { fireRoutineWithExtra } from './routine-events/fire.mjs'
import { createRoutineEventHandlers } from './routine-events/handlers.mjs'
import { createRoutineEventStore, EVENT_ONLY_SCHEDULE } from './routine-events/store.mjs'
import { startEmailWatcher } from './routine-events/watcher.mjs'
import { loadConnectorsCatalog } from './connectors-catalog.mjs'
import { aggregateAnalytics, estimateQuotas, profilesFromQuery } from './usage-global.mjs'
import { PagesLibrary } from './pages-library.mjs'
import { createAutoRouter, resolveAutoRouterPaths } from './auto-router/decide.mjs'
import { appendRoutingLog, readRoutingLog, sanitizeLogEntry, summarizeRoutingLog } from './auto-router/log.mjs'
import { estimateTokenCost, loadScoringTable } from './auto-router/scorer.mjs'

const CONFIG = configModule.loadConfig()
const SHARED_MEMORY_DIR = memoryDir(CONFIG.sharedMemory.dir, CONFIG.dataDir)
void ensureStore(SHARED_MEMORY_DIR).catch(() => {})
const pagesLibrary = new PagesLibrary(CONFIG.pagesLibraryDir)
const HOST = '127.0.0.1'
const PORT = Number(process.env.PORT || 4330)
const HERMES_ORIGIN = CONFIG.gatewayOrigin
const HERMES_BROWSER_ORIGIN = CONFIG.browserOrigin
const BROWSER_TURN_COMMAND = browserTurnCommand(CONFIG.browserTurn)
const CHROME_TEAMS_FILE = process.env.HERMESBOT_CHROME_TEAMS || path.join(os.homedir(), '.config', 'chrome-teams.json')
const computerPanel = createComputerPanelService({
  enabled: CONFIG.computerPanel.enabled,
  chromeTeamsFile: CHROME_TEAMS_FILE,
  chromeTeams: CONFIG.computerPanel.cdpOrigin ? null : undefined,
  cdpOrigin: CONFIG.computerPanel.cdpOrigin || process.env.HERMESBOT_COMPUTER_CDP_ORIGIN || '',
  browserTurnCommand: BROWSER_TURN_COMMAND,
})
const HERMES_WS_ORIGIN = HERMES_ORIGIN.replace(/^http/, 'ws')
const DEVELOPMENT = process.env.NODE_ENV !== 'production'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const autoRouterPaths = resolveAutoRouterPaths(CONFIG, ROOT)
const autoRouterTablePath = CONFIG.autoRouter?.tablePath || autoRouterPaths.tablePath
let autoRouterTableCache = { mtime: 0, table: null }
async function loadAutoRouterTable() {
  try {
    const { stat, readFile } = await import('node:fs/promises')
    const st = await stat(autoRouterTablePath)
    if (autoRouterTableCache.table && autoRouterTableCache.mtime === st.mtimeMs) return autoRouterTableCache.table
    const table = await loadScoringTable(autoRouterTablePath)
    autoRouterTableCache = { mtime: st.mtimeMs, table }
    return table
  } catch {
    return { models: {} }
  }
}

let autoRouterQuotaCache = { at: 0, quotas: [] }
async function quotasForAutoRouter(request, profileSlugs) {
  const now = Date.now()
  if (now - autoRouterQuotaCache.at < 60_000) return autoRouterQuotaCache.quotas
  if (!CONFIG.features.usageGlobal || !CONFIG.usageQuotas.length) {
    autoRouterQuotaCache = { at: now, quotas: [] }
    return []
  }
  const profiles = profilesFromQuery(Array.isArray(profileSlugs) ? profileSlugs.join(',') : String(profileSlugs || ''))
  const roster = profiles.length ? profiles : []
  if (!roster.length) {
    autoRouterQuotaCache = { at: now, quotas: [] }
    return []
  }
  const results = await Promise.all(roster.slice(0, 32).map(async (profile) => {
    try {
      const upstream = await hermesFetch(request, `/api/analytics/usage?${new URLSearchParams({ profile, days: '1' })}`)
      if (!upstream.ok) return { profile, error: upstream.status }
      const body = await upstream.json()
      return { profile, body }
    } catch {
      return { profile, error: 'unavailable' }
    }
  }))
  const summary = aggregateAnalytics(results, 1)
  const quotas = estimateQuotas(summary, CONFIG.usageQuotas)
  autoRouterQuotaCache = { at: now, quotas }
  return quotas
}

const autoRouter = CONFIG.autoRouter?.enabled
  ? createAutoRouter({
    tablePath: autoRouterTablePath,
    logDir: CONFIG.autoRouter.logDir || autoRouterPaths.logDir,
    subscriptions: CONFIG.ui.subscriptionProviders || [],
    resolveQuotas: async () => autoRouterQuotaCache.quotas,
  })
  : null
const DIST = path.join(ROOT, 'dist')
const REPO_SKILLS_DIR = path.join(ROOT, 'skills')
const LOCAL_ORIGINS = new Set([
  `http://${HOST}:${PORT}`,
  `http://localhost:${PORT}`,
])
// A Hermes gateway without a password, its default setup on one machine: see local-gateway.mjs.
const localGateway = createLocalGateway({ gatewayOrigin: HERMES_ORIGIN, hermesHome: CONFIG.hermesHome })
const pushRelay = createPushRelay({ relayUrl: CONFIG.push?.relayUrl || '', secretCommand: CONFIG.push?.secretCommand || null })
const routineEventStore = createRoutineEventStore(CONFIG.dataDir)
async function fetchGatewayForEvents(route, options = {}) {
  const check = await localGateway.check()
  if (check?.ok) return localGateway.fetch(route, options)
  const active = [...sessions.values()].find((session) => session.cookieHeader)
  if (active) {
    const request = { headers: { cookie: active.cookieHeader || `${SESSION_COOKIE}=${active.id}`, origin: [...LOCAL_ORIGINS][0] } }
    return hermesFetch(request, route, options)
  }
  return localGateway.fetch(route, options)
}

const routineEvents = createRoutineEventHandlers({
  store: routineEventStore,
  fetchGateway: fetchGatewayForEvents,
  host: HOST,
  port: PORT,
  enabled: CONFIG.routines?.eventTriggers === true,
})
const emailWatcher = CONFIG.routines?.eventTriggers === true
  ? startEmailWatcher({
    store: routineEventStore,
    adapter: createMissingEmailAdapter(),
    fire: fireRoutineWithExtra,
    fetchGateway: fetchGatewayForEvents,
    pollMs: 60_000,
  })
  : null
emailWatcher?.start()
// Signing in without a password needs a proof that the caller is the person who runs this server: any
// process of any account on this machine can reach this port. The desktop app gives its key to its own
// window. Started by hand, the server prints a sign-in link that carries the key.
const APP_LOCAL_KEY = typeof globalThis.__hermesBotLocalKey === 'string' && globalThis.__hermesBotLocalKey.length >= 32
const LOCAL_KEY = APP_LOCAL_KEY ? globalThis.__hermesBotLocalKey : randomBytes(32).toString('base64url')

function json(response, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  })
  response.end(data)
}

function localRequest(request) {
  const host = request.headers.host || ''
  if (!new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]).has(host)) return false
  const origin = request.headers.origin
  return !origin || LOCAL_ORIGINS.has(origin)
}

async function bodyJson(request, limit = 32_768) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw new Error('payload_too_large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

const SESSION_COOKIE = 'hermesbot_session'
const SESSION_MAX_AGE = 30 * 24 * 60 * 60
const persistence = globalThis.__hermesBotSessionPersistence
const credentialStore = globalThis.__hermesBotCredentialStore
// Shared Chrome vault: a separate service on the bots' machine (LaunchAgent), the only one that reads the keychain.
// From another Mac, the app reaches it through its SSH tunnel, on the same local port.
const BROWSER_VAULT_PORT = Number(process.env.BROWSER_VAULT_PORT || 4331)
if (!Number.isInteger(BROWSER_VAULT_PORT) || BROWSER_VAULT_PORT < 1 || BROWSER_VAULT_PORT > 65535) throw new Error('Invalid BROWSER_VAULT_PORT')
const BROWSER_VAULT_ORIGIN = `http://127.0.0.1:${BROWSER_VAULT_PORT}`
// Vault admin API token: a local file on the vault's machine, or a value
// fetched over SSH and set in memory by the app when it runs elsewhere.
const VAULT_TOKEN_FILE = process.env.HERMESBOT_VAULT_TOKEN_FILE
  || path.join(os.homedir(), 'Library/Application Support/HermesBot/vault-admin.token')
function vaultToken() {
  return selectVaultToken(globalThis.__hermesBotVaultToken, process.env.HERMESBOT_VAULT_TOKEN, () => readFileSync(VAULT_TOKEN_FILE, 'utf8'))
}

const sessionStore = createSessionStore(persistence)
const sessions = sessionStore.sessions
const persistSessions = () => sessionStore.persist()

function browserSession(request) {
  const cookies = String(request.headers.cookie || '').split(';')
  const pair = cookies.map((value) => value.trim().split('=')).find(([name]) => name === SESSION_COOKIE)
  if (!pair) return null
  const id = pair.slice(1).join('=')
  const session = sessions.get(id)
  if (!session) return null
  if (session.expiresAt <= Date.now()) {
    sessions.delete(id)
    persistSessions()
    return null
  }
  return session
}

function updateCookies(session, setCookies) {
  if (!session) return
  for (const cookie of setCookies) {
    const [pair] = cookie.split(';')
    const separator = pair.indexOf('=')
    if (separator < 1) continue
    const name = pair.slice(0, separator).trim()
    const value = pair.slice(separator + 1).trim()
    if (!value || /max-age=0(?:\D|$)/i.test(cookie)) session.cookies.delete(name)
    else session.cookies.set(name, value)
  }
  session.cookieHeader = [...session.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
  if (setCookies.length && sessions.has(session.id)) persistSessions()
}

function createSession(setCookies, kind = 'cookie') {
  const id = randomBytes(32).toString('base64url')
  const session = { id, kind, cookies: new Map(), cookieHeader: '', expiresAt: Date.now() + SESSION_MAX_AGE * 1000 }
  updateCookies(session, setCookies)
  sessions.set(id, session)
  persistSessions()
  return session
}

function adoptableCookieHeader(request) {
  const cookies = String(request.headers.cookie || '').split(';').map((value) => value.trim()).filter((value) => /^(?:__Host-|__Secure-)?hermes_/.test(value))
  return cookies.join('; ')
}

function createAdoptedSession(cookieHeader) {
  if (!cookieHeader) return null
  const session = createSession(cookieHeader.split(';').map((value) => value.trim()))
  return session
}

async function hermesFetch(request, route, options = {}) {
  const headers = new Headers(options.headers)
  const session = browserSession(request)
  // A streamed media has no maximum duration: its caller handles stopping.
  const signal = options.signal || AbortSignal.timeout(options.timeout || 20_000)
  if (session?.kind === 'local') {
    // The token goes out for a session opened with the local key, and for no other request: attached
    // by default, it would hand the gateway to every process that reaches this port. The module adds
    // it itself, on a connection it has checked. No cookie and no Origin: the gateway reads the token alone.
    const response = await localGateway.fetch(route, { method: options.method || 'GET', headers, body: options.body, signal })
    // Refused: Hermes replaced its token or changed its sign-in. The next call looks again.
    if (response.status === 401) localGateway.invalidate()
    return response
  }
  const cookieHeader = session?.cookieHeader || adoptableCookieHeader(request)
  if (cookieHeader) headers.set('cookie', cookieHeader)
  headers.set('origin', HERMES_BROWSER_ORIGIN)
  const response = await fetch(`${HERMES_ORIGIN}${route}`, {
    method: options.method || 'GET',
    headers,
    body: options.body,
    redirect: 'manual',
    signal,
  })
  updateCookies(session, response.headers.getSetCookie?.() || [])
  return response
}

async function proxyJson(response, upstream) {
  let text
  try {
    text = await readCappedText(upstream)
  } catch {
    await upstream.body?.cancel?.().catch(() => {})
    return json(response, 502, { error: 'hermes_unavailable' })
  }
  response.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  response.end(text)
}

const sessionCookie = (session) => `${SESSION_COOKIE}=${session.id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE}`

function passwordLogin(request, { provider, username, password }) {
  return hermesFetch(request, '/auth/password-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, username, password, next: '/' }),
  })
}

async function handleLogin(request, response) {
  const body = await bodyJson(request)
  const provider = String(body.provider || 'basic').slice(0, 128)
  const username = String(body.username || '')
  const password = String(body.password || '')
  if (!username || !password || password.length > 4096) {
    return json(response, 400, { error: 'invalid_login' })
  }
  const upstream = await passwordLogin(request, { provider, username, password })
  if (!upstream.ok) return proxyJson(response, upstream)
  // Checked: encrypted by the Keychain, never sent back to the interface. Unchecked: whatever was kept is forgotten.
  if (credentialStore) {
    if (body.remember === true) credentialStore.save(JSON.stringify({ provider, username, password }))
    else credentialStore.clear()
  }
  const session = createSession(upstream.headers.getSetCookie?.() || [])
  const text = await upstream.text()
  response.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Set-Cookie': sessionCookie(session),
  })
  response.end(text)
}

let credentialFailureLogged = false
function savedCredentials() {
  const loaded = credentialsForRestore(credentialStore)
  // A locked keychain throws. That is "nothing saved": do not write over the file.
  if (loaded.unreadable) {
    if (!credentialFailureLogged) {
      credentialFailureLogged = true
      console.error('HermesBot: credential store unreadable')
    }
    return null
  }
  return loaded.credentials
}

/** The Hermes session expired: sign in again with the saved credentials, with no screen. */
async function handleRestore(request, response) {
  if (!LOCAL_ORIGINS.has(request.headers.origin)) return json(response, 403, { error: 'forbidden_origin' })
  // The Origin can be imitated: without a local cookie, another process on the machine would get a session.
  const session = browserSession(request)
  if (!session) return json(response, 404, { error: 'no_local_session' })
  if (session.kind === 'local') {
    // Nothing to replay: look at the gateway and at its token again.
    localGateway.invalidate()
    const gateway = await localGateway.check()
    if (!gateway.ok) return json(response, 401, { error: 'local_unavailable', reason: gateway.reason })
    session.expiresAt = Date.now() + SESSION_MAX_AGE * 1000
    persistSessions()
    return json(response, 200, { ok: true }, { 'Set-Cookie': sessionCookie(session) })
  }
  const saved = savedCredentials()
  if (!saved) return json(response, 404, { error: 'no_saved_credentials' })
  // hermesFetch stores the new Hermes cookies in this session.
  const upstream = await passwordLogin(request, saved)
  await upstream.body?.cancel().catch(() => {})
  if (upstream.status === 401) {
    credentialStore.clear() // password changed: do not keep hammering the gateway
    return json(response, 401, { error: 'saved_credentials_refused' })
  }
  if (!upstream.ok) return json(response, 502, { error: 'hermes_unavailable' })
  session.expiresAt = Date.now() + SESSION_MAX_AGE * 1000
  persistSessions()
  return json(response, 200, { ok: true }, { 'Set-Cookie': sessionCookie(session) })
}

async function handleLogout(request, response) {
  if (!LOCAL_ORIGINS.has(request.headers.origin)) return json(response, 403, { error: 'forbidden_origin' })
  await postVaultLogout(BROWSER_VAULT_ORIGIN, vaultToken()).catch(() => {})
  credentialStore?.clear()
  const session = browserSession(request)
  // A session without a password has nothing to close on the Hermes side.
  if (session?.kind !== 'local') {
    await hermesFetch(request, '/auth/logout', { method: 'POST' }).then((upstream) => upstream.body?.cancel()).catch(() => {})
  }
  if (session) {
    sessions.delete(session.id)
    persistSessions()
  }
  return json(response, 200, { ok: true }, { 'Set-Cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` })
}

function sameSecret(given, expected) {
  const a = Buffer.from(String(given))
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

// Started by hand, next to a gateway without a password: the way in is this link, for whoever reads this output.
let localLinkPrinted = APP_LOCAL_KEY
function printLocalLink() {
  if (localLinkPrinted) return
  localLinkPrinted = true
  console.log(`Hermes on this machine needs no password. Sign in with: http://${HOST}:${PORT}/?key=${LOCAL_KEY}`)
}

/** What the sign-in screen may know about the gateway: whether it can be opened without a password. */
async function localSignInState() {
  const gateway = await localGateway.check()
  if (gateway.ok) printLocalLink()
  return gateway.ok ? { available: true } : { available: false, reason: gateway.reason }
}

/** Sign-in without a password, to this user's own gateway. The key proves who asks: see LOCAL_KEY. */
async function handleLocalSignIn(request, response) {
  if (!LOCAL_ORIGINS.has(request.headers.origin)) return json(response, 403, { error: 'forbidden_origin' })
  if (!sameSecret(request.headers['x-hermesbot-local-key'] || '', LOCAL_KEY)) return json(response, 403, { error: 'local_key_required' })
  const gateway = await localGateway.check()
  if (!gateway.ok) return json(response, 409, { error: 'local_unavailable', reason: gateway.reason })
  const session = createSession([], 'local')
  return json(response, 200, { ok: true }, { 'Set-Cookie': sessionCookie(session) })
}

/** The shared settings file as the gateway holds it; `null` when it cannot be read (a write must then stop). */
async function readSharedFile(request) {
  const upstream = await hermesFetch(request, `/api/fs/read-text?${new URLSearchParams({ path: SHARED_SETTINGS_PATH })}`)
  try {
    if (upstream.status === 404) return {}
    if (!upstream.ok) return null
    const body = await upstream.json().catch(() => ({}))
    return parseSharedSettings(body.text)
  } finally {
    await upstream.body?.cancel?.().catch(() => {})
  }
}

async function writeSharedFile(request, settings) {
  const upstream = await hermesFetch(request, '/api/fs/write-text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: SHARED_SETTINGS_PATH, content: sharedSettingsText(settings) }),
  })
  await upstream.body?.cancel?.().catch(() => {})
  return upstream.ok
}

async function handleSharedSettings(request, response) {
  if (!browserSession(request) && !adoptableCookieHeader(request)) return json(response, 401, { error: 'unauthenticated' })
  if (request.method === 'GET') {
    const upstream = await hermesFetch(request, `/api/fs/read-text?${new URLSearchParams({ path: SHARED_SETTINGS_PATH })}`)
    const result = await relaySharedSettingsGet(upstream)
    return json(response, result.status, result.body)
  }
  if (!LOCAL_ORIGINS.has(request.headers.origin)) return json(response, 403, { error: 'forbidden_origin' })
  // The compaction setting and its snapshots are only ever written by /api/compaction: kept as the file has them.
  const existing = await readSharedFile(request)
  if (!existing) return json(response, 502, { error: 'shared_settings_unreadable' })
  const settings = withKeptCompaction(existing, sharedSettingsFrom(await bodyJson(request, SHARED_SETTINGS_MAX_BYTES)))
  const upstream = await hermesFetch(request, '/api/fs/write-text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: SHARED_SETTINGS_PATH, content: sharedSettingsText(settings) }),
  })
  const result = await relaySharedSettingsPut(upstream, settings)
  return json(response, result.status, result.body)
}

/** One profile's saved config, through Hermes's own REST route (raw: what the profile sets, no defaults). */
async function readProfileConfig(request, slug) {
  const upstream = await hermesFetch(request, `/api/config?${new URLSearchParams({ profile: slug, include_defaults: 'false' })}`)
  try {
    if (!upstream.ok) throw new Error(`config_${upstream.status}`)
    return await upstream.json()
  } finally {
    await upstream.body?.cancel?.().catch(() => {})
  }
}

async function writeProfileConfig(request, slug, body) {
  const upstream = await hermesFetch(request, `/api/config?${new URLSearchParams({ profile: slug })}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeout: 30_000,
  })
  await upstream.body?.cancel?.().catch(() => {})
  if (!upstream.ok) throw new Error(`config_${upstream.status}`)
}

/**
 * GET: the saved compaction values of the profiles named in `?profiles=a,b`, and the shared setting.
 * PUT {mode, gauge, profiles}: saves the setting and writes the two compression keys of each profile.
 */
async function handleCompaction(request, response, url) {
  // A real HermesBot session only: this route writes into the bots' profiles.
  if (!browserSession(request)) return json(response, 401, { error: 'unauthenticated' })
  if (request.method === 'GET') {
    const shared = await readSharedFile(request)
    if (!shared) return json(response, 502, { error: 'shared_settings_unreadable' })
    const values = {}
    for (const slug of profilesFrom((url.searchParams.get('profiles') || '').split(',')).slice(0, 20)) {
      try { values[slug] = compressionOfConfig(await readProfileConfig(request, slug)) } catch { /* that bot shows nothing */ }
    }
    const { mode, gauge } = shared.compaction ?? { mode: 'auto', gauge: 1 }
    return json(response, 200, { exists: Boolean(shared.compaction), settings: { mode, gauge }, profiles: values })
  }
  if (!LOCAL_ORIGINS.has(request.headers.origin)) return json(response, 403, { error: 'forbidden_origin' })
  const body = await bodyJson(request, COMPACTION_BODY_MAX_BYTES)
  const gauge = gaugeFrom(body.gauge)
  const profiles = profilesFrom(body.profiles)
  if ((body.mode !== 'auto' && body.mode !== 'manual') || gauge === null || !profiles.length) return json(response, 400, { error: 'invalid_compaction' })
  const existing = await readSharedFile(request)
  if (!existing) return json(response, 502, { error: 'shared_settings_unreadable' })
  const result = await applyCompaction({
    mode: body.mode,
    gauge,
    profiles,
    previous: existing.compaction ?? null,
    hermes: { read: (slug) => readProfileConfig(request, slug), write: (slug, payload) => writeProfileConfig(request, slug, payload) },
  })
  // Every profile failed: nothing changed, the setting is not saved either.
  if (!result.applied.length) return json(response, 502, { error: 'compaction_unwritable', failed: result.failed })
  const saved = await writeSharedFile(request, { ...existing, compaction: compactionFrom(result.settings) })
  return json(response, saved ? 200 : 502, { ok: saved, settings: { mode: result.settings.mode, gauge: result.settings.gauge }, applied: result.applied, failed: result.failed })
}

async function readMemoryFiles() {
  const files = {}
  for (const type of MEMORY_TYPES) {
    try { files[type] = await readFile(filePath(SHARED_MEMORY_DIR, type), 'utf8') } catch { files[type] = '' }
  }
  return files
}

async function handleSharedMemory(request, response, url) {
  if (!browserSession(request)) return json(response, 401, { error: 'unauthenticated' })
  const parts = url.pathname.slice('/api/shared-memory'.length).split('/').filter(Boolean)
  if (parts[0] === 'search' && request.method === 'GET') {
    const files = await readMemoryFiles()
    return json(response, 200, { query: url.searchParams.get('q') || '', hits: searchEntries(files, url.searchParams.get('q') || '') })
  }
  if (parts[0] === 'summary' && request.method === 'GET') {
    const files = await readMemoryFiles()
    return json(response, 200, {
      enabled: CONFIG.sharedMemory.injectContext,
      summary: summarizeForTurn(files, CONFIG.sharedMemory.injectMaxChars),
    })
  }
  const type = memoryType(parts[0] || url.searchParams.get('type') || '')
  if (!type) {
    if (request.method !== 'GET') return json(response, 405, { error: 'method_not_allowed' })
    const files = await readMemoryFiles()
    const types = Object.fromEntries(MEMORY_TYPES.map((key) => {
      const parsed = parseMemoryFile(files[key], key)
      return [key, { entries: parsed.entries.length, preview: parsed.entries[0]?.title || '' }]
    }))
    return json(response, 200, { dir: SHARED_MEMORY_DIR, types })
  }
  const file = filePath(SHARED_MEMORY_DIR, type)
  if (request.method === 'GET') {
    let text = ''
    try { text = await readFile(file, 'utf8') } catch { text = '' }
    return json(response, 200, parseMemoryFile(text, type))
  }
  if (!LOCAL_ORIGINS.has(request.headers.origin)) return json(response, 403, { error: 'forbidden_origin' })
  if (request.method === 'PUT' && parts.length === 1) {
    const body = await bodyJson(request, MEMORY_BODY_MAX_BYTES)
    const content = typeof body.text === 'string' ? body.text : ''
    await writeFile(file, content, 'utf8')
    return json(response, 200, parseMemoryFile(content, type))
  }
  if (parts[1] === 'entries' && request.method === 'POST') {
    const body = await bodyJson(request, MEMORY_ENTRY_MAX_BYTES)
    let text = ''
    try { text = await readFile(file, 'utf8') } catch { text = '' }
    const entry = {
      id: typeof body.id === 'string' ? body.id : undefined,
      type,
      title: String(body.title || '').trim().slice(0, 200),
      date: String(body.date || new Date().toISOString()).slice(0, 64),
      source: String(body.source || 'user').slice(0, 120),
      body: String(body.body || '').trim(),
    }
    if (!entry.title) return json(response, 400, { error: 'invalid_entry' })
    if (!entry.id) entry.id = entry.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 80)
    const next = upsertEntry(text, entry)
    await writeFile(file, next, 'utf8')
    return json(response, 200, parseMemoryFile(next, type))
  }
  if (parts[1] === 'entries' && parts[2] && request.method === 'DELETE') {
    let text = ''
    try { text = await readFile(file, 'utf8') } catch { text = '' }
    const next = removeEntry(text, parts[2])
    await writeFile(file, next, 'utf8')
    return json(response, 200, parseMemoryFile(next, type))
  }
  return json(response, 404, { error: 'not_found' })
}

async function readSoul(request, slug) {
  const upstream = await hermesFetch(request, `/api/fs/read-text?${new URLSearchParams({ path: soulPath(slug) })}`)
  try {
    if (upstream.status === 404) return ''
    if (!upstream.ok) throw new Error(`soul_${upstream.status}`)
    const body = await upstream.json().catch(() => ({}))
    return String(body.text || '')
  } finally {
    await upstream.body?.cancel?.().catch(() => {})
  }
}

async function writeSoul(request, slug, content) {
  const upstream = await hermesFetch(request, '/api/fs/write-text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: soulPath(slug), content }),
  })
  await upstream.body?.cancel?.().catch(() => {})
  if (!upstream.ok) throw new Error(`soul_${upstream.status}`)
}

async function readHermesText(request, filePath, profile = '') {
  const params = new URLSearchParams({ path: filePath })
  if (profile) params.set('profile', profile)
  const upstream = await hermesFetch(request, `/api/fs/read-text?${params}`)
  try {
    if (upstream.status === 404) return ''
    if (!upstream.ok) throw new Error(`read_${upstream.status}`)
    const body = await upstream.json().catch(() => ({}))
    return String(body.text || '')
  } finally {
    await upstream.body?.cancel?.().catch(() => {})
  }
}

async function writeHermesText(request, filePath, content, profile = '') {
  const upstream = await hermesFetch(request, '/api/fs/write-text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath, content, ...(profile ? { profile } : {}) }),
  })
  await upstream.body?.cancel?.().catch(() => {})
  if (!upstream.ok) throw new Error(`write_${upstream.status}`)
}

async function pushAccountForSession(request) {
  const upstream = await hermesFetch(request, '/api/auth/me')
  try {
    if (!upstream.ok) return ''
    const body = await upstream.json().catch(() => ({}))
    const user = typeof body?.username === 'string' ? body.username
      : typeof body?.user_id === 'string' ? body.user_id
      : typeof body?.display_name === 'string' ? body.display_name
      : ''
    return pushAccountId(CONFIG.browserOrigin || CONFIG.gatewayOrigin, user)
  } finally {
    await upstream.body?.cancel?.().catch(() => {})
  }
}

async function handleSkills(request, response, url) {
  if (!browserSession(request)) return json(response, 401, { error: 'unauthenticated' })
  const profile = String(url.searchParams.get('profile') || '').trim()
  if (request.method === 'GET') {
    const catalog = await listSkillsCatalog({ hermesHome: CONFIG.hermesHome, repoSkillsDir: REPO_SKILLS_DIR, profile: PROFILE_SLUG.test(profile) ? profile : '' })
    let disabled = []
    if (PROFILE_SLUG.test(profile)) {
      try {
        const config = await readProfileConfig(request, profile)
        disabled = Array.isArray(config?.skills?.disabled) ? config.skills.disabled.filter((item) => typeof item === 'string') : []
      } catch { /* no profile config */ }
    }
    return json(response, 200, { ...catalog, disabled, hubInstallCommand: 'hermes skills install <skill-id>', hubManage: CONFIG.skills?.hubManage !== false })
  }
  if (!LOCAL_ORIGINS.has(request.headers.origin)) return json(response, 403, { error: 'forbidden_origin' })
  if (request.method !== 'POST' || url.pathname !== '/api/skills/toggle') return json(response, 404, { error: 'not_found' })
  const body = await bodyJson(request, 16_384)
  const slug = String(body.profile || '').trim()
  if (!PROFILE_SLUG.test(slug)) return json(response, 400, { error: 'invalid_profile' })
  const config = await readProfileConfig(request, slug).catch(() => null)
  if (!config) return json(response, 502, { error: 'profile_unreadable' })
  const disabled = Array.isArray(config.skills?.disabled) ? config.skills.disabled : []
  const payload = skillToggleBody({ disabled, skillId: body.skillId, enabled: body.enabled === true })
  if (!payload) return json(response, 400, { error: 'invalid_skill' })
  await writeProfileConfig(request, slug, payload)
  return json(response, 200, { ok: true, disabled: payload.config.skills.disabled })
}

async function handleBotProfile(request, response, url) {
  if (!browserSession(request)) return json(response, 401, { error: 'unauthenticated' })
  const slug = String(url.searchParams.get('profile') || '').trim()
  if (!PROFILE_SLUG.test(slug)) return json(response, 400, { error: 'invalid_profile' })
  if (request.method === 'GET') {
    const [config, soul] = await Promise.all([
      readProfileConfig(request, slug).catch(() => ({})),
      readSoul(request, slug).catch(() => ''),
    ])
    return json(response, 200, {
      profile: slug,
      soul,
      model: modelFromConfig(config),
      toolsets: toolsetsFromConfig(config),
    })
  }
  if (!LOCAL_ORIGINS.has(request.headers.origin)) return json(response, 403, { error: 'forbidden_origin' })
  if (request.method !== 'PUT') return json(response, 405, { error: 'method_not_allowed' })
  const body = await bodyJson(request, SOUL_MAX_BYTES + 32_768)
  const previousSoul = typeof body.previousSoul === 'string' ? body.previousSoul : await readSoul(request, slug).catch(() => '')
  const nextSoul = typeof body.soul === 'string' ? body.soul.slice(0, SOUL_MAX_BYTES) : previousSoul
  const preview = { soul: diffLines(previousSoul, nextSoul) }
  if (body.confirm !== true) return json(response, 200, { preview, requiresConfirm: true })
  if (typeof body.soul === 'string') await writeSoul(request, slug, nextSoul)
  if (body.toolsets && typeof body.toolsets === 'object') {
    await writeProfileConfig(request, slug, toolsetsBody(body.toolsets))
  }
  return json(response, 200, { ok: true, preview })
}

async function handleBotTemplate(request, response, url) {
  if (!browserSession(request)) return json(response, 401, { error: 'unauthenticated' })
  const slug = String(url.searchParams.get('profile') || '').trim()
  if (request.method === 'GET' && PROFILE_SLUG.test(slug)) {
    const [config, soul] = await Promise.all([
      readProfileConfig(request, slug).catch(() => ({})),
      readSoul(request, slug).catch(() => ''),
    ])
    return json(response, 200, exportTemplate({ slug, soul, config, card: {} }))
  }
  if (!LOCAL_ORIGINS.has(request.headers.origin)) return json(response, 403, { error: 'forbidden_origin' })
  if (request.method === 'POST' && url.pathname === '/api/bot-template/import') {
    const body = await bodyJson(request, TEMPLATE_MAX_BYTES)
    const parsed = importTemplateBody(body.template)
    if (!parsed) return json(response, 400, { error: 'invalid_template' })
    const redacted = JSON.stringify(body.template)
    if (/(sk-[A-Za-z0-9]{16,})/.test(redacted)) return json(response, 400, { error: 'template_contains_secrets' })
    return json(response, 200, { ok: true, ready: true, soul: parsed.soul, configBody: parsed.configBody })
  }
  return json(response, 404, { error: 'not_found' })
}

const READ_ROUTES = new Set(['auth/me', 'cron/jobs', 'sessions', 'profiles', 'profiles/sessions', 'analytics/usage'])

async function handleReadProxy(request, response, url) {
  const route = url.pathname.slice('/api/hermes/'.length)
  const allowed = READ_ROUTES.has(route)
    || /^sessions\/[A-Za-z0-9_.:-]+\/messages$/.test(route)
    || /^cron\/jobs\/[A-Za-z0-9_-]+$/.test(route)
  if (!allowed) return json(response, 404, { error: 'not_found' })
  const upstreamPath = url.pathname.replace(/^\/api\/hermes\//, '/api/')
  const upstream = await hermesFetch(request, `${upstreamPath}${url.search}`)
  return proxyJson(response, upstream)
}

const CRON_WRITE = /^cron\/jobs(?:\/[A-Za-z0-9_-]+(?:\/(?:pause|resume|trigger))?)?$/

async function handleCronWrite(request, response, url) {
  if (!CONFIG.routines?.editable) return json(response, 403, { error: 'routines_readonly' })
  if (!browserSession(request)) return json(response, 401, { error: 'unauthenticated' })
  if (!LOCAL_ORIGINS.has(request.headers.origin)) return json(response, 403, { error: 'forbidden_origin' })
  const route = url.pathname.slice('/api/hermes/'.length)
  if (!CRON_WRITE.test(route)) return json(response, 404, { error: 'not_found' })
  const upstreamPath = url.pathname.replace(/^\/api\/hermes\//, '/api/')
  const init = { method: request.method, headers: { 'Content-Type': 'application/json' } }
  if (request.method === 'POST' || request.method === 'PUT') {
    const body = await bodyJson(request, 256_000)
    init.body = JSON.stringify(body)
  }
  const upstream = await hermesFetch(request, `${upstreamPath}${url.search}`, init)
  if (request.method === 'DELETE' && CONFIG.routines?.eventTriggers === true) {
    const match = route.match(/^cron\/jobs\/([A-Za-z0-9_-]+)$/)
    if (match) {
      const profile = url.searchParams.get('profile') || ''
      await routineEvents.removeJob(profile, match[1]).catch(() => {})
    }
  }
  return proxyJson(response, upstream)
}

const ROUTINE_HOOK = /^\/api\/routines\/hooks\/([A-Za-z0-9_-]+)$/

async function handleRoutineEventsList(request, response, url) {
  if (CONFIG.routines?.eventTriggers !== true) return json(response, 403, { error: 'event_triggers_disabled' })
  if (!browserSession(request)) return json(response, 401, { error: 'unauthenticated' })
  if (!LOCAL_ORIGINS.has(request.headers.origin)) return json(response, 403, { error: 'forbidden_origin' })
  const profile = url.searchParams.get('profile') || ''
  return json(response, 200, await routineEvents.listBindings(profile))
}

async function handleRoutineEventsBind(request, response) {
  if (CONFIG.routines?.eventTriggers !== true) return json(response, 403, { error: 'event_triggers_disabled' })
  if (!CONFIG.routines?.editable) return json(response, 403, { error: 'routines_readonly' })
  if (!browserSession(request)) return json(response, 401, { error: 'unauthenticated' })
  if (!LOCAL_ORIGINS.has(request.headers.origin)) return json(response, 403, { error: 'forbidden_origin' })
  const body = await bodyJson(request, 64_000)
  try {
    return json(response, 200, await routineEvents.bind(request, body))
  } catch {
    return json(response, 400, { error: 'invalid_binding' })
  }
}

async function handleRoutineEventsRegenerate(request, response) {
  if (CONFIG.routines?.eventTriggers !== true) return json(response, 403, { error: 'event_triggers_disabled' })
  if (!CONFIG.routines?.editable) return json(response, 403, { error: 'routines_readonly' })
  if (!browserSession(request)) return json(response, 401, { error: 'unauthenticated' })
  if (!LOCAL_ORIGINS.has(request.headers.origin)) return json(response, 403, { error: 'forbidden_origin' })
  const body = await bodyJson(request, 4096)
  const result = await routineEvents.regenerate(String(body.hookId || ''))
  if (result.error) return json(response, 404, result)
  return json(response, 200, result)
}

async function handleRoutineEventRuns(request, response, url) {
  if (CONFIG.routines?.eventTriggers !== true) return json(response, 403, { error: 'event_triggers_disabled' })
  if (!browserSession(request)) return json(response, 401, { error: 'unauthenticated' })
  if (!LOCAL_ORIGINS.has(request.headers.origin)) return json(response, 403, { error: 'forbidden_origin' })
  const profile = url.searchParams.get('profile') || ''
  const jobId = url.searchParams.get('jobId') || ''
  return json(response, 200, await routineEvents.runs(profile, jobId))
}

async function handleRoutineWebhook(request, response, hookId) {
  try {
    const result = await routineEvents.handleWebhook(request, hookId)
    return json(response, result.status, result.body)
  } catch (error) {
    if (error?.message === 'payload_too_large') return json(response, 413, { error: 'payload_too_large' })
    return json(response, 400, { error: 'bad_request' })
  }
}

async function handleRoutinesSchedule(request, response) {
  if (!browserSession(request)) return json(response, 401, { error: 'unauthenticated' })
  if (!LOCAL_ORIGINS.has(request.headers.origin)) return json(response, 403, { error: 'forbidden_origin' })
  const body = await bodyJson(request, 4096)
  const lang = body.lang === 'fr' ? 'fr' : 'en'
  const preview = previewSchedule(String(body.schedule || ''), lang)
  if (preview.error) return json(response, 400, { error: preview.error })
  return json(response, 200, preview)
}

async function handleRoutinesDryRun(request, response) {
  if (!browserSession(request)) return json(response, 401, { error: 'unauthenticated' })
  if (!LOCAL_ORIGINS.has(request.headers.origin)) return json(response, 403, { error: 'forbidden_origin' })
  const body = await bodyJson(request, 256_000)
  const lang = body.lang === 'fr' ? 'fr' : 'en'
  const name = String(body.name || '').trim()
  const prompt = String(body.prompt || '').trim()
  const schedule = previewSchedule(String(body.schedule || ''), lang)
  if (!name || !prompt) return json(response, 400, { error: 'missing_fields' })
  if (schedule.error) return json(response, 400, { error: schedule.error })
  return json(response, 200, {
    ok: true,
    dryRun: true,
    profile: String(body.profile || ''),
    job: { name, prompt, schedule: schedule.expr, scheduleDisplay: schedule.display, nextRuns: schedule.nextRuns },
  })
}

let catalogCache = null
let catalogCacheAt = 0

async function handleConnectorsCatalog(response) {
  if (!CONFIG.connectors?.enabled) return json(response, 403, { error: 'connectors_disabled' })
  const now = Date.now()
  if (!catalogCache || now - catalogCacheAt > 60_000) {
    catalogCache = await loadConnectorsCatalog(CONFIG.connectors.optionalMcpsDir)
    catalogCacheAt = now
  }
  return json(response, 200, { servers: catalogCache })
}

async function mintSocketTicket(request, profile) {
  let upstream = await hermesFetch(
    request,
    `/api/webapp/socket-ticket?socket=gateway&profile=${encodeURIComponent(profile)}`,
    { method: 'POST' },
  )
  // The second endpoint only knows cookie sessions: without a password it always refuses.
  if (upstream.status === 403 && browserSession(request)?.kind !== 'local') {
    console.warn('Hermes socket-ticket: HTTP 403, trying /api/auth/ws-ticket')
    upstream = await hermesFetch(request, '/api/auth/ws-ticket', { method: 'POST' })
  }
  if (!upstream.ok) {
    const body = await upstream.json().catch(() => ({}))
    const reason = String(body.reason || body.error || body.detail || '').replace(/[A-Za-z0-9_-]{32,}/g, '<redacted>').slice(0, 120)
    console.warn(`Hermes socket-ticket: HTTP ${upstream.status}${reason ? ` (${reason})` : ''}`)
    const error = new Error('socket_ticket_refused')
    error.status = upstream.status
    throw error
  }
  const result = await upstream.json()
  if (!result.ticket || typeof result.ticket !== 'string') throw new Error('socket_ticket_missing')
  return result.ticket
}

// Bot `MEDIA:/path` media. The files are on the gateway's machine: it reads them, with the
// Hermes session kept here. Must stay identical to PLAYABLE in src/lib/media.ts.
const MEDIA_TYPES = {
  png: ['image', 'image/png'], jpg: ['image', 'image/jpeg'], jpeg: ['image', 'image/jpeg'],
  gif: ['image', 'image/gif'], webp: ['image', 'image/webp'], bmp: ['image', 'image/bmp'],
  mp4: ['video', 'video/mp4'], mov: ['video', 'video/quicktime'], webm: ['video', 'video/webm'],
  mp3: ['audio', 'audio/mpeg'], m4a: ['audio', 'audio/mp4'], wav: ['audio', 'audio/wav'],
  ogg: ['audio', 'audio/ogg'], opus: ['audio', 'audio/ogg'], flac: ['audio', 'audio/flac'],
}
const MEDIA_PROFILE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const MEDIA_RELAYED_HEADERS = ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']
// Gateway status → status and code returned to the interface, with no path detail.
const MEDIA_ERRORS = {
  401: [401, 'unauthenticated'], 403: [403, 'media_forbidden'], 404: [404, 'media_not_found'],
  413: [415, 'unsupported_media'], 415: [415, 'unsupported_media'],
}

function fileRequest(url) {
  const profile = url.searchParams.get('profile') || ''
  const file = url.searchParams.get('path') || ''
  if (!MEDIA_PROFILE.test(profile)) return { status: 400, error: 'invalid_profile' }
  if (!file || file.length > 4096 || /[\u0000-\u001f\u007f]/.test(file)) return { status: 400, error: 'invalid_path' }
  // Absolute file path: no folder (`x.png/`), no host (`//host/x.png`), no `.` or `..`.
  if (!(file.startsWith('/') || file.startsWith('~/')) || file.startsWith('//') || file.endsWith('/')) return { status: 400, error: 'invalid_path' }
  if (file.split('/').some((part) => part === '.' || part === '..')) return { status: 400, error: 'invalid_path' }
  return { profile, file, extension: path.extname(file).slice(1).toLowerCase() }
}

function mediaRequest(url) {
  const target = fileRequest(url)
  if (target.error) return target
  const type = MEDIA_TYPES[target.extension]
  if (!type) return { status: 415, error: 'unsupported_media' }
  return { profile: target.profile, file: target.file, kind: type[0], contentType: type[1] }
}

// Documents opened in a tab next to the chat. Must stay identical to the formats in `src/lib/media.ts`.
// Plain text (`txt`, `log`): a coding agent's prompt or log, opened from the Subagents panel, shown as text.
const DOCUMENT_TYPES = {
  pdf: 'application/pdf',
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  md: 'text/markdown; charset=utf-8', markdown: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8', log: 'text/plain; charset=utf-8',
}
// A page written by a bot may come from hostile content: opaque origin, local scripts only,
// and no network access. Remote images, fonts and scripts do not load.
const DOCUMENT_POLICIES = {
  pdf: "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; frame-ancestors 'self'",
  html: "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'",
  markdown: "default-src 'none'; sandbox; frame-ancestors 'none'",
  text: "default-src 'none'; sandbox; frame-ancestors 'none'",
}

function documentRequest(url) {
  const target = fileRequest(url)
  if (target.error) return target
  const contentType = DOCUMENT_TYPES[target.extension]
  if (!contentType) return { status: 415, error: 'unsupported_media' }
  const format = target.extension === 'pdf' ? 'pdf' : contentType.startsWith('text/html') ? 'html' : contentType.startsWith('text/plain') ? 'text' : 'markdown'
  return { profile: target.profile, file: target.file, format, contentType }
}

async function handleMedia(request, response, url) {
  const target = mediaRequest(url)
  if (target.error) return json(response, target.status, { error: target.error })
  if (!browserSession(request) && !adoptableCookieHeader(request)) return json(response, 401, { error: 'unauthenticated' })
  // Images: the gateway's download route, capped. Audio and video: its streaming route, with Range, uncapped.
  const ranged = target.kind === 'audio' || target.kind === 'video'
  return relayFile(request, response, target, target.kind === 'image' ? '/api/fs/download' : '/api/files/stream', {
    // The URL carries the message id (`v`): a file rewritten under the same name comes back with a fresh URL.
    'Cache-Control': 'private, max-age=600',
    'Content-Security-Policy': "default-src 'none'; sandbox; frame-ancestors 'none'",
  }, ranged ? Infinity : IMAGE_MAX_BYTES, ranged)
}

async function handleDocument(request, response, url) {
  const target = documentRequest(url)
  if (target.error) return json(response, target.status, { error: target.error })
  if (!browserSession(request) && !adoptableCookieHeader(request)) return json(response, 401, { error: 'unauthenticated' })
  const ranged = target.format === 'pdf'
  return relayFile(request, response, target, '/api/fs/download', {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': DOCUMENT_POLICIES[target.format],
  }, ranged ? Infinity : DOCUMENT_TEXT_MAX_BYTES, ranged)
}

/** Relays a gateway file. The type and the policy come from here, never from the gateway. */
async function relayFile(request, response, target, route, policyHeaders, maxBytes = Infinity, forwardRange = false) {
  const headers = forwardRequestHeaders(request.headers, { forwardRange })
  const controller = new AbortController()
  response.on('close', () => { if (!response.writableFinished) controller.abort() })
  const headersTimer = setTimeout(() => controller.abort(), 20_000)
  let upstream
  try {
    upstream = await hermesFetch(request, `${route}?${new URLSearchParams({ path: target.file, profile: target.profile })}`, {
      method: request.method === 'HEAD' ? 'HEAD' : 'GET',
      headers,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(headersTimer)
  }
  const status = upstream.status
  if (![200, 206, 304, 416].includes(status)) {
    upstream.body?.cancel().catch(() => {})
    const [errorStatus, error] = MEDIA_ERRORS[status] || [502, 'media_unavailable']
    return json(response, errorStatus, { error })
  }
  if (relayLimitStatus(status, upstream.headers, maxBytes)) {
    upstream.body?.cancel().catch(() => {})
    return json(response, 413, { error: 'document_too_large' })
  }
  const outgoing = {
    // The type comes from the validated extension, never from the gateway: an image/svg+xml does not pass as a .png.
    'Content-Type': target.contentType,
    'Content-Disposition': 'inline',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    ...policyHeaders,
  }
  for (const name of MEDIA_RELAYED_HEADERS) {
    const value = upstream.headers.get(name)
    if (value) outgoing[name] = value
  }
  // fetch decompresses: a compressed length would no longer match the relayed body.
  if (upstream.headers.get('content-encoding')) delete outgoing['content-length']
  response.writeHead(status, outgoing)
  if (!upstream.body || request.method === 'HEAD' || status === 304) {
    upstream.body?.cancel().catch(() => {})
    return response.end()
  }
  pipeline(Readable.fromWeb(upstream.body), createByteCap(maxBytes), response, (error) => {
    if (error?.code === 'ERR_DOCUMENT_TOO_LARGE') {
      controller.abort()
      if (!response.writableEnded) response.destroy()
    }
    // A video player often abandons its Range requests: that is not an error.
    if (error && error.code !== 'ERR_DOCUMENT_TOO_LARGE' && !['ERR_STREAM_PREMATURE_CLOSE', 'ABORT_ERR'].includes(error.code) && error.name !== 'AbortError') {
      console.warn(`Hermes media: ${error.code || error.name || 'stream_error'}`)
    }
  })
}

// Isolated local chat, with an Ollama model installed on the machine. Only messages are sent, never a tool:
// the model cannot execute anything. From another Mac, 127.0.0.1:11434 may be a tunnel to the Ollama machine.
const OLLAMA_ORIGIN = CONFIG.ollamaOrigin
const modelProbe = createModelProbe({ probes: CONFIG.modelProbes })
// LLM Stats scores: trusted private key command, then environment or macOS Keychain.
// Tests only (never in production): a local stand-in for the API.
const testScoresOrigin = DEVELOPMENT && /^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.HERMESBOT_TEST_SCORES_ORIGIN || '') ? process.env.HERMESBOT_TEST_SCORES_ORIGIN : undefined
const modelScores = createModelScores({
  apiOrigin: testScoresOrigin,
  cacheFile: path.join(CONFIG.dataDir, 'llm-stats-scores-cache.json'),
  snapshotFile: CONFIG.llmStats.snapshotPath,
  keyCommand: CONFIG.llmStats.keyCommand,
  env: process.env,
})

async function handleModelScores(request, response, url) {
  // A real HermesBot session only: the list is the user's own data.
  if (!browserSession(request)) return json(response, 401, { error: 'unauthenticated' })
  if (url.pathname === '/api/model-scores/key') return json(response, 410, { error: 'key_management_removed' })
  if (request.method !== 'GET') return json(response, 405, { error: 'method_not_allowed' })
  return json(response, 200, await modelScores.get())
}
const LOCAL_CHAT_MAX_BYTES = 4 * 1024 * 1024
const OLLAMA_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/
let ollamaModelsCache = { at: 0, entries: null }
const localMemory = createLocalMemory()

const byteCount = (value) => (Number.isFinite(value) && value > 0 ? Math.round(value) : 0)
const shortText = (value) => (typeof value === 'string' ? value.slice(0, 64) : '')

/** Models installed in Ollama (`/api/tags`) with their details, cached for 30 s. `null`: Ollama does not answer. */
async function ollamaModelEntries() {
  if (ollamaModelsCache.entries && Date.now() - ollamaModelsCache.at < 30_000) return ollamaModelsCache.entries
  try {
    const upstream = await fetch(`${OLLAMA_ORIGIN}/api/tags`, { signal: AbortSignal.timeout(3000) })
    if (!upstream.ok) return null
    const body = await upstream.json()
    const entries = (Array.isArray(body?.models) ? body.models : [])
      .filter((model) => typeof model?.name === 'string' && OLLAMA_MODEL.test(model.name))
      .map((model) => ({
        name: model.name,
        size: byteCount(model.size),
        parameters: shortText(model.details?.parameter_size),
        quantization: shortText(model.details?.quantization_level),
        family: shortText(model.details?.family),
      }))
    ollamaModelsCache = { at: Date.now(), entries }
    return entries
  } catch {
    return null
  }
}

async function ollamaModels() {
  const entries = await ollamaModelEntries()
  return entries && entries.map((entry) => entry.name)
}

async function handleLocalModels(request, response) {
  if (!browserSession(request)) return json(response, 401, { error: 'unauthenticated' })
  const entries = await ollamaModelEntries()
  const details = Object.fromEntries((entries || []).map(({ name, ...detail }) => [name, detail]))
  return json(response, 200, { available: entries !== null, models: (entries || []).map((entry) => entry.name), details, defaultModel: CONFIG.localChat.model })
}

/** Models in memory now (`/api/ps`), never cached: the Load and Unload buttons follow it. */
async function handleLocalStatus(request, response) {
  if (!browserSession(request)) return json(response, 401, { error: 'unauthenticated' })
  try {
    const upstream = await fetch(`${OLLAMA_ORIGIN}/api/ps`, { signal: AbortSignal.timeout(3000) })
    if (!upstream.ok) return json(response, 200, { available: false, loaded: [] })
    const body = await upstream.json()
    const loaded = (Array.isArray(body?.models) ? body.models : [])
      .filter((model) => typeof model?.name === 'string' && OLLAMA_MODEL.test(model.name))
      .map((model) => ({
        model: model.name,
        size: byteCount(model.size),
        vram: byteCount(model.size_vram),
        expiresAt: typeof model.expires_at === 'string' && !Number.isNaN(Date.parse(model.expires_at)) ? new Date(model.expires_at).toISOString() : '',
        context: Number.isInteger(model.context_length) && model.context_length > 0 ? model.context_length : 0,
        kept: localMemory.keptModel(model.name),
      }))
    return json(response, 200, { available: true, loaded })
  } catch {
    return json(response, 200, { available: false, loaded: [] })
  }
}

/**
 * Load (`keep_alive` 30 min) or unload (`keep_alive` 0) an installed model, without a prompt: Ollama only moves
 * the weights. An unload waits for a reply in progress, even another program’s, before freeing the memory.
 */
/** Before a switch: does this model answer now? Only for the prefixes of `modelProbes`. */
async function handleModelProbe(request, response) {
  if (!LOCAL_ORIGINS.has(request.headers.origin)) return json(response, 403, { error: 'forbidden_origin' })
  if (!browserSession(request)) return json(response, 401, { error: 'unauthenticated' })
  let body
  try { body = await bodyJson(request, 4_096) } catch { return json(response, 400, { error: 'invalid_body' }) }
  const result = await modelProbe.check(body?.model)
  if (result.invalid) return json(response, 400, { error: 'invalid_model' })
  return json(response, 200, result)
}

async function handleLocalMemory(request, response, action) {
  if (!LOCAL_ORIGINS.has(request.headers.origin)) return json(response, 403, { error: 'forbidden_origin' })
  if (!browserSession(request)) return json(response, 401, { error: 'unauthenticated' })
  const body = await bodyJson(request)
  const model = typeof body?.model === 'string' ? body.model : ''
  const installed = await ollamaModels()
  if (installed === null) return json(response, 503, { error: 'local_model_unreachable' })
  if (!model || !installed.includes(model)) return json(response, 404, { error: 'local_model_missing' })
  const controller = new AbortController()
  const stop = () => { if (!response.writableFinished) controller.abort() }
  response.on('close', stop)
  try {
    await localMemory.run({ action, model, origin: OLLAMA_ORIGIN, signal: controller.signal })
  } catch (error) {
    if (response.destroyed || response.writableEnded) return
    const status = Number.isInteger(error?.status) ? error.status : 503
    const code = ['local_model_busy', 'local_model_missing', 'local_model_failed'].includes(error?.message)
      ? error.message
      : 'local_model_unreachable'
    return json(response, status, { error: code })
  } finally {
    response.removeListener('close', stop)
  }
  if (response.destroyed || response.writableEnded) return
  return json(response, 200, { ok: true })
}

function localChatMessages(body) {
  if (!Array.isArray(body?.messages) || body.messages.length === 0 || body.messages.length > 400) return null
  const messages = body.messages.map((message) => ({ role: message?.role, content: message?.content }))
  return messages.every(({ role, content }) => (role === 'user' || role === 'assistant') && typeof content === 'string' && content) ? messages : null
}

async function handleLocalChat(request, response) {
  if (!LOCAL_ORIGINS.has(request.headers.origin)) return json(response, 403, { error: 'forbidden_origin' })
  if (!browserSession(request)) return json(response, 401, { error: 'unauthenticated' })
  const body = await bodyJson(request, LOCAL_CHAT_MAX_BYTES)
  const messages = localChatMessages(body)
  if (!messages) return json(response, 400, { error: 'invalid_messages' })
  // The requested model must be installed: the window can target nothing but a local model.
  const requested = typeof body.model === 'string' && body.model ? body.model : CONFIG.localChat.model
  const installed = await ollamaModels()
  if (installed === null) return json(response, 503, { error: 'local_model_unreachable' })
  if (!requested || !installed.includes(requested)) return json(response, 404, { error: 'local_model_missing' })
  // A model loaded with the button stays 30 minutes after this message.
  const kept = localMemory.keptModel(requested)
  if (kept) localMemory.touch(requested)
  const controller = new AbortController()
  response.on('close', () => { if (!response.writableFinished) controller.abort() })
  let upstream
  try {
    upstream = await fetch(`${OLLAMA_ORIGIN}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: requested, messages, stream: true, keep_alive: kept ? LOCAL_CHAT_KEEP : LOCAL_CHAT_IDLE, options: LOCAL_CHAT_OPTIONS }),
      signal: controller.signal,
    })
  } catch {
    return json(response, 503, { error: 'local_model_unreachable' })
  }
  if (!upstream.ok || !upstream.body) {
    upstream.body?.cancel().catch(() => {})
    return json(response, upstream.status === 404 ? 404 : 502, { error: upstream.status === 404 ? 'local_model_missing' : 'local_model_failed' })
  }
  response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  pipeline(Readable.fromWeb(upstream.body), response, (error) => {
    if (error && !['ERR_STREAM_PREMATURE_CLOSE', 'ABORT_ERR'].includes(error.code) && error.name !== 'AbortError') console.warn(`Chat local: ${error.code || error.name || 'stream_error'}`)
  })
}

// Saved conversations of the local chat: encrypted on this Mac by the app, never sent anywhere else.
const localChatHistory = createLocalChatHistory(globalThis.__hermesBotLocalChatStore || null)
const LOCAL_HISTORY_PATH = /^\/api\/local-chat\/history\/([A-Za-z0-9_-]{8,64})$/
const HISTORY_ERRORS = {
  invalid_conversation: 400, invalid_messages: 400, conversation_too_large: 413, history_full: 507,
  history_unreadable: 503, history_unwritable: 503,
}

async function handleLocalHistory(request, response, url) {
  // A real HermesBot session only: a Hermes cookie is checked by the gateway on proxied routes, never here, and
  // any local process could send one to read the decrypted conversations.
  if (!browserSession(request)) return json(response, 401, { error: 'unauthenticated' })
  if (url.pathname === '/api/local-chat/history') {
    if (request.method !== 'GET') return json(response, 405, { error: 'method_not_allowed' })
    return json(response, 200, { persistent: localChatHistory.persistent, ...localChatHistory.list() })
  }
  const id = LOCAL_HISTORY_PATH.exec(url.pathname)?.[1]
  if (!id) return json(response, 404, { error: 'not_found' })
  if (request.method === 'GET') {
    const conversation = localChatHistory.get(id)
    return conversation ? json(response, 200, conversation) : json(response, 404, { error: 'conversation_missing' })
  }
  if (!LOCAL_ORIGINS.has(request.headers.origin)) return json(response, 403, { error: 'forbidden_origin' })
  let error
  if (request.method === 'PUT') error = localChatHistory.save(id, await bodyJson(request, LOCAL_HISTORY_LIMITS.conversationBytes + 65_536))
  else if (request.method === 'DELETE') error = localChatHistory.remove(id)
  else return json(response, 405, { error: 'method_not_allowed' })
  return error ? json(response, HISTORY_ERRORS[error] || 400, { error }) : json(response, 200, { ok: true })
}

/** Call to the vault admin API. Service absent: 503 `vault_service_unavailable`. */
async function vaultAdmin(pathname, body, hermesCookie = '') {
  const method = body === undefined ? 'GET' : 'POST'
  try {
    const response = await fetch(`${BROWSER_VAULT_ORIGIN}${pathname}`, {
      method,
      headers: vaultRequestHeaders(method, vaultToken(), hermesCookie),
      body: body === undefined ? undefined : JSON.stringify(body),
      // A code request waits for the CDP injection: up to one minute.
      signal: AbortSignal.timeout(65_000),
    })
    const result = await response.json().catch(() => ({}))
    return { status: response.status, body: result && typeof result === 'object' ? result : {} }
  } catch {
    return { status: 503, body: { error: 'vault_service_unavailable' } }
  }
}

// A single read of the pending requests for all open windows, every 1.5 s.
const vaultListeners = new Set()
let vaultSnapshot = '[]'
// Accounts a bot created without a card (the user's setting): the app tells the user, without blocking.
let vaultNotices = '[]'
let vaultPoll = null
async function pollVaultRequests() {
  const { status, body } = await vaultAdmin('/admin/v1/requests')
  // A failed or malformed poll keeps the cards on screen. The bot is still waiting on the vault.
  const next = reduceVaultPoll({ requests: vaultSnapshot, notices: vaultNotices }, status, body)
  if (next.requests !== vaultSnapshot) {
    vaultSnapshot = next.requests
    vaultListeners.forEach((listener) => listener('requests', next.requests))
  }
  if (next.notices !== vaultNotices) {
    vaultNotices = next.notices
    vaultListeners.forEach((listener) => listener('notices', next.notices))
  }
}

function handleBrowserVaultEvents(request, response) {
  if (!browserSession(request)) return json(response, 401, { error: 'unauthenticated' })
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  // Requests as plain messages, as before; notices as a named event, ignored by older windows.
  const listener = (kind, snapshot) => response.write(kind === 'notices' ? `event: notices\ndata: ${snapshot}\n\n` : `data: ${snapshot}\n\n`)
  vaultListeners.add(listener)
  listener('requests', vaultSnapshot)
  listener('notices', vaultNotices)
  if (!vaultPoll) {
    vaultPoll = setInterval(() => { pollVaultRequests().catch(() => undefined) }, 1500)
    vaultPoll.unref()
    pollVaultRequests().catch(() => undefined)
  }
  const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 20_000)
  heartbeat.unref()
  response.on('close', () => {
    clearInterval(heartbeat)
    vaultListeners.delete(listener)
    if (!vaultListeners.size && vaultPoll) { clearInterval(vaultPoll); vaultPoll = null }
  })
}

/** App window to the vault: session and local origin required, as for Hermes. */
async function handleAutoRouterDecide(request, response) {
  if (!autoRouter) return json(response, 404, { error: 'not_found' })
  if (!browserSession(request)) return json(response, 401, { error: 'unauthenticated' })
  if (!LOCAL_ORIGINS.has(request.headers.origin)) return json(response, 403, { error: 'forbidden_origin' })
  const body = await bodyJson(request, 256_000)
  const analyticsProfiles = Array.isArray(body.analyticsProfiles)
    ? body.analyticsProfiles.filter((item) => typeof item === 'string').slice(0, 64)
    : []
  const quotas = await quotasForAutoRouter(request, analyticsProfiles.length ? analyticsProfiles : [body.bot].filter(Boolean))
  autoRouterQuotaCache = { at: Date.now(), quotas }
  const decision = await autoRouter.decide({ ...body, quotas: quotas.map((row) => ({ id: row.id, usedPercent: row.usedPercent, modelPrefixes: row.modelPrefixes })) })
  return json(response, decision.ok === false ? 400 : 200, decision)
}

async function handleAutoRouterLogWrite(request, response) {
  if (!autoRouter) return json(response, 404, { error: 'not_found' })
  if (!browserSession(request)) return json(response, 401, { error: 'unauthenticated' })
  if (!LOCAL_ORIGINS.has(request.headers.origin)) return json(response, 403, { error: 'forbidden_origin' })
  const body = await bodyJson(request, 16_384)
  const entry = sanitizeLogEntry(body)
  if (!entry.bot || !entry.chosen) return json(response, 400, { error: 'invalid_entry' })
  if (entry.costUsd === null) {
    const table = await loadAutoRouterTable()
    entry.costUsd = estimateTokenCost(table, entry.chosen, entry.tokensIn ?? 0, entry.tokensOut ?? 0)
  }
  await appendRoutingLog(autoRouter.logDir, entry)
  return json(response, 200, { ok: true })
}

async function handleAutoRouterLogRead(request, response, url) {
  if (!autoRouter) return json(response, 404, { error: 'not_found' })
  if (!browserSession(request)) return json(response, 401, { error: 'unauthenticated' })
  const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days')) || 7))
  const entries = await readRoutingLog(autoRouter.logDir, days)
  return json(response, 200, { entries, summary: summarizeRoutingLog(entries) })
}

async function handleUsageGlobal(request, response, url) {
  if (!CONFIG.features.usageGlobal) return json(response, 404, { error: 'not_found' })
  if (!browserSession(request)) return json(response, 401, { error: 'unauthenticated' })
  const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days')) || 30))
  const profiles = profilesFromQuery(url.searchParams.get('profiles'))
  if (!profiles.length) return json(response, 400, { error: 'invalid_profiles' })
  const results = await Promise.all(profiles.map(async (profile) => {
    try {
      const upstream = await hermesFetch(request, `/api/analytics/usage?${new URLSearchParams({ profile, days: String(days) })}`)
      if (!upstream.ok) return { profile, error: upstream.status }
      const body = await upstream.json()
      return { profile, body }
    } catch {
      return { profile, error: 'unavailable' }
    }
  }))
  const summary = aggregateAnalytics(results, days)
  const quotas = estimateQuotas(summary, CONFIG.usageQuotas)
  return json(response, 200, { summary, quotas })
}

async function handlePagesLibrary(request, response, url) {
  if (!CONFIG.features.pagesLibrary) return json(response, 404, { error: 'not_found' })
  if (!browserSession(request)) return json(response, 401, { error: 'unauthenticated' })
  if (request.method === 'GET') {
    const profile = url.searchParams.get('profile') || ''
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(profile)) return json(response, 400, { error: 'invalid_profile' })
    const query = url.searchParams.get('q') || ''
    const archived = url.searchParams.get('archived') === '1'
    try {
      return json(response, 200, { items: await pagesLibrary.list(profile, { query, archived }) })
    } catch {
      return json(response, 400, { error: 'invalid_profile' })
    }
  }
  if (!LOCAL_ORIGINS.has(request.headers.origin)) return json(response, 403, { error: 'forbidden_origin' })
  const body = await bodyJson(request, 16_384)
  const profile = typeof body.profile === 'string' ? body.profile : ''
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(profile)) return json(response, 400, { error: 'invalid_profile' })
  try {
    if (body.action === 'touch') {
      const id = await pagesLibrary.touch({ profile, filePath: body.path, title: body.title, name: body.name })
      return json(response, 200, { id })
    }
    if (body.action === 'rename') {
      await pagesLibrary.rename(profile, body.id, body.title)
      return json(response, 200, { ok: true })
    }
    if (body.action === 'archive') {
      await pagesLibrary.archive(profile, body.id)
      return json(response, 200, { ok: true })
    }
    return json(response, 400, { error: 'invalid_action' })
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    const status = message === 'not_found' ? 404 : 400
    return json(response, status, { error: message || 'pages_library_failed' })
  }
}

async function handleBrowserVaultAdmin(request, response, pathname) {
  if (request.method === 'POST' && !LOCAL_ORIGINS.has(request.headers.origin)) return json(response, 403, { error: 'forbidden_origin' })
  const session = browserSession(request)
  if (!session) return json(response, 401, { error: 'unauthenticated' })
  const body = request.method === 'POST' ? await bodyJson(request) : undefined
  // The Hermes cookie is a write credential. GETs and the poll do not send it.
  const result = await vaultAdmin(pathname, body, request.method === 'POST' ? (session.cookieHeader || '') : '')
  if (pathname.startsWith('/admin/v1/requests/')) pollVaultRequests().catch(() => undefined)
  return json(response, result.status, result.body)
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
}

// Bot answers may come from hostile content: nothing may load from or call the outside.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  `connect-src 'self' ws://${HOST}:${PORT} ws://localhost:${PORT}`,
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ')

// Optional bot animations: `<slug>-working.webp` and `<slug>-done.webp` in the `animationsDir` folder.
const ANIMATION_FILE = /^\/animations\/([A-Za-z0-9][A-Za-z0-9_.-]{0,63})-(working|done)\.webp$/

async function animatedBots() {
  try {
    const names = new Set(await readdir(CONFIG.animationsDir))
    return [...names]
      .map((name) => /^([A-Za-z0-9][A-Za-z0-9_.-]{0,63})-working\.webp$/.exec(name)?.[1])
      .filter((slug) => slug && names.has(`${slug}-done.webp`))
      .sort()
  } catch {
    return []
  }
}

async function serveAnimation(response, slug, phase) {
  const file = path.join(CONFIG.animationsDir, `${slug}-${phase}.webp`)
  try {
    const data = await readFile(file)
    response.writeHead(200, {
      'Content-Type': 'image/webp',
      'Content-Length': data.length,
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
    })
    return response.end(data)
  } catch {
    return json(response, 404, { error: 'not_found' })
  }
}

/** Interface settings for this installation. Nothing secret: preferences and the list of animated bots. */
async function handleAppConfig(response) {
  return json(response, 200, {
    channels: CONFIG.channels,
    ui: CONFIG.ui,
    animatedBots: await animatedBots(),
    localChat: { name: CONFIG.localChat.name },
    routines: { editable: CONFIG.routines?.editable !== false, eventTriggers: CONFIG.routines?.eventTriggers === true },
    connectors: { enabled: CONFIG.connectors?.enabled !== false },
    sharedMemory: {
      injectContext: CONFIG.sharedMemory.injectContext,
      types: MEMORY_TYPES,
    },
    computerPanel: { enabled: CONFIG.computerPanel.enabled },
    features: CONFIG.features,
    usageQuotas: CONFIG.usageQuotas,
    autoRouter: {
      enabled: CONFIG.autoRouter?.enabled === true,
      tableConfigured: Boolean(CONFIG.autoRouter?.tablePath || autoRouterPaths.tablePath),
      tablePath: autoRouterTablePath,
    },
  })
}

function computerPanelSlug(url) {
  const slug = url.searchParams.get('bot') || ''
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(slug) ? slug : ''
}

function handleComputerPanelError(response, error) {
  if (error instanceof ComputerPanelError) return json(response, error.status, { error: error.code })
  return json(response, 502, { error: 'computer_panel_unavailable' })
}

async function handleComputerPanelStatus(request, response, url) {
  if (!browserSession(request)) return json(response, 401, { error: 'unauthenticated' })
  if (!computerPanel.enabled) return json(response, 404, { error: 'not_found' })
  const slug = computerPanelSlug(url)
  if (!slug) return json(response, 400, { error: 'invalid_request' })
  try {
    return json(response, 200, await computerPanel.statusForBot(slug))
  } catch (error) {
    return handleComputerPanelError(response, error)
  }
}

async function handleComputerPanelStream(request, response, url) {
  if (!browserSession(request)) return json(response, 401, { error: 'unauthenticated' })
  if (!computerPanel.enabled) return json(response, 404, { error: 'not_found' })
  const slug = computerPanelSlug(url)
  if (!slug) return json(response, 400, { error: 'invalid_request' })
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  let detach = () => {}
  try {
    ({ detach } = await computerPanel.attachStream(slug, response))
  } catch (error) {
    return handleComputerPanelError(response, error)
  }
  const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 20_000)
  heartbeat.unref()
  response.on('close', () => {
    clearInterval(heartbeat)
    detach()
  })
}

async function handleComputerPanelTakeover(request, response) {
  if (!browserSession(request)) return json(response, 401, { error: 'unauthenticated' })
  if (!computerPanel.enabled) return json(response, 404, { error: 'not_found' })
  if (request.method === 'POST' && !LOCAL_ORIGINS.has(request.headers.origin)) return json(response, 403, { error: 'forbidden_origin' })
  let body
  try { body = await bodyJson(request) } catch { return json(response, 400, { error: 'invalid_request' }) }
  const slug = computerPanelSlug(new URL(`http://local/?bot=${body.bot || ''}`))
  if (!slug || typeof body.active !== 'boolean') return json(response, 400, { error: 'invalid_request' })
  try {
    return json(response, 200, { bot: slug, ...(await computerPanel.setTakeover(slug, body.active)) })
  } catch (error) {
    return handleComputerPanelError(response, error)
  }
}

async function handleComputerPanelInput(request, response) {
  if (!browserSession(request)) return json(response, 401, { error: 'unauthenticated' })
  if (!computerPanel.enabled) return json(response, 404, { error: 'not_found' })
  if (!LOCAL_ORIGINS.has(request.headers.origin)) return json(response, 403, { error: 'forbidden_origin' })
  let body
  try { body = await bodyJson(request, 4096) } catch { return json(response, 400, { error: 'invalid_request' }) }
  const slug = computerPanelSlug(new URL(`http://local/?bot=${body.bot || ''}`))
  if (!slug || typeof body.kind !== 'string') return json(response, 400, { error: 'invalid_request' })
  try {
    return json(response, 200, await computerPanel.forwardInput(slug, body))
  } catch (error) {
    return handleComputerPanelError(response, error)
  }
}

async function handleComputerPanelControl(request, response, url) {
  if (!browserSession(request)) return json(response, 401, { error: 'unauthenticated' })
  if (!computerPanel.enabled) return json(response, 404, { error: 'not_found' })
  const slug = computerPanelSlug(url)
  if (!slug) return json(response, 400, { error: 'invalid_request' })
  return json(response, 200, { bot: slug, ...computerPanel.controlFlag(slug) })
}

async function handleChannelStatus(request, response, url) {
  if (request.method !== 'GET' || !browserSession(request)) return json(response, 401, { error: 'unauthenticated' })
  const profile = url.searchParams.get('profile') || ''
  if (!PROFILE_SLUG.test(profile)) return json(response, 400, { error: 'invalid_profile' })
  try {
    const envPath = profileEnvPath(CONFIG.hermesHome, profile)
    const upstream = await hermesFetch(request, `/api/fs/read-text?${new URLSearchParams({ path: envPath, profile })}`)
    const text = upstream.ok ? await upstream.text() : ''
    await upstream.body?.cancel?.().catch(() => {})
    const keys = [...envKeysPresent(text)]
    const { platforms, snippet } = channelStatusFromKeys(keys)
    return json(response, 200, { profile, platforms, snippet })
  } catch {
    return json(response, 502, { error: 'channels_unavailable' })
  }
}

async function handleChannelApply(request, response) {
  if (!browserSession(request)) return json(response, 401, { error: 'unauthenticated' })
  if (!LOCAL_ORIGINS.has(request.headers.origin)) return json(response, 403, { error: 'forbidden_origin' })
  if (!CONFIG.channels.wizardWrites) return json(response, 403, { error: 'channels_read_only' })
  const body = await bodyJson(request, 4096)
  const parsed = validateChannelRequest(body)
  if (!parsed) return json(response, 400, { error: 'invalid_channels_apply' })
  const patch = configPatchFor(parsed.platform)
  if (!patch) return json(response, 400, { error: 'invalid_platform' })
  try {
    const configPath = profileConfigPath(CONFIG.hermesHome, parsed.profile)
    const existing = await readProfileConfig(request, parsed.profile).catch(() => null)
    if (existing) {
      const backup = backupPath(configPath)
      await writeHermesText(request, backup, JSON.stringify(existing, null, 2) + '\n', parsed.profile)
    }
    await writeProfileConfig(request, parsed.profile, { config: patch })
    return json(response, 200, { ok: true })
  } catch {
    return json(response, 502, { error: 'channels_apply_failed' })
  }
}

async function handleChannelEnv(request, response) {
  if (!browserSession(request)) return json(response, 401, { error: 'unauthenticated' })
  if (!LOCAL_ORIGINS.has(request.headers.origin)) return json(response, 403, { error: 'forbidden_origin' })
  if (!CONFIG.channels.wizardWrites) return json(response, 403, { error: 'channels_read_only' })
  const body = await bodyJson(request, 32_768)
  const parsed = validateChannelEnvBody(body)
  if (!parsed) return json(response, 400, { error: 'invalid_channels_env' })
  const envPath = profileEnvPath(CONFIG.hermesHome, parsed.profile)
  try {
    const previous = await readHermesText(request, envPath, parsed.profile)
    const merged = mergeEnvText(previous, parsed.env)
    if (!merged) return json(response, 400, { error: 'invalid_channels_env' })
    const backup = backupPath(envPath)
    if (previous.trim()) await writeHermesText(request, backup, previous, parsed.profile)
    await writeHermesText(request, envPath, merged, parsed.profile)
    return json(response, 200, { ok: true, keys: Object.keys(parsed.env).sort() })
  } catch {
    return json(response, 502, { error: 'channels_env_failed' })
  }
}

async function handlePushWindow(request, response) {
  if (request.method !== 'POST') return json(response, 405, { error: 'method_not_allowed' })
  if (!sameSecret(request.headers['x-hermesbot-local-key'] || '', LOCAL_KEY)) return json(response, 403, { error: 'local_key_required' })
  const body = await bodyJson(request, 256)
  pushRelay.setWindowInFront(body?.inFront === true)
  return json(response, 200, { ok: true })
}

async function handlePushEnqueue(request, response) {
  if (!browserSession(request)) return json(response, 401, { error: 'unauthenticated' })
  if (!LOCAL_ORIGINS.has(request.headers.origin)) return json(response, 403, { error: 'forbidden_origin' })
  if (pushRelay.disabled()) return json(response, 200, { ok: true, skipped: 'relay_off' })
  const body = await bodyJson(request, 4096)
  const slug = typeof body?.slug === 'string' && PROFILE_SLUG.test(body.slug) ? body.slug : ''
  const title = typeof body?.title === 'string' ? body.title.slice(0, 120) : ''
  const preview = typeof body?.body === 'string' ? body.body : ''
  if (!slug || !title) return json(response, 400, { error: 'invalid_push_enqueue' })
  const accountId = await pushAccountForSession(request)
  if (!accountId) return json(response, 502, { error: 'push_account_unavailable' })
  const result = pushRelay.enqueue({ accountId, slug, title, body: preview })
  return json(response, 200, result)
}

async function handleUiLayout(request, response) {
  if (request.method === 'GET') return json(response, 200, loadUiLayout(CONFIG.dataDir))
  if (!browserSession(request)) return json(response, 401, { error: 'unauthenticated' })
  if (!LOCAL_ORIGINS.has(request.headers.origin)) return json(response, 403, { error: 'forbidden_origin' })
  const body = await bodyJson(request, 32_768)
  const saved = saveUiLayout(CONFIG.dataDir, normalizeUiLayout(body))
  CONFIG.ui = { ...CONFIG.ui, sectionOrder: saved.sectionOrder, rosterOrder: saved.rosterOrder }
  return json(response, 200, saved)
}

async function serveProduction(response, pathname) {
  const requested = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '')
  let file = path.resolve(DIST, requested)
  if (!file.startsWith(`${DIST}${path.sep}`) && file !== path.join(DIST, 'index.html')) {
    return json(response, 400, { error: 'bad_path' })
  }
  try {
    if (!(await stat(file)).isFile()) throw new Error('not_file')
  } catch {
    file = path.join(DIST, 'index.html')
  }
  const data = await readFile(file)
  response.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': staticCacheControl(file),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  })
  response.end(data)
}

const server = http.createServer(async (request, response) => {
  try {
    if (!localRequest(request)) return json(response, 403, { error: 'forbidden_origin' })
    const url = new URL(request.url || '/', `http://${HOST}:${PORT}`)
    const browserVaultResponse = /^\/api\/browser-vault\/requests\/([A-Za-z0-9-]+)$/.exec(url.pathname)

    if (url.pathname === '/api/browser-vault/events' && request.method === 'GET') {
      return handleBrowserVaultEvents(request, response)
    }
    if (browserVaultResponse && request.method === 'POST') {
      return await handleBrowserVaultAdmin(request, response, `/admin/v1/requests/${browserVaultResponse[1]}`)
    }
    if (url.pathname === '/api/browser-vault/entries' && (request.method === 'GET' || request.method === 'POST')) {
      return await handleBrowserVaultAdmin(request, response, '/admin/v1/entries')
    }
    if (url.pathname === '/api/browser-vault/entries/remove' && request.method === 'POST') {
      return await handleBrowserVaultAdmin(request, response, '/admin/v1/entries/remove')
    }
    if (url.pathname === '/api/browser-vault/settings' && (request.method === 'GET' || request.method === 'POST')) {
      return await handleBrowserVaultAdmin(request, response, '/admin/v1/settings')
    }
    if (CONFIG.features.vaultWallet) {
      if (url.pathname === '/api/browser-vault/wallet' && request.method === 'GET') {
        return await handleBrowserVaultAdmin(request, response, '/admin/v1/wallet')
      }
      const walletPost = {
        '/api/browser-vault/wallet/card': '/admin/v1/wallet/card',
        '/api/browser-vault/wallet/address': '/admin/v1/wallet/address',
        '/api/browser-vault/wallet/remove': '/admin/v1/wallet/remove',
        '/api/browser-vault/wallet/secure-form': '/admin/v1/wallet/secure-form',
      }
      const walletPath = walletPost[url.pathname]
      if (walletPath && request.method === 'POST') {
        return await handleBrowserVaultAdmin(request, response, walletPath)
      }
    }
    if (url.pathname === '/api/auto-router/decide' && request.method === 'POST') {
      return await handleAutoRouterDecide(request, response)
    }
    if (url.pathname === '/api/auto-router/log' && request.method === 'POST') {
      return await handleAutoRouterLogWrite(request, response)
    }
    if (url.pathname === '/api/auto-router/log' && request.method === 'GET') {
      return await handleAutoRouterLogRead(request, response, url)
    }
    if (url.pathname === '/api/usage/global' && request.method === 'GET') {
      return await handleUsageGlobal(request, response, url)
    }
    if (url.pathname === '/api/pages-library' && (request.method === 'GET' || request.method === 'POST')) {
      return await handlePagesLibrary(request, response, url)
    }
    if (url.pathname === '/api/auth/providers' && request.method === 'GET') {
      return await proxyJson(response, await hermesFetch(request, '/api/auth/providers'))
    }
    if (url.pathname === '/api/auth/me' && request.method === 'GET') {
      const existingSession = browserSession(request)
      const upstream = await hermesFetch(request, '/api/auth/me')
      if (upstream.ok && !existingSession) {
        const adopted = createAdoptedSession(adoptableCookieHeader(request))
        if (adopted) {
          updateCookies(adopted, upstream.headers.getSetCookie?.() || [])
          response.setHeader('Set-Cookie', `${SESSION_COOKIE}=${adopted.id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE}`)
        }
      }
      return await proxyJson(response, upstream)
    }
    if (url.pathname === '/api/auth/login' && request.method === 'POST') {
      return await handleLogin(request, response)
    }
    if (url.pathname === '/api/auth/options' && request.method === 'GET') {
      return json(response, 200, { remember: Boolean(credentialStore), local: await localSignInState() })
    }
    if (url.pathname === '/api/auth/local' && request.method === 'POST') {
      return await handleLocalSignIn(request, response)
    }
    if (url.pathname === '/api/auth/restore' && request.method === 'POST') {
      return await handleRestore(request, response)
    }
    if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
      return await handleLogout(request, response)
    }
    if (url.pathname === '/api/shared-settings' && (request.method === 'GET' || request.method === 'PUT')) {
      return await handleSharedSettings(request, response)
    }
    if (url.pathname === '/api/compaction' && (request.method === 'GET' || request.method === 'PUT')) {
      return await handleCompaction(request, response, url)
    }
    if (url.pathname.startsWith('/api/shared-memory')) {
      return await handleSharedMemory(request, response, url)
    }
    if (url.pathname === '/api/skills' || url.pathname === '/api/skills/toggle') {
      return await handleSkills(request, response, url)
    }
    if (url.pathname === '/api/bot-profile' && (request.method === 'GET' || request.method === 'PUT')) {
      return await handleBotProfile(request, response, url)
    }
    if (url.pathname === '/api/bot-template' || url.pathname === '/api/bot-template/import') {
      return await handleBotTemplate(request, response, url)
    }
    if (url.pathname.startsWith('/api/hermes/') && request.method === 'GET') {
      return await handleReadProxy(request, response, url)
    }
    if (url.pathname.startsWith('/api/hermes/cron/') && request.method !== 'GET') {
      return await handleCronWrite(request, response, url)
    }
    if (url.pathname === '/api/routines/schedule' && request.method === 'POST') {
      return await handleRoutinesSchedule(request, response)
    }
    if (url.pathname === '/api/routines/dry-run' && request.method === 'POST') {
      return await handleRoutinesDryRun(request, response)
    }
    if (url.pathname === '/api/routines/events' && request.method === 'GET') {
      return await handleRoutineEventsList(request, response, url)
    }
    if (url.pathname === '/api/routines/events/bind' && request.method === 'POST') {
      return await handleRoutineEventsBind(request, response)
    }
    if (url.pathname === '/api/routines/events/regenerate' && request.method === 'POST') {
      return await handleRoutineEventsRegenerate(request, response)
    }
    if (url.pathname === '/api/routines/events/runs' && request.method === 'GET') {
      return await handleRoutineEventRuns(request, response, url)
    }
    const hookMatch = ROUTINE_HOOK.exec(url.pathname)
    if (hookMatch && request.method === 'POST') {
      return await handleRoutineWebhook(request, response, hookMatch[1])
    }
    if (url.pathname === '/api/connectors/catalog' && request.method === 'GET') {
      return await handleConnectorsCatalog(response)
    }
    if (url.pathname === '/api/media' && (request.method === 'GET' || request.method === 'HEAD')) {
      return await handleMedia(request, response, url)
    }
    if (url.pathname === '/api/document' && (request.method === 'GET' || request.method === 'HEAD')) {
      return await handleDocument(request, response, url)
    }
    if (url.pathname === '/api/local-chat' && request.method === 'POST') {
      return await handleLocalChat(request, response)
    }
    if (url.pathname === '/api/local-chat/models' && request.method === 'GET') {
      return await handleLocalModels(request, response)
    }
    if (url.pathname === '/api/local-chat/history' || url.pathname.startsWith('/api/local-chat/history/')) {
      return await handleLocalHistory(request, response, url)
    }
    if (url.pathname === '/api/local-chat/status' && request.method === 'GET') {
      return await handleLocalStatus(request, response)
    }
    if ((url.pathname === '/api/local-chat/load' || url.pathname === '/api/local-chat/unload') && request.method === 'POST') {
      return await handleLocalMemory(request, response, url.pathname.endsWith('/load') ? 'load' : 'unload')
    }
    if (url.pathname === '/api/model-probe' && request.method === 'POST') {
      return await handleModelProbe(request, response)
    }
    if (url.pathname === '/api/browser-turn' && request.method === 'GET') {
      if (!browserSession(request)) return json(response, 401, { error: 'unauthenticated' })
      const turns = await readBrowserTurns(BROWSER_TURN_COMMAND)
      const owners = turns.map((turn) => turn.owner)
      return json(response, 200, { owner: owners[0] || '', owners, turns })
    }
    if (url.pathname === '/api/computer-panel/status' && request.method === 'GET') {
      return await handleComputerPanelStatus(request, response, url)
    }
    if (url.pathname === '/api/computer-panel/stream' && request.method === 'GET') {
      return await handleComputerPanelStream(request, response, url)
    }
    if (url.pathname === '/api/computer-panel/takeover' && request.method === 'POST') {
      return await handleComputerPanelTakeover(request, response)
    }
    if (url.pathname === '/api/computer-panel/input' && request.method === 'POST') {
      return await handleComputerPanelInput(request, response)
    }
    if (url.pathname === '/api/computer-panel/control' && request.method === 'GET') {
      return await handleComputerPanelControl(request, response, url)
    }
    if (url.pathname === '/api/model-scores' || url.pathname === '/api/model-scores/key') {
      return await handleModelScores(request, response, url)
    }
    if (url.pathname === '/api/app-config' && request.method === 'GET') {
      return await handleAppConfig(response)
    }
    if (url.pathname === '/api/channels/status') {
      return await handleChannelStatus(request, response, url)
    }
    if (url.pathname === '/api/channels/apply' && request.method === 'PUT') {
      return await handleChannelApply(request, response)
    }
    if (url.pathname === '/api/channels/env' && request.method === 'PUT') {
      return await handleChannelEnv(request, response)
    }
    if (url.pathname === '/api/push/window' && request.method === 'POST') {
      return await handlePushWindow(request, response)
    }
    if (url.pathname === '/api/push/enqueue' && request.method === 'POST') {
      return await handlePushEnqueue(request, response)
    }
    if (url.pathname === '/api/ui-layout') {
      return await handleUiLayout(request, response)
    }
    const animation = ANIMATION_FILE.exec(url.pathname)
    if (animation && (request.method === 'GET' || request.method === 'HEAD')) {
      return await serveAnimation(response, animation[1], animation[2])
    }
    if (url.pathname === '/api/health') {
      return json(response, 200, { ok: true, service: 'hermes-bot' })
    }

    if (isApiPath(url.pathname)) return json(response, 404, { error: 'not_found' })
    if (vite) return vite.middlewares(request, response, () => serveProduction(response, url.pathname))
    return await serveProduction(response, url.pathname)
  } catch (error) {
    if (response.headersSent) return response.end()
    const status = error?.status || (error?.message === 'payload_too_large' ? 413 : 502)
    return json(response, status, { error: status === 401 ? 'unauthenticated' : 'hermes_unavailable' })
  }
})

// `file.attach` sends the file as base64 in one frame: same cap as the gateway (384 MiB).
const WS_MAX_PAYLOAD = 384 * 1024 * 1024
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: WS_MAX_PAYLOAD,
  handleProtocols: () => 'hermes-gateway-v1',
})

attachGatewayUpgrade(server, wss, {
  host: HOST,
  port: PORT,
  accept: (request) => localRequest(request) && LOCAL_ORIGINS.has(request.headers.origin),
  browserSession,
  hermesFetch,
  mintSocketTicket,
  localGateway,
  hermesWsOrigin: HERMES_WS_ORIGIN,
  browserOrigin: HERMES_BROWSER_ORIGIN,
  maxPayload: WS_MAX_PAYLOAD,
})

let vite
if (DEVELOPMENT) {
  const { createServer } = await import('vite')
  vite = await createServer({
    root: ROOT,
    configFile: path.join(ROOT, 'vite.config.ts'),
    server: { middlewareMode: true, hmr: { server } },
    appType: 'spa',
  })
}

const mainListening = new Promise((resolve, reject) => {
  server.once('listening', resolve)
  server.once('error', reject)
})
export const listening = mainListening

server.listen(PORT, HOST, () => {
  console.log(`HermesBot: http://${HOST}:${PORT} (${DEVELOPMENT ? 'dev' : 'production'})`)
  localSignInState().catch(() => {})
})

async function shutdown() {
  wss.clients.forEach((client) => client.close(1001, 'server_shutdown'))
  if (vaultPoll) clearInterval(vaultPoll)
  emailWatcher?.stop()
  sessionStore.stop()
  if (vite) await vite.close()
  server.close(() => process.exit(0))
  server.closeAllConnections()
}
// Electron quits through app.quit() and installs its own fatal handlers. A bare `node server`
// still has to shut down on SIGTERM and stay up if one request throws.
installProcessGuards(process, {
  onShutdown: () => { shutdown().catch(() => process.exit(1)) },
  onError: (error) => {
    const code = error && typeof error === 'object' ? (error.code || error.name) : ''
    console.error(`HermesBot: ${code || 'error'}`)
  },
})
