import http from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable, pipeline } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'
import { randomBytes } from 'node:crypto'
import { createBrowserVault } from './browser-vault/service.mjs'
import { vaultError } from './browser-vault/errors.mjs'
import { readBrowserOwner } from './browser-turn.mjs'

const HOST = '127.0.0.1'
const PORT = Number(process.env.PORT || 4330)
const HERMES_ORIGIN = process.env.HERMES_ORIGIN || 'http://127.0.0.1:9120'
const HERMES_BROWSER_ORIGIN = process.env.HERMES_BROWSER_ORIGIN || HERMES_ORIGIN
const HERMES_WS_ORIGIN = HERMES_ORIGIN.replace(/^http/, 'ws')
const DEVELOPMENT = process.env.NODE_ENV !== 'production'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist')
const LOCAL_ORIGINS = new Set([
  `http://${HOST}:${PORT}`,
  `http://localhost:${PORT}`,
])

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
const BROWSER_VAULT_PORT = Number(process.env.BROWSER_VAULT_PORT || 4331)
if (!Number.isInteger(BROWSER_VAULT_PORT) || BROWSER_VAULT_PORT < 1 || BROWSER_VAULT_PORT > 65535) throw new Error('BROWSER_VAULT_PORT invalide')
const browserVault = createBrowserVault({
  port: BROWSER_VAULT_PORT,
  cdpOrigin: process.env.BROWSER_VAULT_CDP_ORIGIN || 'http://127.0.0.1:9222',
})

function restoreSessions() {
  if (!persistence) return
  try {
    const records = JSON.parse(persistence.load() || '[]')
    if (!Array.isArray(records)) return
    for (const record of records) {
      if (!record || typeof record.id !== 'string' || typeof record.cookieHeader !== 'string') continue
      if (!Number.isFinite(record.expiresAt) || record.expiresAt <= Date.now()) continue
      const cookies = new Map(Object.entries(record.cookies || {}).filter(([, value]) => typeof value === 'string'))
      sessions.set(record.id, { id: record.id, cookies, cookieHeader: record.cookieHeader, expiresAt: record.expiresAt })
    }
  } catch { /* fichier absent ou ancien format */ }
}

