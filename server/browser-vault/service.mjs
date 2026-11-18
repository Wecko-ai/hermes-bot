import http from 'node:http'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { KeychainStore, botAllowed, validBots, validIdentifier } from './keychain.mjs'
import { BrowserVaultRequests } from './requests.mjs'
import { BrowserVaultCdp } from './cdp.mjs'
import { BrowserVaultError, vaultError } from './errors.mjs'
import { generatePassword } from './password.mjs'
import { accountPageProvider, ssoProvider, useSsoResult } from './sso.mjs'
import { memorySettings } from './settings.mjs'

const BOT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const TARGET_ID = /^[A-Za-z0-9_-]{1,128}$/
// Accounts created without a card, kept for the app's notice: the last 20, for one day at most.
const NOTICE_LIMIT = 20
const NOTICE_TTL = 24 * 60 * 60 * 1000
const MAX_SIGNUPS_PER_HOUR = 5
const SIGNUP_WINDOW_MS = 60 * 60 * 1000
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** Loopback origin for the Hermes session check, or null. Anything else fails closed. */
export function loopbackOrigin(value) {
  try {
    const url = new URL(String(value || ''))
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null
    if (!LOOPBACK_HOSTS.has(url.hostname)) return null
    return url.origin
  } catch {
    return null
  }
}

