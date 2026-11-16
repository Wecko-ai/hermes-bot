import { WebSocket } from 'ws'
import { BrowserVaultError } from './errors.mjs'
import { normalizeOrigin } from './store.mjs'
import { federatedSignIn } from './sso.mjs'

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

  call(method, params = {}, timeoutMs = 5000) {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new BrowserVaultError('cdp_unavailable', 503)
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new BrowserVaultError('cdp_timeout', 504))
      }, timeoutMs)
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

// Shared by the field lookups: every input of the page, open shadow roots included (some sign-in
// forms live in web components), and the text that names a field (name, id, autocomplete, aria-label,
// placeholder, its <label> or aria-labelledby).
const PAGE_HELPERS = `const pageInputs = () => {
    const found = []
    const walk = (root) => {
      for (const element of root.querySelectorAll('*')) {
        if (element instanceof HTMLInputElement) found.push(element)
        if (element.shadowRoot) walk(element.shadowRoot)
      }
    }
    walk(document)
    return found
  }
  const visible = (element) => !element.disabled && !element.readOnly && element.type !== 'hidden' && element.getClientRects().length > 0
  const labelText = (element) => {
    const root = element.getRootNode()
    const named = (element.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean)
      .map((id) => (root.getElementById ? root.getElementById(id) : null)?.textContent || '')
    return [...(element.labels || [])].map((label) => label.textContent || '').concat(named).join(' ')
  }
  const describe = (element) => [element.name, element.id, element.autocomplete, element.getAttribute('aria-label'), element.placeholder, labelText(element)].join(' ')`

// Locates the elements without reading their value. The returned array stays a remote CDP object.
export const LOGIN_FIELDS = `(() => {
  ${PAGE_HELPERS}
  const inputs = pageInputs().filter(visible)
  const password = inputs.find((element) => element.type === 'password') || null
  const code = /otp|2fa|totp|verification|one.time.code/i
  const textual = inputs.filter((element) => element !== password && ['text', 'email', 'tel', ''].includes(element.type) && !code.test(element.name + ' ' + element.id + ' ' + element.autocomplete))
  const named = textual.find((element) => element.autocomplete === 'username' || /user|email|login|account/i.test(element.name + ' ' + element.id))
  return [named || textual[0] || null, password]
})()`

// Sign-up: the login field only when it is clearly one (the first text field is often a first name),
// then every visible password field (the password and its confirmation).
export const SIGNUP_FIELDS = `(() => {
  ${PAGE_HELPERS}
  const inputs = pageInputs().filter(visible)
  const passwords = inputs.filter((element) => element.type === 'password')
  const code = /otp|2fa|totp|verification|one.time.code/i
  const identifier = inputs.find((element) => ['text', 'email', 'tel'].includes(element.type)
    && !code.test(describe(element))
    && (/\\b(username|email)\\b/.test(element.autocomplete) || element.type === 'email' || /user|email|login|account/i.test(element.name + ' ' + element.id))) || null
  return [identifier, ...passwords]
})()`

export const CODE_FIELD = `(() => {
  ${PAGE_HELPERS}
  const inputs = pageInputs().filter(visible)
  const code = /code|otp|2fa|totp|verification|\\bpin\\b/i
  // A postal, promo or country code is not a one-time code.
  const other = /postal|zip|promo|coupon|voucher|gift|discount|country|area.?code|dial/i
  const typed = inputs.filter((element) => ['text', 'tel', 'number', 'password'].includes(element.type) && !other.test(describe(element)))
  const field = inputs.find((element) => element.autocomplete === 'one-time-code')
    || typed.find((element) => code.test(describe(element)))
    || typed.find((element) => element.type !== 'password' && element.inputMode === 'numeric')
  if (field) return [field]
  // Last resort: the only short text, phone or number field of the page.
  const short = typed.filter((element) => element.type !== 'password' && element.maxLength >= 4 && element.maxLength <= 10)
  return [short.length === 1 ? short[0] : null]
})()`

// Focus first: some sites ignore a value set on a field that never had the focus.
const SET_VALUE = `(element, value) => {
  element.focus()
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
  element.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
}`