function persistSessions() {
  if (!persistence) return
  const records = [...sessions.values()].map((session) => ({
    id: session.id,
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

function createSession(setCookies) {
  const id = randomBytes(32).toString('base64url')
  const session = { id, cookies: new Map(), cookieHeader: '', expiresAt: Date.now() + SESSION_MAX_AGE * 1000 }
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
  const cookieHeader = session?.cookieHeader || adoptableCookieHeader(request)
  if (cookieHeader) headers.set('cookie', cookieHeader)
  headers.set('origin', HERMES_BROWSER_ORIGIN)
  const response = await fetch(`${HERMES_ORIGIN}${route}`, {
    method: options.method || 'GET',
    headers,
    body: options.body,
    redirect: 'manual',
    // Un média en flux n’a pas de durée maximale : son appelant gère l’arrêt.
    signal: options.signal || AbortSignal.timeout(options.timeout || 20_000),
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
  // Coché : chiffré par le Trousseau, jamais renvoyé à l’interface. Décoché : on oublie ce qui était gardé.
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

/** La session Hermes a expiré : nouvelle connexion avec les identifiants gardés, sans écran. */
async function handleRestore(request, response) {
  if (!LOCAL_ORIGINS.has(request.headers.origin)) return json(response, 403, { error: 'forbidden_origin' })
  // L’Origin s’imite : sans cookie local, un autre processus de la machine obtiendrait une session.
  const session = browserSession(request)
  if (!session) return json(response, 404, { error: 'no_local_session' })
  const saved = savedCredentials()
  if (!saved) return json(response, 404, { error: 'no_saved_credentials' })
  // hermesFetch range les nouveaux cookies Hermes dans cette session.
  const upstream = await passwordLogin(request, saved)
  await upstream.body?.cancel().catch(() => {})
  if (upstream.status === 401) {
    credentialStore.clear() // mot de passe changé : ne pas insister contre la gateway
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
  await hermesFetch(request, '/auth/logout', { method: 'POST' }).then((upstream) => upstream.body?.cancel()).catch(() => {})
  const session = browserSession(request)
  if (session) {
    sessions.delete(session.id)
    persistSessions()
  }
  return json(response, 200, { ok: true }, { 'Set-Cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` })
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
  if (upstream.status === 403) {
    console.warn('Hermes socket-ticket: HTTP 403, essai /api/auth/ws-ticket')
    upstream = await hermesFetch(request, '/api/auth/ws-ticket', { method: 'POST' })
  }
  if (!upstream.ok) {
    const body = await upstream.json().catch(() => ({}))
    const reason = String(body.reason || body.error || body.detail || '').replace(/[A-Za-z0-9_-]{32,}/g, '<masqué>').slice(0, 120)
    console.warn(`Hermes socket-ticket: HTTP ${upstream.status}${reason ? ` (${reason})` : ''}`)
    const error = new Error('socket_ticket_refused')
    error.status = upstream.status
    throw error
  }
  const result = await upstream.json()
  if (!result.ticket || typeof result.ticket !== 'string') throw new Error('socket_ticket_missing')
  return result.ticket
}

// Médias `MEDIA:/chemin` des bots. Les fichiers sont sur la machine de la gateway : elle les lit, avec la
// session Hermes gardée ici. Doit rester identique à PLAYABLE dans src/lib/media.ts.
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
// Statut gateway → statut et code renvoyés à l’interface, sans détail de chemin.
const MEDIA_ERRORS = {
  401: [401, 'unauthenticated'], 403: [403, 'media_forbidden'], 404: [404, 'media_not_found'],
  413: [415, 'unsupported_media'], 415: [415, 'unsupported_media'],
}

function fileRequest(url) {
  const profile = url.searchParams.get('profile') || ''
  const file = url.searchParams.get('path') || ''
  if (!MEDIA_PROFILE.test(profile)) return { status: 400, error: 'invalid_profile' }
  if (!file || file.length > 4096 || /[\u0000-\u001f\u007f]/.test(file)) return { status: 400, error: 'invalid_path' }
  // Chemin absolu de fichier : pas de dossier (`x.png/`), pas d’hôte (`//hôte/x.png`), pas de `.` ni de `..`.
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

// Documents ouverts dans un onglet à côté du chat. Doit rester identique aux formats de `src/lib/media.ts`.
const DOCUMENT_TYPES = {
  pdf: 'application/pdf',
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  md: 'text/markdown; charset=utf-8', markdown: 'text/markdown; charset=utf-8',
}
const DOCUMENT_TEXT_MAX_BYTES = 16 * 1024 * 1024
// Une page écrite par un bot peut venir d’un contenu hostile : origine opaque, scripts locaux seulement,
// et aucune sortie réseau. Les images, polices et scripts distants ne se chargent pas.
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
  // Images : route de téléchargement de la gateway. Audio et vidéo : sa route de lecture, avec Range.
  return relayFile(request, response, target, target.kind === 'image' ? '/api/fs/download' : '/api/files/stream', {
    // L’URL porte l’identifiant du message (`v`) : un fichier réécrit sous le même nom revient avec une URL neuve.
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

/** Relaie un fichier de la gateway. Le type et la politique viennent d’ici, jamais de la gateway. */
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
    // Le type vient de l’extension validée, jamais de la gateway : un image/svg+xml ne passe pas pour un .png.
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
  // fetch décompresse : une longueur compressée ne correspondrait plus au corps relayé.
  if (upstream.headers.get('content-encoding')) delete outgoing['content-length']
  response.writeHead(status, outgoing)
  if (!upstream.body || request.method === 'HEAD' || status === 304) {
    upstream.body?.cancel().catch(() => {})
    return response.end()
  }
  pipeline(Readable.fromWeb(upstream.body), response, (error) => {
    // Un lecteur vidéo abandonne souvent ses requêtes Range : ce n’est pas une erreur.
    if (error && !['ERR_STREAM_PREMATURE_CLOSE', 'ABORT_ERR'].includes(error.code) && error.name !== 'AbortError') {
      console.warn(`Hermes media: ${error.code || error.name || 'stream_error'}`)
    }
  })
}

// Chat local isolé. Le modèle est fixé ici et seuls les messages partent : ce modèle sans refus n’a aucun
// outil. Depuis un autre Mac, 127.0.0.1:11434 peut être un tunnel vers la machine d’Ollama.
const OLLAMA_ORIGIN = process.env.OLLAMA_ORIGIN || 'http://127.0.0.1:11434'
const LOCAL_CHAT_MODEL = 'huihui-qwen3.8-27b-abliterated:q4_k'
const LOCAL_CHAT_MAX_BYTES = 4 * 1024 * 1024

function localChatMessages(body) {
  if (!Array.isArray(body?.messages) || body.messages.length === 0 || body.messages.length > 400) return null
  const messages = body.messages.map((message) => ({ role: message?.role, content: message?.content }))
  return messages.every(({ role, content }) => (role === 'user' || role === 'assistant') && typeof content === 'string' && content) ? messages : null
}

async function handleLocalChat(request, response) {
  if (!LOCAL_ORIGINS.has(request.headers.origin)) return json(response, 403, { error: 'forbidden_origin' })
  if (!browserSession(request) && !adoptableCookieHeader(request)) return json(response, 401, { error: 'unauthenticated' })
  const messages = localChatMessages(await bodyJson(request, LOCAL_CHAT_MAX_BYTES))
  if (!messages) return json(response, 400, { error: 'invalid_messages' })
  const controller = new AbortController()
  response.on('close', () => { if (!response.writableFinished) controller.abort() })
  let upstream
  try {
    upstream = await fetch(`${OLLAMA_ORIGIN}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Déchargé vite : la machine est partagée, et ce modèle occupe environ 18 Go de mémoire GPU.
      body: JSON.stringify({ model: LOCAL_CHAT_MODEL, messages, stream: true, keep_alive: '2m', options: { num_ctx: 32768 } }),
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

function handleBrowserVaultEvents(request, response) {
  if (!browserSession(request)) return json(response, 401, { error: 'unauthenticated' })
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  const unsubscribe = browserVault.subscribe((requests) => {
    response.write(`data: ${JSON.stringify(requests)}\n\n`)
  })
  const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 20_000)
  heartbeat.unref()
  response.on('close', () => { clearInterval(heartbeat); unsubscribe() })
}

async function handleBrowserVaultResponse(request, response, id) {
  if (!LOCAL_ORIGINS.has(request.headers.origin)) return json(response, 403, { error: 'forbidden_origin' })
  if (!browserSession(request)) return json(response, 401, { error: 'unauthenticated' })
  try {
    await browserVault.respond(id, await bodyJson(request))
    return json(response, 200, { ok: true })
  } catch (error) {
    const failure = vaultError(error)
    return json(response, failure.status, { error: failure.code })
  }
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

// Les réponses des bots peuvent venir d’un contenu hostile : rien ne doit charger ni appeler l’extérieur.
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
      return await handleBrowserVaultResponse(request, response, browserVaultResponse[1])
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
      return json(response, 200, { remember: Boolean(credentialStore) })
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
    if (url.pathname === '/api/browser-turn' && request.method === 'GET') {
      if (!browserSession(request) && !adoptableCookieHeader(request)) return json(response, 401, { error: 'unauthenticated' })
      return json(response, 200, { owner: await readBrowserOwner() })
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

// 1005 et 1006 décrivent une fermeture reçue : ws refuse de les envoyer.
function isRelayableCloseCode(code) {
  return Number.isInteger(code) && ((code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999))
}

// `file.attach` envoie le fichier en base64 dans une trame : même plafond que la gateway (384 Mio).
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
    if (!identity.ok) {
      console.warn(`Hermes WS identity: HTTP ${identity.status}`)
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      return socket.destroy()
    }
    const profile = (url.searchParams.get('profile') || 'default').slice(0, 128)
    const ticket = await mintSocketTicket(request, profile)
    const upstreamUrl = `${HERMES_WS_ORIGIN}/api/ws?native_dial=browser&profile=${encodeURIComponent(profile)}`
    const upstream = new WebSocket(upstreamUrl, [
      'hermes-gateway-v1',
      `hermes-gateway-ticket.${ticket}`,
    ], {
      headers: { Origin: HERMES_BROWSER_ORIGIN },
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
const browserVaultListening = browserVault.listen()
export const listening = Promise.all([mainListening, browserVaultListening]).then(() => undefined)

server.listen(PORT, HOST, () => {
  console.log(`HermesBot: http://${HOST}:${PORT} (${DEVELOPMENT ? 'dev' : 'production'})`)
  console.log(`Coffre navigateur: http://${HOST}:${BROWSER_VAULT_PORT}`)
})

async function shutdown() {
  wss.clients.forEach((client) => client.close(1001, 'server_shutdown'))
  const vaultClosing = browserVault.close()
  if (vite) await vite.close()
  server.close(async () => { await vaultClosing; process.exit(0) })
  server.closeAllConnections()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
