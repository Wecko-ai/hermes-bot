import http from 'node:http'
import { readFileSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable, pipeline } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { browserTurnCommand, readBrowserOwners } from './browser-turn.mjs'
import configModule from './config.cjs'
import { createLocalGateway } from './local-gateway.mjs'

const CONFIG = configModule.loadConfig()
const HOST = '127.0.0.1'
const PORT = Number(process.env.PORT || 4330)
const HERMES_ORIGIN = CONFIG.gatewayOrigin
const HERMES_BROWSER_ORIGIN = CONFIG.browserOrigin
const BROWSER_TURN_COMMAND = browserTurnCommand(CONFIG.browserTurn)
const HERMES_WS_ORIGIN = HERMES_ORIGIN.replace(/^http/, 'ws')
const DEVELOPMENT = process.env.NODE_ENV !== 'production'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist')
const LOCAL_ORIGINS = new Set([
  `http://${HOST}:${PORT}`,
  `http://localhost:${PORT}`,
])
// A Hermes gateway without a password, its default setup on one machine: see local-gateway.mjs.
const localGateway = createLocalGateway({ gatewayOrigin: HERMES_ORIGIN, hermesHome: CONFIG.hermesHome })
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
const sessions = new Map()
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
  if (/^[0-9a-f]{64}$/.test(process.env.HERMESBOT_VAULT_TOKEN || '')) return process.env.HERMESBOT_VAULT_TOKEN
  try {
    const value = readFileSync(VAULT_TOKEN_FILE, 'utf8').trim()
    return /^[0-9a-f]{64}$/.test(value) ? value : ''
  } catch {
    return ''
  }
}

function restoreSessions() {
  if (!persistence) return
  try {
    const records = JSON.parse(persistence.load() || '[]')
    if (!Array.isArray(records)) return
    for (const record of records) {
      if (!record || typeof record.id !== 'string') continue
      // A session without a password keeps nothing of Hermes: its token is read from the Hermes home at each use.
      const kind = record.kind === 'local' ? 'local' : 'cookie'
      if (kind === 'cookie' && typeof record.cookieHeader !== 'string') continue
      if (!Number.isFinite(record.expiresAt) || record.expiresAt <= Date.now()) continue
      const cookies = new Map(kind === 'local' ? [] : Object.entries(record.cookies || {}).filter(([, value]) => typeof value === 'string'))
      sessions.set(record.id, { id: record.id, kind, cookies, cookieHeader: kind === 'local' ? '' : record.cookieHeader, expiresAt: record.expiresAt })
    }
  } catch { /* file missing or old format */ }
}

function persistSessions() {
  if (!persistence) return
  const records = [...sessions.values()].map((session) => ({
    id: session.id,
    kind: session.kind,
    cookies: Object.fromEntries(session.cookies),
    cookieHeader: session.cookieHeader,
    expiresAt: session.expiresAt,
  }))
  persistence.save(JSON.stringify(records))
}

restoreSessions()

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
  const text = await upstream.text()
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