export const FILL_LOGIN = `function(identifier, password) {
  const setValue = ${SET_VALUE}
  const filled = []
  if (this[0]) { setValue(this[0], identifier); filled.push('identifier') }
  if (this[1]) { setValue(this[1], password); filled.push('password') }
  return { filled }
}`

export const FILL_SIGNUP = `function(identifier, password) {
  const setValue = ${SET_VALUE}
  const filled = []
  if (this[0]) { setValue(this[0], identifier); filled.push('identifier') }
  for (let index = 1; index < this.length; index += 1) {
    setValue(this[index], password)
    filled.push(index === 1 ? 'password' : 'confirmation')
  }
  return { filled }
}`

export const FILL_CODE = `function(code) {
  const setValue = ${SET_VALUE}
  if (!this[0]) return { filled: [] }
  setValue(this[0], code)
  return { filled: ['code'] }
}`

// Sign-up, before anything is stored: how many fields the lookup found. Takes no value.
export const COUNT_SIGNUP_FIELDS = `function() {
  return { identifier: Boolean(this[0]), passwords: Math.max(0, this.length - 1) }
}`

// Federated sign-in buttons of the page ("Continue with Google", Apple, Microsoft): their text or label,
// the providers' scripts, iframes and links, in open shadow roots and same-origin iframes. Also says
// whether a visible password field is there. Reads no value; returns plain data.
export const FEDERATED_SIGNIN = String.raw`(() => {
  /* federated sign-in */
  const providers = []
  let hasPasswordField = false
  const add = (provider) => { if (provider && !providers.includes(provider)) providers.push(provider) }
  const byText = (text) => {
    const match = /(?:continue|sign\s*in|sign\s*up|log\s*in|login|connect|continuer|connecter|connexion|inscrire|inscription|identifier)\s*(?:with|using|via|through|avec|par)(?:\s+(?:a|an|your|my|votre|ton|mon|un|une|le|compte|account))*\s*(google|apple|microsoft)\b/i.exec(String(text || '').replace(/\s+/g, ' '))
    return match ? match[1].toLowerCase() : null
  }
  const bySource = (value) => {
    const url = String(value || '')
    if (/^https:\/\/accounts\.google\.com\/(?:gsi\/|o\/oauth2|signin\/oauth|v3\/signin)/i.test(url)) return 'google'
    if (/^https:\/\/(?:appleid\.apple\.com\/auth\/|appleid\.cdn-apple\.com\/appleauth\/)/i.test(url)) return 'apple'
    if (/^https:\/\/login\.(?:microsoftonline\.com|live\.com|microsoft\.com)\//i.test(url)) return 'microsoft'
    return null
  }
  const attribute = (element, name) => (typeof element.getAttribute === 'function' ? element.getAttribute(name) : null) || ''
  const seen = new Set()
  const walk = (root, depth) => {
    if (!root || typeof root.querySelectorAll !== 'function' || seen.has(root) || depth > 3) return
    seen.add(root)
    for (const element of root.querySelectorAll('*')) {
      const tag = String(element.tagName || '').toUpperCase()
      if (tag === 'INPUT' && element.type === 'password' && !element.disabled
        && typeof element.getClientRects === 'function' && element.getClientRects().length > 0) hasPasswordField = true
      if (tag === 'IFRAME' || tag === 'SCRIPT') add(bySource(element.src))
      if (tag === 'A') add(bySource(element.href))
      if (tag === 'FORM') add(bySource(element.action))
      if (tag === 'BUTTON' || tag === 'A' || attribute(element, 'role') === 'button') add(byText(element.textContent))
      if (tag === 'INPUT' && (element.type === 'button' || element.type === 'submit')) add(byText(element.value))
      for (const name of ['aria-label', 'title', 'alt']) add(byText(attribute(element, name)))
      if (element.shadowRoot) walk(element.shadowRoot, depth)
      if (tag === 'IFRAME') {
        // A cross-origin frame gives null (or throws): only same-origin frames are read.
        let inner = null
        try { inner = element.contentDocument } catch { inner = null }
        walk(inner, depth + 1)
      }
    }
  }
  walk(document, 0)
  return { providers, hasPasswordField }
})()`

