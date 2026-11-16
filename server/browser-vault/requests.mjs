import { randomUUID } from 'node:crypto'
import { BrowserVaultError } from './errors.mjs'

const MAX_PENDING = 20
const MAX_PENDING_PER_BOT = 3
// After a failed injection the original deadline may already have passed. Keep the card long enough
// for the user to fix the value or cancel, instead of expiring on the next tick.
const MIN_IDLE_MS = 30_000

/** Save only: the login this approval would replace. Never a password, never unknown fields. */
function publicReplaces(replaces) {
  if (!replaces || typeof replaces !== 'object') return null
  const identifier = typeof replaces.identifier === 'string' ? replaces.identifier.trim() : ''
  const bots = Array.isArray(replaces.bots) ? replaces.bots.filter((bot) => typeof bot === 'string' && bot.length > 0) : []
  if (!identifier || bots.length === 0) return null
  return { identifier, bots: [...bots] }
}

const publicRequest = (request) => {
  const replaces = publicReplaces(request.replaces)
  return {
    id: request.id,
    kind: request.kind,
    bot: request.bot,
    origin: request.origin,
    // Sign-up only: the login the bot registers, shown on the user's card (never a password).
    ...(request.identifier ? { identifier: request.identifier } : {}),
    // Login only: the page's federated sign-in (provider names and a boolean, see `sso.mjs`).
    ...(request.sso ? { sso: request.sso } : {}),
    // Save only, and only when this origin is already stored: current login and allowed bots.
    ...(replaces ? { replaces } : {}),
    busy: request.busy,
    createdAt: request.createdAt,
  }
}

/** Bot requests waiting for the user's answer. No secret in the snapshots. */
export class BrowserVaultRequests {
  constructor() {
    this.pending = new Map()
    this.listeners = new Set()
  }

  snapshot() {
    return [...this.pending.values()].map(publicRequest)
  }

  notify() {
    const snapshot = this.snapshot()
    for (const listener of this.listeners) listener(snapshot)
  }

  expire(request) {
    if (!this.pending.has(request.id)) return
    this.pending.delete(request.id)
    this.notify()
    request.reject(new BrowserVaultError('request_timeout', 408))
  }

  arm(request, delay) {
    request.timer = setTimeout(() => this.expire(request), delay)
    request.timer.unref()
  }

  subscribe(listener) {
    this.listeners.add(listener)
    listener(this.snapshot())
    return () => this.listeners.delete(listener)
  }

  create({ kind, bot, origin, targetId, identifier, sso, replaces }, timeoutMs) {
    const pending = [...this.pending.values()]
    if (pending.length >= MAX_PENDING || pending.filter((item) => item.bot === bot).length >= MAX_PENDING_PER_BOT) {
      throw new BrowserVaultError('too_many_requests', 429)
    }
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const request = {
        id, kind, bot, origin, targetId, identifier, sso, replaces, busy: false, createdAt: new Date().toISOString(),
        deadline: Date.now() + timeoutMs, resolve, reject, timer: null,
      }
      this.pending.set(id, request)
      this.arm(request, timeoutMs)
      this.notify()
    })
  }

  get(id) {
    const request = this.pending.get(id)
    if (!request) throw new BrowserVaultError('request_not_found', 404)
    return request
  }

  setBusy(id, busy) {
    const request = this.get(id)
    request.busy = busy
    clearTimeout(request.timer)
    // An injection that was already approved must not expire during the CDP calls.
    // Once it is idle again, leave at least 30 s even if the original deadline has passed.
    if (!busy) {
      const delay = Math.max(MIN_IDLE_MS, request.deadline - Date.now())
      request.deadline = Date.now() + delay
      this.arm(request, delay)
    }
    this.notify()
  }

  complete(id, result) {
    const request = this.get(id)
    clearTimeout(request.timer)
    this.pending.delete(id)
    this.notify()
    request.resolve(result)
  }

  /** Ends the request with an error for the bot: it can fix its page and ask again. */
  fail(id, error) {
    const request = this.get(id)
    clearTimeout(request.timer)
    this.pending.delete(id)
    this.notify()
    request.reject(error)
  }

  cancel(id, status = 'cancelled') {
    const request = this.get(id)
    if (request.busy) throw new BrowserVaultError('request_busy', 409)
    this.complete(id, { status, origin: request.origin })
  }

  close() {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(new BrowserVaultError('vault_closed', 503))
    }
    this.pending.clear()
    this.listeners.clear()
  }
}
