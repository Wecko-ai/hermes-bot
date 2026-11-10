import { randomUUID } from 'node:crypto'
import { BrowserVaultError } from './errors.mjs'

const publicRequest = (request) => ({
  id: request.id,
  kind: request.kind,
  bot: request.bot,
  origin: request.origin,
  busy: request.busy,
  createdAt: request.createdAt,
})

/** Demandes des bots en attente d’une réponse de l’utilisateur. Aucun secret dans les snapshots. */
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

  create({ kind, bot, origin, targetId }, timeoutMs) {
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const request = {
        id, kind, bot, origin, targetId, busy: false, createdAt: new Date().toISOString(),
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
    // Une injection déjà validée ne doit pas expirer pendant les appels CDP.
    if (!busy) this.arm(request, Math.max(0, request.deadline - Date.now()))
    this.notify()
  }

  complete(id, result) {
    const request = this.get(id)
    clearTimeout(request.timer)
    this.pending.delete(id)
    this.notify()
    request.resolve(result)
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
