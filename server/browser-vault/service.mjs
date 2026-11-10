import http from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import { KeychainStore, botAllowed, validBots } from './keychain.mjs'
import { BrowserVaultRequests } from './requests.mjs'
import { BrowserVaultCdp } from './cdp.mjs'
import { BrowserVaultError, vaultError } from './errors.mjs'

const BOT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const TARGET_ID = /^[A-Za-z0-9_-]{1,128}$/

function sendJson(response, status, body) {
  const data = JSON.stringify(body)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(data)
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 16_384) throw new BrowserVaultError('payload_too_large', 413)
    chunks.push(chunk)
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid')
    return value
  } catch {
    throw new BrowserVaultError('invalid_json', 400)
  }
}

/**
 * Coffre du Chrome partagé. API des bots sur `/v1/<list|fill|save|code>` ; API de l’app HermesBot sur
 * `/admin/v1/…` (demandes en attente, identifiants). Aucune route ne renvoie un mot de passe.
 * Identifiants dans le trousseau de session macOS (`keychain.mjs`).
 */
export function createBrowserVault(options = {}) {
  const port = options.port ?? 4331
  const auditSink = options.audit ?? null
  // Jeton de l’API d’administration : sans lui, un bot pourrait s’autoriser l’identifiant d’un autre.
  const adminToken = Buffer.from(`Bearer ${options.adminToken || ''}`)
  if (!options.adminToken) throw new Error('adminToken requis')
  // Toute écriture exige en plus la session Hermes de l’utilisateur, vérifiée par la gateway : le jeton est un
  // fichier, lisible par les bots qui tournent sous le même compte macOS ; cette session, ils ne l’ont pas.
  const verifyUser = options.verifyUser
  if (typeof verifyUser !== 'function') throw new Error('verifyUser requis')
  const verified = new Map()
  async function requireUser(request) {
    const cookie = String(request.headers['x-hermes-cookie'] || '')
    if (!cookie || cookie.length > 8192) throw new BrowserVaultError('user_session_required', 403)
    const key = createHash('sha256').update(cookie).digest('hex')
    if ((verified.get(key) || 0) > Date.now()) return
    let ok = false
    try { ok = await verifyUser(cookie) } catch { ok = false }
    if (!ok) throw new BrowserVaultError('user_session_required', 403)
    if (verified.size > 64) verified.clear()
    verified.set(key, Date.now() + 60_000)
  }
  const store = options.store ?? new KeychainStore()
  const requests = new BrowserVaultRequests()
  const cdp = new BrowserVaultCdp(options.cdpOrigin)
  const saveTimeout = options.saveTimeout ?? 300_000
  const codeTimeout = options.codeTimeout ?? 120_000

  function audit(action, bot, origin, result) {
    if (!auditSink) return
    // Champs explicitement énumérés : jamais de corps de requête ni d’erreur CDP brute.
    const line = JSON.stringify({ at: new Date().toISOString(), action, bot, origin: origin || null, result })
    try { auditSink.append(line) } catch { /* le journal ne doit pas bloquer le coffre */ }
  }

  function validateBot(value) {
    if (typeof value !== 'string' || !BOT_NAME.test(value)) throw new BrowserVaultError('invalid_bot', 400)
    return value
  }

  function validateTarget(value) {
    if (typeof value !== 'string' || !TARGET_ID.test(value)) throw new BrowserVaultError('target_required', 400)
    return value
  }

  async function command(action, body) {
    const bot = validateBot(body.bot)
    if (action === 'list') {
      // Un bot ne voit que les identifiants qu’il a le droit d’utiliser.
      const entries = (await store.list(bot)).map(({ bots: _bots, ...entry }) => entry)
      audit(action, bot, null, 'ok')
      return { status: 'ok', entries }
    }

    const targetId = validateTarget(body.target)
    let origin = ''
    try {
      if (action === 'save' && !store.available) throw new BrowserVaultError('vault_unavailable', 503)
      origin = await cdp.activeOrigin(targetId)
      if (action === 'fill') {
        const known = await store.find(origin)
        if (!known) throw new BrowserVaultError('origin_not_found', 404)
        // Chaque identifiant est réservé aux bots choisis par l’utilisateur.
        if (!botAllowed(known, bot)) throw new BrowserVaultError('bot_not_allowed', 403)
        const entry = await store.get(origin)
        const fields = await cdp.fillCredentials(entry, targetId)
        audit(action, bot, origin, 'filled')
        return { status: 'filled', origin, fields }
      }

      const kind = action === 'save' ? 'save' : 'code'
      const result = await requests.create({ kind, bot, origin, targetId }, kind === 'save' ? saveTimeout : codeTimeout)
      audit(action, bot, origin, result.status)
      return result
    } catch (error) {
      const failure = vaultError(error)
      audit(action, bot, origin, failure.code)
      throw failure
    }
  }

  async function respond(id, body) {
    const request = requests.get(id)
    if (body.action === 'cancel') {
      requests.cancel(id)
      return { ok: true }
    }
    if (request.busy) throw new BrowserVaultError('request_busy', 409)
    requests.setBusy(id, true)
    try {
      if (request.kind === 'save') {
        if (body.action !== 'save') throw new BrowserVaultError('invalid_action', 400)
        // Le bot qui demande s’ajoute aux bots déjà autorisés pour ce site.
        const existing = await store.find(request.origin)
        const bots = existing ? [...existing.bots, request.bot] : [request.bot]
        await store.save(request.origin, body.identifier, body.password, bots)
        audit('saved', request.bot, request.origin, 'ok')
        requests.complete(id, { status: 'saved', origin: request.origin })
      } else {
        if (body.action !== 'code') throw new BrowserVaultError('invalid_action', 400)
        const fields = await cdp.fillCode(request.origin, request.targetId, body.code)
        requests.complete(id, { status: 'filled', origin: request.origin, fields })
      }
      return { ok: true }
    } catch (error) {
      // l’utilisateur peut corriger ou annuler ; le bot continue d’attendre.
      const failure = vaultError(error)
      if (requests.pending.has(id)) requests.setBusy(id, false)
      audit(request.kind, request.bot, request.origin, failure.code)
      throw failure
    }
  }

  /** API de l’app : métadonnées, ajout, changement, retrait. Le mot de passe n’en ressort jamais. */
  async function admin(method, pathname, request) {
    const given = Buffer.from(String(request.headers.authorization || ''))
    if (given.length !== adminToken.length || !timingSafeEqual(given, adminToken)) throw new BrowserVaultError('admin_forbidden', 403)
    if (method === 'GET' && pathname === '/admin/v1/requests') return { requests: requests.snapshot() }
    if (method === 'GET' && pathname === '/admin/v1/entries') return { entries: await store.list() }
    if (method !== 'POST' || request.headers['content-type'] !== 'application/json') throw new BrowserVaultError('invalid_request', 400)
    await requireUser(request)
    const body = await readJson(request)
    const answer = /^\/admin\/v1\/requests\/([A-Za-z0-9-]{1,64})$/.exec(pathname)
    if (answer) return respond(answer[1], body)
    if (pathname === '/admin/v1/entries') {
      const password = typeof body.password === 'string' && body.password ? body.password : undefined
      const entry = await store.save(body.origin, body.identifier, password, validBots(body.bots))
      audit('admin_save', 'hermesbot', entry.origin, 'ok')
      return { entry }
    }
    if (pathname === '/admin/v1/entries/remove') {
      await store.remove(body.origin)
      audit('admin_remove', 'hermesbot', body.origin, 'ok')
      return { ok: true }
    }
    throw new BrowserVaultError('not_found', 404)
  }

  const server = http.createServer(async (request, response) => {
    try {
      if (request.headers.host !== `127.0.0.1:${port}` || request.headers.origin) {
        throw new BrowserVaultError('forbidden_origin', 403)
      }
      const { pathname } = new URL(request.url || '/', `http://127.0.0.1:${port}`)
      if (pathname.startsWith('/admin/v1/')) return sendJson(response, 200, await admin(request.method, pathname, request))
      if (request.method !== 'POST' || request.headers['content-type'] !== 'application/json') {
        throw new BrowserVaultError('invalid_request', 400)
      }
      const match = /^\/v1\/(list|fill|save|code)$/.exec(pathname)
      if (!match) throw new BrowserVaultError('not_found', 404)
      const body = await readJson(request)
      return sendJson(response, 200, await command(match[1], body))
    } catch (error) {
      const failure = vaultError(error)
      return sendJson(response, failure.status, { error: failure.code })
    }
  })

  return {
    server,
    requests,
    respond,
    subscribe: (listener) => requests.subscribe(listener),
    store,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('listening', resolve)
        server.once('error', reject)
        server.listen(port, '127.0.0.1')
      })
    },
    async close() {
      requests.close()
      if (!server.listening) return
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