function savedCredentials() {
  if (!credentialStore) return null
  try {
    const saved = JSON.parse(credentialStore.load() || 'null')
    return typeof saved?.username === 'string' && typeof saved?.password === 'string' ? saved : null
  } catch {
    return null
  }
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
const MEDIA_FORWARDED_HEADERS = ['range', 'if-range', 'if-none-match', 'if-modified-since']
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
const DOCUMENT_TYPES = {
  pdf: 'application/pdf',
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  md: 'text/markdown; charset=utf-8', markdown: 'text/markdown; charset=utf-8',
}
const DOCUMENT_TEXT_MAX_BYTES = 16 * 1024 * 1024
// A page written by a bot may come from hostile content: opaque origin, local scripts only,
// and no network access. Remote images, fonts and scripts do not load.
const DOCUMENT_POLICIES = {
  pdf: "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; frame-ancestors 'self'",
  html: "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'",
  markdown: "default-src 'none'; sandbox; frame-ancestors 'none'",
}

function documentRequest(url) {
  const target = fileRequest(url)
  if (target.error) return target
  const contentType = DOCUMENT_TYPES[target.extension]
  if (!contentType) return { status: 415, error: 'unsupported_media' }
  const format = target.extension === 'pdf' ? 'pdf' : contentType.startsWith('text/html') ? 'html' : 'markdown'
  return { profile: target.profile, file: target.file, format, contentType }
}

async function handleMedia(request, response, url) {
  const target = mediaRequest(url)
  if (target.error) return json(response, target.status, { error: target.error })
  if (!browserSession(request) && !adoptableCookieHeader(request)) return json(response, 401, { error: 'unauthenticated' })
  // Images: the gateway's download route. Audio and video: its streaming route, with Range.
  return relayFile(request, response, target, target.kind === 'image' ? '/api/fs/download' : '/api/files/stream', {
    // The URL carries the message id (`v`): a file rewritten under the same name comes back with a fresh URL.
    'Cache-Control': 'private, max-age=600',
    'Content-Security-Policy': "default-src 'none'; sandbox; frame-ancestors 'none'",
  })
}

async function handleDocument(request, response, url) {
  const target = documentRequest(url)
  if (target.error) return json(response, target.status, { error: target.error })
  if (!browserSession(request) && !adoptableCookieHeader(request)) return json(response, 401, { error: 'unauthenticated' })
  return relayFile(request, response, target, '/api/fs/download', {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': DOCUMENT_POLICIES[target.format],
  }, target.format === 'pdf' ? Infinity : DOCUMENT_TEXT_MAX_BYTES)
}

/** Relays a gateway file. The type and the policy come from here, never from the gateway. */
async function relayFile(request, response, target, route, policyHeaders, maxBytes = Infinity) {
  const headers = { 'accept-encoding': 'identity' }
  for (const name of MEDIA_FORWARDED_HEADERS) {
    const value = request.headers[name]
    if (typeof value === 'string' && value.length <= 200) headers[name] = value
  }
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
  if (Number(upstream.headers.get('content-length') || 0) > maxBytes) {
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
  pipeline(Readable.fromWeb(upstream.body), response, (error) => {
    // A video player often abandons its Range requests: that is not an error.
    if (error && !['ERR_STREAM_PREMATURE_CLOSE', 'ABORT_ERR'].includes(error.code) && error.name !== 'AbortError') {
      console.warn(`Hermes media: ${error.code || error.name || 'stream_error'}`)
    }
  })
}

// Isolated local chat, with an Ollama model installed on the machine. Only messages are sent, never a tool:
// the model cannot execute anything. From another Mac, 127.0.0.1:11434 may be a tunnel to the Ollama machine.
const OLLAMA_ORIGIN = CONFIG.ollamaOrigin
const LOCAL_CHAT_MAX_BYTES = 4 * 1024 * 1024
const OLLAMA_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/
let ollamaModelsCache = { at: 0, models: null }

/** Models installed in Ollama (`/api/tags`), cached for 30 s. `null`: Ollama does not answer. */
async function ollamaModels() {
  if (ollamaModelsCache.models && Date.now() - ollamaModelsCache.at < 30_000) return ollamaModelsCache.models
  try {
    const upstream = await fetch(`${OLLAMA_ORIGIN}/api/tags`, { signal: AbortSignal.timeout(3000) })
    if (!upstream.ok) return null
    const body = await upstream.json()
    const models = (Array.isArray(body?.models) ? body.models : [])
      .map((model) => (typeof model?.name === 'string' ? model.name : ''))
      .filter((name) => OLLAMA_MODEL.test(name))
    ollamaModelsCache = { at: Date.now(), models }
    return models
  } catch {
    return null
  }
}

async function handleLocalModels(request, response) {
  if (!browserSession(request) && !adoptableCookieHeader(request)) return json(response, 401, { error: 'unauthenticated' })
  const models = await ollamaModels()
  return json(response, 200, { available: models !== null, models: models || [], defaultModel: CONFIG.localChat.model })
}

function localChatMessages(body) {
  if (!Array.isArray(body?.messages) || body.messages.length === 0 || body.messages.length > 400) return null
  const messages = body.messages.map((message) => ({ role: message?.role, content: message?.content }))
  return messages.every(({ role, content }) => (role === 'user' || role === 'assistant') && typeof content === 'string' && content) ? messages : null
}

async function handleLocalChat(request, response) {
  if (!LOCAL_ORIGINS.has(request.headers.origin)) return json(response, 403, { error: 'forbidden_origin' })
  if (!browserSession(request) && !adoptableCookieHeader(request)) return json(response, 401, { error: 'unauthenticated' })
  const body = await bodyJson(request, LOCAL_CHAT_MAX_BYTES)
  const messages = localChatMessages(body)
  if (!messages) return json(response, 400, { error: 'invalid_messages' })
  // The requested model must be installed: the window can target nothing but a local model.
  const requested = typeof body.model === 'string' && body.model ? body.model : CONFIG.localChat.model
  const installed = await ollamaModels()
  if (installed === null) return json(response, 503, { error: 'local_model_unreachable' })
  if (!requested || !installed.includes(requested)) return json(response, 404, { error: 'local_model_missing' })
  const controller = new AbortController()
  response.on('close', () => { if (!response.writableFinished) controller.abort() })
  let upstream
  try {
    upstream = await fetch(`${OLLAMA_ORIGIN}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Unloaded quickly: the machine may be shared, and a large model takes a lot of GPU memory.
      body: JSON.stringify({ model: requested, messages, stream: true, keep_alive: '2m', options: { num_ctx: 32768 } }),
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

/** Call to the vault admin API. Service absent: 503 `vault_service_unavailable`. */
async function vaultAdmin(pathname, body, hermesCookie = '') {
  try {
    const response = await fetch(`${BROWSER_VAULT_ORIGIN}${pathname}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${vaultToken()}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        // Proof that the user is signed in: the vault checks it with the gateway before any write.
        ...(hermesCookie ? { 'X-Hermes-Cookie': hermesCookie } : {}),
      },
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
let vaultPoll = null
async function pollVaultRequests() {
  const { status, body } = await vaultAdmin('/admin/v1/requests')
  const next = JSON.stringify(status === 200 && Array.isArray(body.requests) ? body.requests : [])
  if (next === vaultSnapshot) return
  vaultSnapshot = next
  vaultListeners.forEach((listener) => listener(next))
}

function handleBrowserVaultEvents(request, response) {
  if (!browserSession(request)) return json(response, 401, { error: 'unauthenticated' })
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  const listener = (snapshot) => response.write(`data: ${snapshot}\n\n`)
  vaultListeners.add(listener)
  listener(vaultSnapshot)
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
async function handleBrowserVaultAdmin(request, response, pathname) {
  if (request.method === 'POST' && !LOCAL_ORIGINS.has(request.headers.origin)) return json(response, 403, { error: 'forbidden_origin' })
  const session = browserSession(request)
  if (!session) return json(response, 401, { error: 'unauthenticated' })
  const body = request.method === 'POST' ? await bodyJson(request) : undefined
  const result = await vaultAdmin(pathname, body, session.cookieHeader || '')
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
    ui: CONFIG.ui,
    animatedBots: await animatedBots(),
    localChat: { name: CONFIG.localChat.name },
  })
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
    'Cache-Control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
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
    if (url.pathname.startsWith('/api/hermes/') && request.method === 'GET') {
      return await handleReadProxy(request, response, url)
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
    if (url.pathname === '/api/browser-turn' && request.method === 'GET') {
      if (!browserSession(request) && !adoptableCookieHeader(request)) return json(response, 401, { error: 'unauthenticated' })
      const owners = await readBrowserOwners(BROWSER_TURN_COMMAND)
      return json(response, 200, { owner: owners[0] || '', owners })
    }
    if (url.pathname === '/api/app-config' && request.method === 'GET') {
      return await handleAppConfig(response)
    }
    const animation = ANIMATION_FILE.exec(url.pathname)
    if (animation && (request.method === 'GET' || request.method === 'HEAD')) {
      return await serveAnimation(response, animation[1], animation[2])
    }
    if (url.pathname === '/api/health') {
      return json(response, 200, { ok: true, service: 'hermes-bot' })
    }

    if (vite) return vite.middlewares(request, response, () => serveProduction(response, url.pathname))
    return await serveProduction(response, url.pathname)
  } catch (error) {
    if (response.headersSent) return response.end()
    const status = error?.status || (error?.message === 'payload_too_large' ? 413 : 502)
    return json(response, status, { error: status === 401 ? 'unauthenticated' : 'hermes_unavailable' })
  }
})

// 1005 and 1006 describe a received close: ws refuses to send them.
function isRelayableCloseCode(code) {
  return Number.isInteger(code) && ((code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999))
}

// `file.attach` sends the file as base64 in one frame: same cap as the gateway (384 MiB).
const WS_MAX_PAYLOAD = 384 * 1024 * 1024
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: WS_MAX_PAYLOAD,
  handleProtocols: () => 'hermes-gateway-v1',
})

