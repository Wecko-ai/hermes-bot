import http from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import { KeychainStore, botAllowed, validBots, validIdentifier } from './keychain.mjs'
import { BrowserVaultRequests } from './requests.mjs'
import { BrowserVaultCdp } from './cdp.mjs'
import { BrowserVaultError, vaultError } from './errors.mjs'
import { generatePassword } from './password.mjs'

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
 * Shared Chrome vault. Bot API on `/v1/<list|fill|save|code|signup>`; HermesBot app API on
 * `/admin/v1/…` (pending requests, credentials). No route returns a password.
 * Credentials live in the macOS session keychain (`keychain.mjs`).
 */
export function createBrowserVault(options = {}) {
  const port = options.port ?? 4331
  const auditSink = options.audit ?? null
  // Admin API token: without it, a bot could authorize itself to use another bot's credential.
  const adminToken = Buffer.from(`Bearer ${options.adminToken || ''}`)
  if (!options.adminToken) throw new Error('adminToken required')
  // Every write also requires the user's Hermes session, checked by the gateway: the token is a
  // file, readable by the bots running under the same macOS account; they do not have this session.
  const verifyUser = options.verifyUser
  if (typeof verifyUser !== 'function') throw new Error('verifyUser required')
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
  // One Chrome per bot team: one CDP client per origin, chosen by the bot making the request.
  const cdpClients = new Map()
  function cdpFor(bot) {
    const origin = (typeof options.cdpOriginFor === 'function' ? options.cdpOriginFor(bot) : '') || options.cdpOrigin || ''
    let client = cdpClients.get(origin)
    if (!client) {
      client = new BrowserVaultCdp(origin || undefined)
      cdpClients.set(origin, client)
    }
    return client
  }
  const saveTimeout = options.saveTimeout ?? 300_000
  const codeTimeout = options.codeTimeout ?? 120_000

  function audit(action, bot, origin, result, identifier) {
    if (!auditSink) return
    // Explicitly listed fields: never a request body, a password or a raw CDP error.
    const line = JSON.stringify({ at: new Date().toISOString(), action, bot, origin: origin || null, ...(identifier ? { identifier } : {}), result })
    try { auditSink.append(line) } catch { /* the log must not block the vault */ }
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
      // A bot only sees the credentials it is allowed to use.
      const entries = (await store.list(bot)).map(({ bots: _bots, ...entry }) => entry)
      audit(action, bot, null, 'ok')
      return { status: 'ok', entries }
    }

    const targetId = validateTarget(body.target)
    // Sign-up: the login the bot registers (an e-mail, a username), never a password.
    const identifier = action === 'signup' ? validIdentifier(body.identifier) : undefined
    let origin = ''
    try {
      if ((action === 'save' || action === 'signup') && !store.available) throw new BrowserVaultError('vault_unavailable', 503)
      origin = await cdpFor(bot).activeOrigin(targetId)
      if (action === 'fill') {
        const known = await store.find(origin)
        if (!known) throw new BrowserVaultError('origin_not_found', 404)
        // Each credential is reserved for the bots the user chose.
        if (!botAllowed(known, bot)) throw new BrowserVaultError('bot_not_allowed', 403)
        const entry = await store.get(origin)
        const fields = await cdpFor(bot).fillCredentials(entry, targetId)
        audit(action, bot, origin, 'filled')
        return { status: 'filled', origin, fields }
      }

      if (action === 'signup') {
        // One credential per site in the keychain: a new account must never replace a stored one.
        if (await store.find(origin)) throw new BrowserVaultError('entry_exists', 409)
        const result = await requests.create({ kind: 'signup', bot, origin, targetId, identifier }, saveTimeout)
        audit(action, bot, origin, result.status, identifier)
        return result
      }

      const kind = action === 'save' ? 'save' : 'code'
      const result = await requests.create({ kind, bot, origin, targetId }, kind === 'save' ? saveTimeout : codeTimeout)
      audit(action, bot, origin, result.status)
      return result
    } catch (error) {
      const failure = vaultError(error)
      audit(action, bot, origin, failure.code, identifier)
      throw failure
    }
  }

  /**
   * Sign-up accepted by the user: the vault draws the password, stores it, then types it into every
   * password field of the page. The password exists only in this function, the keychain and the page.
   */
  async function acceptSignup(request) {
    const password = generatePassword()
    let saved = false
    const saveFirst = async () => {
      if (await store.find(request.origin)) throw new BrowserVaultError('entry_exists', 409)
      await store.save(request.origin, request.identifier, password, [request.bot])
      saved = true
    }
    try {
      const fields = await cdpFor(request.bot).fillSignup(request.origin, request.targetId, request.identifier, password, saveFirst)
      return { status: 'filled', origin: request.origin, saved: true, fields }
    } catch (error) {
      if (!saved) throw error
      // Stored but not typed: the bot can run `fill` once the form is back.
      return { status: 'saved', origin: request.origin, saved: true, filled: false, error: vaultError(error).code }
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
        // The requesting bot is added to the bots already authorized for this site.
        const existing = await store.find(request.origin)
        const bots = existing ? [...existing.bots, request.bot] : [request.bot]
        await store.save(request.origin, body.identifier, body.password, bots)
        audit('saved', request.bot, request.origin, 'ok')
        requests.complete(id, { status: 'saved', origin: request.origin })
      } else if (request.kind === 'signup') {
        if (body.action !== 'signup') throw new BrowserVaultError('invalid_action', 400)
        const result = await acceptSignup(request)
        audit('signed_up', request.bot, request.origin, result.status, request.identifier)
        requests.complete(id, result)
      } else {
        if (body.action !== 'code') throw new BrowserVaultError('invalid_action', 400)
        const fields = await cdpFor(request.bot).fillCode(request.origin, request.targetId, body.code)
        requests.complete(id, { status: 'filled', origin: request.origin, fields })
      }
      return { ok: true }
    } catch (error) {
      const failure = vaultError(error)
      // A sign-up that failed before anything was stored goes back to the bot: only it can fix the page.
      // Its own call writes the log line.
      if (request.kind === 'signup' && failure.code !== 'invalid_action' && requests.pending.has(id)) {
        requests.fail(id, failure)
        throw failure
      }
      audit(request.kind, request.bot, request.origin, failure.code, request.identifier)
      // the user can fix or cancel; the bot keeps waiting.
      if (requests.pending.has(id)) requests.setBusy(id, false)
      throw failure
    }
  }

  /** App API: metadata, add, change, remove. The password never comes back out of it. */
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
      const match = /^\/v1\/(list|fill|save|code|signup)$/.exec(pathname)
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
