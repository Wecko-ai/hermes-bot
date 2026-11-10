import http from 'node:http'
import { BrowserVaultStore } from './store.mjs'
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

export function createBrowserVault(options = {}) {
  const port = options.port ?? 4331
  const persistence = options.persistence === undefined ? globalThis.__hermesBotBrowserVaultPersistence : options.persistence
  const auditSink = options.audit === undefined ? globalThis.__hermesBotBrowserVaultAudit : options.audit
  const store = new BrowserVaultStore(persistence)
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
      const entries = store.list()
      audit(action, bot, null, 'ok')
      return { status: 'ok', entries }
    }

    const targetId = validateTarget(body.target)
    let origin = ''
    try {
      if (action === 'save' && !store.available) throw new BrowserVaultError('vault_unavailable', 503)
      origin = await cdp.activeOrigin(targetId)
      if (action === 'fill') {
        const entry = store.get(origin)
        const fields = await cdp.fillCredentials(entry, targetId)
        store.markUsed(origin)
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
        store.save(request.origin, body.identifier, body.password)
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

  const server = http.createServer(async (request, response) => {
    try {
      if (request.headers.host !== `127.0.0.1:${port}` || request.headers.origin) {
        throw new BrowserVaultError('forbidden_origin', 403)
      }
      if (request.method !== 'POST' || request.headers['content-type'] !== 'application/json') {
        throw new BrowserVaultError('invalid_request', 400)
      }
      const match = /^\/v1\/(list|fill|save|code)$/.exec(new URL(request.url || '/', `http://127.0.0.1:${port}`).pathname)
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
    get available() { return store.available },
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