server.on('upgrade', async (request, socket, head) => {
  try {
    if (!localRequest(request) || !LOCAL_ORIGINS.has(request.headers.origin)) throw Object.assign(new Error('forbidden'), { status: 403 })
    const url = new URL(request.url || '/', `http://${HOST}:${PORT}`)
    if (url.pathname !== '/api/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      return socket.destroy()
    }
    const identity = await hermesFetch(request, '/api/auth/me')
    await identity.body?.cancel().catch(() => {})
    if (!identity.ok) {
      console.warn(`Hermes WS identity: HTTP ${identity.status}`)
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      return socket.destroy()
    }
    const profile = (url.searchParams.get('profile') || 'default').slice(0, 128)
    const ticket = await mintSocketTicket(request, profile)
    // Without a password, the socket goes to the same pinned address as the request that got its ticket.
    const local = browserSession(request)?.kind === 'local'
    const upstreamUrl = `${local ? localGateway.socketOrigin : HERMES_WS_ORIGIN}/api/ws?native_dial=browser&profile=${encodeURIComponent(profile)}`
    const upstream = new WebSocket(upstreamUrl, [
      'hermes-gateway-v1',
      `hermes-gateway-ticket.${ticket}`,
    ], {
      // Without a password the ticket is the whole credential, and the gateway wants no browser Origin.
      headers: local ? {} : { Origin: HERMES_BROWSER_ORIGIN },
      handshakeTimeout: 20_000,
      maxPayload: WS_MAX_PAYLOAD,
    })

    wss.handleUpgrade(request, socket, head, (browser) => {
      const closeBoth = () => {
        if (browser.readyState === WebSocket.OPEN) browser.close()
        if (upstream.readyState === WebSocket.OPEN) upstream.close()
      }
      upstream.on('open', () => {
        console.log('Hermes WS upstream: connected')
        browser.on('message', (data, binary) => upstream.readyState === WebSocket.OPEN && upstream.send(data, { binary }))
        upstream.on('message', (data, binary) => browser.readyState === WebSocket.OPEN && browser.send(data, { binary }))
      })
      upstream.on('close', (code, reason) => {
        console.warn(`Hermes WS upstream: close ${code}`)
        if (browser.readyState !== WebSocket.OPEN) return
        if (isRelayableCloseCode(code)) browser.close(code, reason)
        else browser.close(1011)
      })
      upstream.on('unexpected-response', (_request, response) => {
        console.error(`Hermes WS upstream: HTTP ${response.statusCode}`)
      })
      upstream.on('error', (error) => {
        console.error(`Hermes WS upstream: ${error.code || 'connection_error'}`)
        closeBoth()
      })
      browser.on('close', () => upstream.readyState === WebSocket.OPEN && upstream.close())
      browser.on('error', () => closeBoth())
    })
  } catch (error) {
    console.error(`Hermes WS upgrade: ${error?.status || error?.code || 'failed'}`)
    if (!socket.destroyed) {
      socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      socket.destroy()
    }
  }
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
  if (vite) await vite.close()
  server.close(() => process.exit(0))
  server.closeAllConnections()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