const FIELDS = { login: LOGIN_FIELDS, signup: SIGNUP_FIELDS, code: CODE_FIELD }
const FILLERS = { login: FILL_LOGIN, signup: FILL_SIGNUP, code: FILL_CODE }
const NOT_FOUND = { login: 'login_fields_not_found', signup: 'login_fields_not_found', code: 'code_field_not_found' }
const FIELD_NAMES = ['identifier', 'password', 'confirmation', 'code']

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

  /** The page's federated sign-in buttons, or null. Never fails: it only adds a hint to the card. */
  async pageFederatedSignIn(connection) {
    try {
      const result = await connection.call('Runtime.evaluate', {
        expression: FEDERATED_SIGNIN, returnByValue: true, awaitPromise: false,
      }, 2000)
      if (result.exceptionDetails) return null
      const value = result.result?.value
      return value && typeof value === 'object' ? value : null
    } catch {
      return null
    }
  }

  /** `save`: the tab's origin and, as a hint for the card only, its federated sign-in (`sso.mjs`). */
  inspectLogin(targetId) {
    return this.withConnection(targetId, async (connection) => {
      const origin = await this.readOrigin(connection)
      return { origin, sso: federatedSignIn(origin, await this.pageFederatedSignIn(connection)) }
    })
  }

  /**
   * `beforeInject` (sign-up): called once the password fields are found and before the injection;
   * a page without any password field fails first, so nothing is stored for it.
   */
  async fill(connection, expectedOrigin, kind, values, beforeInject) {
    // The tab may have changed between the bot's call and the user's answer.
    const origin = await this.readOrigin(connection)
    if (origin !== expectedOrigin) throw new BrowserVaultError('origin_mismatch', 403)

    const fields = await connection.call('Runtime.evaluate', {
      expression: FIELDS[kind],
      returnByValue: false,
      awaitPromise: false,
    })
    if (fields.exceptionDetails || !fields.result?.objectId) throw new BrowserVaultError('fields_unavailable', 422)

    if (beforeInject) {
      const counted = await connection.call('Runtime.callFunctionOn', {
        objectId: fields.result.objectId,
        functionDeclaration: COUNT_SIGNUP_FIELDS,
        returnByValue: true,
        awaitPromise: false,
      })
      if (counted.exceptionDetails) throw new BrowserVaultError('fields_unavailable', 422)
      if (!(Number(counted.result?.value?.passwords) > 0)) throw new BrowserVaultError(NOT_FOUND[kind], 422)
      await beforeInject()
    }

    // Second check, after the field lookup and right before the injection.
    if (await this.readOrigin(connection) !== expectedOrigin) throw new BrowserVaultError('origin_mismatch', 403)
    const result = await connection.call('Runtime.callFunctionOn', {
      objectId: fields.result.objectId,
      functionDeclaration: FILLERS[kind],
      arguments: values.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: false,
    })
    if (result.exceptionDetails) throw new BrowserVaultError('fill_failed', 422)
    const filled = result.result?.value?.filled
    if (!Array.isArray(filled) || filled.length === 0) throw new BrowserVaultError(NOT_FOUND[kind], 422)
    return filled.filter((field) => FIELD_NAMES.includes(field))
  }

  fillCredentials(entry, targetId) {
    const origin = normalizeOrigin(entry.origin)
    return this.withConnection(targetId, (connection) => this.fill(connection, origin, 'login', [entry.identifier, entry.password]))
  }

  /** Sign-up: `store` runs between the field lookup and the injection (store first, fill second). */
  fillSignup(originValue, targetId, identifier, password, store) {
    const origin = normalizeOrigin(originValue)
    return this.withConnection(targetId, (connection) => this.fill(connection, origin, 'signup', [identifier, password], store))
  }

  fillCode(originValue, targetId, code) {
    const origin = normalizeOrigin(originValue)
    if (typeof code !== 'string' || !code.trim() || code.length > 128) throw new BrowserVaultError('invalid_code', 400)
    return this.withConnection(targetId, (connection) => this.fill(connection, origin, 'code', [code.trim()]))
  }
}
