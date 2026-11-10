import { WebSocket } from 'ws'
import { BrowserVaultError } from './errors.mjs'
import { normalizeOrigin } from './store.mjs'

const loopback = (hostname) => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname)

class CdpConnection {
  constructor(url) {
    this.url = url
    this.socket = null
    this.sequence = 0
    this.pending = new Map()
  }

  async open() {
    const url = new URL(this.url)
    if (url.protocol !== 'ws:' || !loopback(url.hostname)) throw new BrowserVaultError('cdp_unavailable', 503)
    this.socket = new WebSocket(this.url)
    this.socket.on('message', (raw) => {
      let frame
      try { frame = JSON.parse(String(raw)) } catch { return }
      const pending = this.pending.get(frame.id)
      if (!pending) return
      this.pending.delete(frame.id)
      clearTimeout(pending.timer)
      if (frame.error) pending.reject(new BrowserVaultError('cdp_command_failed', 502))
      else pending.resolve(frame.result || {})
    })
    this.socket.on('error', () => this.rejectPending())
    this.socket.on('close', () => this.rejectPending())
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket.terminate()
        reject(new BrowserVaultError('cdp_unavailable', 503))
      }, 3000)
      timer.unref()
      this.socket.once('open', () => { clearTimeout(timer); resolve() })
      this.socket.once('error', () => { clearTimeout(timer); reject(new BrowserVaultError('cdp_unavailable', 503)) })
    })
  }

  rejectPending() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new BrowserVaultError('cdp_unavailable', 503))
    }
    this.pending.clear()
  }

  call(method, params = {}) {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new BrowserVaultError('cdp_unavailable', 503)
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new BrowserVaultError('cdp_timeout', 504))
      }, 5000)
      timer.unref()
      this.pending.set(id, { resolve, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    this.rejectPending()
    if (this.socket?.readyState <= WebSocket.OPEN) this.socket.close()
  }
}

// Repère les éléments sans lire leur valeur. Le tableau retourné reste un objet CDP distant.
const LOGIN_FIELDS = `(() => {
  const visible = (element) => element instanceof HTMLInputElement && !element.disabled && !element.readOnly && element.getClientRects().length > 0
  const inputs = [...document.querySelectorAll('input')].filter(visible)
  const password = inputs.find((element) => element.type === 'password') || null
  const code = /otp|2fa|totp|verification|one.time.code/i
  const textual = inputs.filter((element) => element !== password && ['text', 'email', 'tel', ''].includes(element.type) && !code.test(element.name + ' ' + element.id + ' ' + element.autocomplete))
  const named = textual.find((element) => element.autocomplete === 'username' || /user|email|login|account/i.test(element.name + ' ' + element.id))
  return [named || textual[0] || null, password]
})()`

const CODE_FIELD = `(() => {
  const visible = (element) => element instanceof HTMLInputElement && !element.disabled && !element.readOnly && element.getClientRects().length > 0
  const inputs = [...document.querySelectorAll('input')].filter(visible)
  const field = inputs.find((element) => element.autocomplete === 'one-time-code')
    || inputs.find((element) => /otp|2fa|totp|verification|code/i.test(element.name + ' ' + element.id))
    || inputs.find((element) => element.type !== 'password' && ['text', 'tel', 'number'].includes(element.type) && element.inputMode === 'numeric')
  return [field || null]
})()`

const SET_VALUE = `(element, value) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
}`

const FILL_LOGIN = `function(identifier, password) {
  const setValue = ${SET_VALUE}
  const filled = []
  if (this[0]) { setValue(this[0], identifier); filled.push('identifier') }
  if (this[1]) { setValue(this[1], password); filled.push('password') }
  return { filled }
}`

const FILL_CODE = `function(code) {
  const setValue = ${SET_VALUE}
  if (!this[0]) return { filled: [] }
  setValue(this[0], code)
  return { filled: ['code'] }
}`

export class BrowserVaultCdp {
  constructor(origin = 'http://127.0.0.1:9222') {
    this.origin = new URL(origin)
    if (this.origin.protocol !== 'http:' || !loopback(this.origin.hostname)) {
      throw new BrowserVaultError('cdp_unavailable', 503)
    }
  }

  async target(targetId) {
    let targets
    try {
      const response = await fetch(new URL('/json/list', this.origin), {
        signal: AbortSignal.timeout(3000),
        redirect: 'manual',
        headers: { Accept: 'application/json' },
      })
      if (!response.ok) throw new Error('unavailable')
      targets = await response.json()
    } catch {
      throw new BrowserVaultError('cdp_unavailable', 503)
    }
    const target = Array.isArray(targets) && targets.find((item) => item?.type === 'page' && item.id === targetId && item.webSocketDebuggerUrl)
    if (!target) throw new BrowserVaultError('target_not_found', 404)
    return target
  }

  async withConnection(targetId, callback) {
    const target = await this.target(targetId)
    const connection = new CdpConnection(target.webSocketDebuggerUrl)
    await connection.open()
    try {
      return await callback(connection)
    } finally {
      connection.close()
    }
  }

  async readOrigin(connection) {
    const result = await connection.call('Runtime.evaluate', {
      expression: 'window.location.origin', returnByValue: true, awaitPromise: false,
    })
    if (result.exceptionDetails) throw new BrowserVaultError('origin_unavailable', 409)
    return normalizeOrigin(result.result?.value)
  }

  activeOrigin(targetId) {
    return this.withConnection(targetId, (connection) => this.readOrigin(connection))
  }

  async fill(connection, expectedOrigin, kind, values) {
    // L’onglet peut avoir changé entre l’appel du bot et la réponse de l’utilisateur.
    const origin = await this.readOrigin(connection)
    if (origin !== expectedOrigin) throw new BrowserVaultError('origin_mismatch', 403)

    const fields = await connection.call('Runtime.evaluate', {
      expression: kind === 'login' ? LOGIN_FIELDS : CODE_FIELD,
      returnByValue: false,
      awaitPromise: false,
    })
    if (fields.exceptionDetails || !fields.result?.objectId) throw new BrowserVaultError('fields_unavailable', 422)

    // Deuxième contrôle, après la recherche des champs et juste avant l’injection.
    if (await this.readOrigin(connection) !== expectedOrigin) throw new BrowserVaultError('origin_mismatch', 403)
    const result = await connection.call('Runtime.callFunctionOn', {
      objectId: fields.result.objectId,
      functionDeclaration: kind === 'login' ? FILL_LOGIN : FILL_CODE,
      arguments: values.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: false,
    })
    if (result.exceptionDetails) throw new BrowserVaultError('fill_failed', 422)
    const filled = result.result?.value?.filled
    if (!Array.isArray(filled) || filled.length === 0) {
      throw new BrowserVaultError(kind === 'login' ? 'login_fields_not_found' : 'code_field_not_found', 422)
    }
    return filled.filter((field) => ['identifier', 'password', 'code'].includes(field))
  }

  fillCredentials(entry, targetId) {
    const origin = normalizeOrigin(entry.origin)
    return this.withConnection(targetId, (connection) => this.fill(connection, origin, 'login', [entry.identifier, entry.password]))
  }

  fillCode(originValue, targetId, code) {
    const origin = normalizeOrigin(originValue)
    if (typeof code !== 'string' || !code.trim() || code.length > 128) throw new BrowserVaultError('invalid_code', 400)
    return this.withConnection(targetId, (connection) => this.fill(connection, origin, 'code', [code.trim()]))
  }
}