function sameBotUnconfirmed(existing, bot) {
  return existing?.unconfirmed === true
    && Array.isArray(existing.bots)
    && existing.bots.length === 1
    && existing.bots[0] === bot
}

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
 * `/admin/v1/…` (pending requests, notices, credentials, settings). No route returns a password.
 * Credentials live in the macOS session keychain (`keychain.mjs`), the user's settings in
 * `options.settings` (`settings.mjs`).
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
  // Without a settings file, the defaults: every sign-up waits for the user's card.
  const settings = options.settings ?? memorySettings()
  // "Share credentials between all bots" (Settings, Vault): a login given to one bot serves them all.
  const sharing = () => settings.get().shareCredentials === true
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

  // Sign-ups the user's setting let through without a card: the app tells the user afterwards.
  // Metadata only, as on a card: bot, site, login. Never a password.
  let notices = []
  function currentNotices() {
    const oldest = Date.now() - NOTICE_TTL
    notices = notices.filter((notice) => Date.parse(notice.at) >= oldest)
    return notices.map((notice) => ({ ...notice }))
  }
  function addNotice(bot, origin, identifier) {
    notices = [...currentNotices(), { id: randomUUID(), kind: 'auto_signup', bot, origin, identifier, at: new Date().toISOString() }].slice(-NOTICE_LIMIT)
  }

  function validateBot(value) {
    if (typeof value !== 'string' || !BOT_NAME.test(value)) throw new BrowserVaultError('invalid_bot', 400)
    return value
  }

  function validateTarget(value) {
    if (typeof value !== 'string' || !TARGET_ID.test(value)) throw new BrowserVaultError('target_required', 400)
    return value
  }

  // Account creations per bot, so a loop cannot write the keychain without bound.
  const signupTimes = new Map()
  function recentSignups(bot) {
    const now = Date.now()
    const recent = (signupTimes.get(bot) || []).filter((at) => now - at < SIGNUP_WINDOW_MS)
    signupTimes.set(bot, recent)
    return recent
  }
  function takeSignupSlot(bot) {
    const recent = recentSignups(bot)
    if (recent.length >= MAX_SIGNUPS_PER_HOUR) throw new BrowserVaultError('too_many_signups', 429)
    recent.push(Date.now())
  }

  async function command(action, body) {
    const bot = validateBot(body.bot)
    if (action === 'list') {
      // A bot only sees the credentials it is allowed to use; with sharing on, all of them.
      const entries = (await store.list(sharing() ? null : bot)).map(({ bots: _bots, ...entry }) => entry)
      audit(action, bot, null, 'ok')
      return { status: 'ok', entries }
    }

    const targetId = validateTarget(body.target)
    // Sign-up: the login the bot registers (an e-mail, a username), never a password.
    const identifier = action === 'signup' ? validIdentifier(body.identifier) : undefined
    let origin = ''
    // `save` only: the page's "Continue with Google" (Apple, Microsoft), a hint for the card. Never blocks.
    let sso = null
    try {
      // The CLI refuses cron locally. Here the server only honors the client-supplied flag.
      if (action === 'signup' && body.unattended === true) throw new BrowserVaultError('unattended_session', 403)
      if ((action === 'save' || action === 'signup') && !store.available) throw new BrowserVaultError('vault_unavailable', 503)
      if (action === 'save') ({ origin, sso } = await cdpFor(bot).inspectLogin(targetId))
      else origin = await cdpFor(bot).activeOrigin(targetId)
      if (action === 'fill') {
        const known = await store.find(origin)
        if (!known) throw new BrowserVaultError('origin_not_found', 404)
        // Each credential is reserved for the bots the user chose, unless the user shares them all.
        if (!sharing() && !botAllowed(known, bot)) throw new BrowserVaultError('bot_not_allowed', 403)
        const entry = await store.get(origin)
        const fields = await cdpFor(bot).fillCredentials(entry, targetId)
        audit(action, bot, origin, 'filled')
        return { status: 'filled', origin, fields }
      }

      if (action === 'signup') {
        // One credential per site. The same bot may replace an item that was stored but not typed.
        const existing = await store.find(origin)
        if (existing && !sameBotUnconfirmed(existing, bot)) throw new BrowserVaultError('entry_exists', 409)
        if (recentSignups(bot).length >= MAX_SIGNUPS_PER_HOUR) throw new BrowserVaultError('too_many_signups', 429)
        if (settings.get().autoSignup === true) {
          // "Create accounts without asking" (Settings, Vault): the same steps as an accepted card,
          // without the card. Only sign-ups: `save` and `code` always wait for the user.
          audit(action, bot, origin, 'auto_approved', identifier)
          const result = await acceptSignup({ bot, origin, targetId, identifier })
          audit('signed_up', bot, origin, result.status, identifier)
          if (result.status === 'filled') addNotice(bot, origin, identifier)
          return result
        }
        const result = await requests.create({ kind: 'signup', bot, origin, targetId, identifier }, saveTimeout)
        audit(action, bot, origin, result.status, identifier)
        return result
      }

      const kind = action === 'save' ? 'save' : 'code'
      let replaces
      if (kind === 'save') {
        const existing = await store.find(origin)
        if (existing && typeof existing.identifier === 'string' && existing.identifier) {
          replaces = { identifier: existing.identifier, bots: Array.isArray(existing.bots) ? [...existing.bots] : [] }
        }
      }
      const result = await requests.create({ kind, bot, origin, targetId, ...(sso ? { sso } : {}), ...(replaces ? { replaces } : {}) }, kind === 'save' ? saveTimeout : codeTimeout)
      audit(action, bot, origin, result.status)
      return result
    } catch (error) {
      const failure = vaultError(error)
      audit(action, bot, origin, failure.code, identifier)
      throw failure
    }
  }

  // One sign-up at a time per site: two at once could both pass `entry_exists`, and the second
  // would replace in the keychain the password the first one typed.
  const signupLocks = new Map()
  async function oneSignupPerSite(origin, task) {
    const run = (signupLocks.get(origin) || Promise.resolve()).then(task)
    const tail = run.catch(() => undefined)
    signupLocks.set(origin, tail)
    try {
      return await run
    } finally {
      if (signupLocks.get(origin) === tail) signupLocks.delete(origin)
    }
  }

  /**
   * Sign-up accepted by the user (card or setting): the vault draws the password, stores it, then types
   * it into every password field of the page. The password exists only in this function, the keychain
   * and the page.
   */
  function acceptSignup(request) {
    return oneSignupPerSite(request.origin, () => signupNow(request))
  }

  async function signupNow(request) {
    const existing = await store.find(request.origin)
    if (existing && !sameBotUnconfirmed(existing, request.bot)) throw new BrowserVaultError('entry_exists', 409)
    takeSignupSlot(request.bot)
    const password = generatePassword()
    let saved = false
    const saveFirst = async () => {
      const current = await store.find(request.origin)
      if (current && !sameBotUnconfirmed(current, request.bot)) throw new BrowserVaultError('entry_exists', 409)
      await store.save(request.origin, request.identifier, password, [request.bot])
      saved = true
    }
    try {
      const fields = await cdpFor(request.bot).fillSignup(request.origin, request.targetId, request.identifier, password, saveFirst)
      return { status: 'filled', origin: request.origin, saved: true, fields }
    } catch (error) {
      if (!saved) throw error
      // Stored but not typed: the same bot's next signup may replace this item. The bot can also `fill`.
      try {
        await store.save(request.origin, request.identifier, password, [request.bot], { unconfirmed: true })
      } catch { /* the item stays; a later signup then reports entry_exists */ }
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
      if (request.kind === 'save' && body.action === 'sso') {
        // The user signs in to this site with Google (Apple, Microsoft): nothing is stored, the bot
        // is told to use the site's button. Not on the provider's own sign-in page: no such button there.
        const provider = ssoProvider(body.provider)
        if (accountPageProvider(request.origin)) throw new BrowserVaultError('invalid_action', 400)
        requests.complete(id, useSsoResult(request.origin, provider))
      } else if (request.kind === 'save') {
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
    // GETs are bearer-only. They never read or check the Hermes cookie.
    if (method === 'GET') {
      if (pathname === '/admin/v1/requests') return { requests: requests.snapshot(), notices: currentNotices() }
      if (pathname === '/admin/v1/entries') return { entries: await store.list() }
      if (pathname === '/admin/v1/settings') return { settings: settings.get() }
      throw new BrowserVaultError('invalid_request', 400)
    }
    // Clears the session-validation cache. Bearer only: no Hermes cookie. The app calls this on logout.
    if (method === 'POST' && pathname === '/admin/v1/logout') {
      verified.clear()
      try {
        for await (const chunk of request) { void chunk }
      } catch { /* the cache is already clear */ }
      return { ok: true }
    }
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
    if (pathname === '/admin/v1/settings') {
      const next = await settings.set(body)
      // One word per changed setting (keys already checked by `settings.set`).
      const words = { autoSignup: 'auto_signup', shareCredentials: 'share_credentials' }
      audit('admin_settings', 'hermesbot', null, Object.keys(body).map((key) => `${words[key]}_${next[key] ? 'on' : 'off'}`).join(','))
      return { settings: next }
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
    notices: currentNotices,
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
