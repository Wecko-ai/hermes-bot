import http from 'node:http'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { normalizeOrigin } from './store.mjs'
import { attributeValue, botAllowed, KeychainStore, parseDump, passwordValue, runSecurity, validBots } from './keychain.mjs'
import { WebSocketServer } from 'ws'
import { BrowserVaultRequests } from './requests.mjs'
import { appendAudit, AUDIT_MAX_BYTES } from './audit.mjs'
import { createBrowserVault, loopbackOrigin } from './service.mjs'
import { generatePassword, PASSWORD_ALPHABET, PASSWORD_CLASSES } from './password.mjs'
import { BrowserVaultCdp, CODE_FIELD, FEDERATED_SIGNIN, FILL_CODE, FILL_LOGIN, FILL_SIGNUP, LOGIN_FIELDS, SIGNUP_FIELDS, TYPE_DOCUMENT } from './cdp.mjs'
import { accountPageProvider, federatedSignIn, useSsoResult } from './sso.mjs'
import { fileSettings, memorySettings, parseSettings } from './settings.mjs'

const darwin = process.platform === 'darwin' && existsSync('/usr/bin/security')

/** In-memory `security`: passwords stay on the fake stdin, never in the recorded argv. */
function memorySecurity() {
  const items = []
  const calls = []
  let failAdd = false
  let hold = null
  let releaseHold = null
  const security = {
    calls,
    onEntered: null,
    failNextAdd() { failAdd = true },
    armHold() { hold = new Promise((resolve) => { releaseHold = resolve }) },
    release() { releaseHold?.() },
    run,
  }

  function tokenize(line) {
    const tokens = []
    let current = ''
    let quoted = false
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index]
      if (quoted) {
        if (char === '\\') { current += line[index + 1] ?? ''; index += 1; continue }
        if (char === '"') { quoted = false; continue }
        current += char
        continue
      }
      if (char === '"') { quoted = true; continue }
      if (char === ' ' || char === '\n') {
        if (current) tokens.push(current)
        current = ''
        continue
      }
      current += char
    }
    if (current) tokens.push(current)
    return tokens
  }

  function flagsOf(tokens) {
    const flags = {}
    const valued = new Set(['-a', '-s', '-r', '-P', '-p', '-l', '-c', '-j', '-w', '-T'])
    for (let index = 1; index < tokens.length; index += 1) {
      const token = tokens[index]
      if (token === '-U' || token === '-g') { flags[token] = true; continue }
      if (valued.has(token)) { flags[token] = tokens[index + 1]; index += 1 }
    }
    return flags
  }

  function matches(item, flags, account) {
    if (item.server !== flags['-s'] || item.protocol !== flags['-r']) return false
    if (item.port !== Number(flags['-P'] || 0)) return false
    if (flags['-c'] && item.creator !== flags['-c']) return false
    if (account && item.account !== account) return false
    return true
  }

  function dumpItem(item) {
    return [
      'keychain: "/x"',
      'class: "inet"',
      'attributes:',
      `    "acct"<blob>="${item.account}"`,
      `    "srvr"<blob>="${item.server}"`,
      `    "ptcl"<uint32>="${item.protocol}"`,
      `    "port"<uint32>=0x${item.port.toString(16)}`,
      `    "crtr"<uint32>="${item.creator}"`,
      `    "icmt"<blob>="${item.comment}"`,
    ].join('\n')
  }

  function dispatch(tokens) {
    const command = tokens[0]
    const flags = flagsOf(tokens)
    if (command === 'dump-keychain') return { code: 0, stdout: items.map(dumpItem).join('\n'), stderr: '' }
    if (command === 'find-internet-password') {
      const item = items.find((entry) => matches(entry, flags, flags['-a']))
      if (!item) return { code: 44, stdout: '', stderr: '' }
      return { code: 0, stdout: '', stderr: `password: "${item.password}"\n` }
    }
    if (command === 'delete-internet-password') {
      const index = items.findIndex((entry) => matches(entry, flags, flags['-a']))
      if (index < 0) return { code: 44, stdout: '', stderr: '' }
      items.splice(index, 1)
      return { code: 0, stdout: '', stderr: '' }
    }
    if (command === 'add-internet-password') {
      if (failAdd) { failAdd = false; return { code: 1, stdout: '', stderr: 'denied' } }
      const index = items.findIndex((entry) => matches(entry, flags, flags['-a']))
      // Like macOS: an existing internet password is never replaced, `-U` or not.
      if (index >= 0) return { code: 1, stdout: '', stderr: 'exists' }
      const next = {
        server: flags['-s'], protocol: flags['-r'], port: Number(flags['-P'] || 0),
        account: flags['-a'], password: flags['-w'], comment: flags['-j'] || '', creator: flags['-c'] || '',
      }
      if (index >= 0) items[index] = next
      else items.push(next)
      return { code: 0, stdout: '', stderr: '' }
    }
    return { code: 1, stdout: '', stderr: 'unknown' }
  }

  async function run(args, input = '') {
    calls.push({ args: [...args], input: input || '' })
    if (args[0] === '-i' && hold) {
      const gate = hold
      hold = null
      security.onEntered?.()
      await gate
    }
    return dispatch(args[0] === '-i' ? tokenize(String(input).trim()) : args)
  }

  return security
}

describe('coffre navigateur — trousseau', () => {
  it('normalise protocole, hôte et port', () => {
    expect(normalizeOrigin('https://Example.COM:443/login?next=x')).toBe('https://example.com')
    expect(normalizeOrigin('http://example.com:8080/login')).toBe('http://example.com:8080')
    expect(() => normalizeOrigin('file:///tmp/login')).toThrow('invalid_origin')
    expect(() => normalizeOrigin('https://user:pass@example.com')).toThrow('invalid_origin')
  })

  it('lit les sorties de security : texte brut, hexadécimal, entiers', () => {
    expect(attributeValue('<NULL>')).toBeNull()
    expect(attributeValue('"{"bots":["orion"]}"')).toBe('{"bots":["orion"]}')
    expect(attributeValue('0xC3A96C697365  "\\303\\251lise"')).toBe('élise')
    expect(passwordValue('password: "deadbeef"\n')).toBe('deadbeef')
    expect(passwordValue('password: 0xC3A9225C  "\\303\\251\\"\\134"')).toBe('é"\\')
    expect(passwordValue('password:\n')).toBe('')
    expect(passwordValue('autre chose')).toBeNull()
    const items = parseDump([
      'keychain: "/x.keychain-db"', 'class: "inet"', 'attributes:',
      '    "acct"<blob>="orion@exemple.com"', '    "crtr"<uint32>="HBot"', '    "port"<uint32>=0x00001F90 ',
      '    "ptcl"<uint32>="http"', '    "srvr"<blob>="app.exemple.org"',
      'keychain: "/x.keychain-db"', 'class: "genp"', 'attributes:', '    "acct"<blob>="x"',
    ].join('\n'))
    expect(items).toHaveLength(1)
    expect(items[0].attributes).toMatchObject({ acct: 'orion@exemple.com', crtr: 'HBot', port: 8080, ptcl: 'http' })
  })

  it('refuse des bots invalides et les fins de ligne, avant tout appel à security', async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }))
    const store = new KeychainStore({ keychain: '/x.keychain-db', run })
    expect(() => validBots([])).toThrow('invalid_bots')
    expect(() => validBots(['../x'])).toThrow('invalid_bots')
    expect(validBots(['vega', 'orion', '*'])).toEqual(['*'])
    expect(botAllowed({ bots: ['orion'] }, 'vega')).toBe(false)
    await expect(store.save('https://exemple.com', 'a\nb', 'secret', ['orion'])).rejects.toThrow('invalid_credentials')
    await expect(store.save('https://exemple.com', 'a', 'se\ncret', ['orion'])).rejects.toThrow('invalid_credentials')
    await expect(store.save('https://exemple.com', 'moi\u202eelpmexe', 'secret', ['orion'])).rejects.toThrow('invalid_credentials')
    expect(run).not.toHaveBeenCalled()
  })

  it.skipIf(!darwin)('range, liste, relit et retire dans un vrai trousseau, mot de passe jamais en argument', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'hermesbot-keychain-'))
    const keychain = path.join(directory, 'test.keychain-db')
    const calls = []
    const run = (args, input) => { calls.push({ args, input: input || '' }); return runSecurity(args, input) }
    try {
      for (const args of [['create-keychain', '-p', 'test', keychain], ['unlock-keychain', '-p', 'test', keychain], ['set-keychain-settings', keychain]]) {
        expect((await runSecurity(args)).code).toBe(0)
      }
      const store = new KeychainStore({ keychain, run })
      const secret = String.raw`a b"c\d$e'f é ;x`
      await store.save('https://www.exemple.com/login', 'élise@exemple.com', secret, ['orion'])
      await store.save('http://app.exemple.org:8080', 'u2', 'deadbeef', ['*'])
      expect((await store.list('orion')).map((entry) => entry.origin)).toEqual(['http://app.exemple.org:8080', 'https://www.exemple.com'])
      expect((await store.list('vega')).map((entry) => entry.origin)).toEqual(['http://app.exemple.org:8080'])
      expect(JSON.stringify(await store.list())).not.toContain('deadbeef')
      expect((await store.get('https://www.exemple.com')).password).toBe(secret)
      await store.save('https://www.exemple.com', 'autre@exemple.com', undefined, ['orion', 'vega'])
      expect(await store.get('https://www.exemple.com')).toMatchObject({ identifier: 'autre@exemple.com', password: secret, bots: ['orion', 'vega'] })
      expect(await store.list()).toHaveLength(2)
      await store.remove('http://app.exemple.org:8080')
      await expect(store.get('http://app.exemple.org:8080')).rejects.toThrow('origin_not_found')
      await store.save('https://www.exemple.com', 'autre@exemple.com', 'nouveau-secret', ['orion', 'vega'])
      expect((await store.get('https://www.exemple.com')).password).toBe('nouveau-secret')
      expect(calls.some((call) => String(call.input).includes(' -U '))).toBe(false)
      expect(calls.every((call) => call.args.every((value) => !String(value).includes('nouveau-secret') && !String(value).includes(secret) && !String(value).includes('deadbeef')))).toBe(true)
    } finally {
      await runSecurity(['delete-keychain', keychain])
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('écrit le nouveau secret avant de retirer l’ancien, et sérialise save et remove', async () => {
    const security = memorySecurity()
    const store = new KeychainStore({ keychain: '/tmp/test.keychain-db', run: security.run })
    await store.save('https://exemple.com', 'ada', 'old-secret', ['orion'])
    await store.save('https://exemple.com', 'ada', 'new-secret', ['orion'])
    expect(security.calls.some((call) => String(call.input).includes(' -U '))).toBe(false)
    expect((await store.get('https://exemple.com')).password).toBe('new-secret')
    // Same account, the add fails: the previous secret is written back.
    security.failNextAdd()
    await expect(store.save('https://exemple.com', 'ada', 'lost-secret', ['orion'])).rejects.toThrow('vault_write_failed')
    expect((await store.get('https://exemple.com')).password).toBe('new-secret')

    const start = security.calls.length
    await store.save('https://exemple.com', 'beau', 'other-secret', ['orion'])
    const slice = security.calls.slice(start)
    const addAt = slice.findIndex((call) => String(call.input).startsWith('add-internet-password'))
    const deleteAt = slice.findIndex((call) => call.args[0] === 'delete-internet-password')
    expect(addAt).toBeGreaterThanOrEqual(0)
    expect(deleteAt).toBeGreaterThan(addAt)
    expect(slice[addAt].input.includes(' -U ')).toBe(false)
    expect(slice[deleteAt].args).toContain('-a')
    expect(slice[deleteAt].args).toContain('ada')
    expect((await store.get('https://exemple.com')).identifier).toBe('beau')

    security.failNextAdd()
    await expect(store.save('https://exemple.com', 'beau', 'nope', ['orion'])).rejects.toThrow('vault_write_failed')
    // The failed replacement put the previous item back: same login, same secret, one item.
    expect((await store.get('https://exemple.com')).password).toBe('other-secret')
    expect(await store.list()).toHaveLength(1)

    await store.save('https://exemple.com', 'beau', 'other-secret', ['orion'], { unconfirmed: true })
    expect((await store.find('https://exemple.com')).unconfirmed).toBe(true)
    await store.save('https://exemple.com', 'beau', 'other-secret', ['orion'])
    expect((await store.find('https://exemple.com')).unconfirmed).toBe(false)

    security.armHold()
    const entered = new Promise((resolve) => { security.onEntered = resolve })
    const first = store.save('https://autre.exemple.org', 'ada', 'one', ['orion'])
    await entered
    const before = security.calls.length
    const second = store.save('https://autre.exemple.org', 'ada', 'two', ['orion'])
    const removed = store.remove('https://autre.exemple.org')
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(security.calls).toHaveLength(before)
    security.release()
    await first
    await second
    await removed
    expect(await store.find('https://autre.exemple.org')).toBeNull()
    expect(security.calls.every((call) => call.args.every((value) => !['old-secret', 'new-secret', 'other-secret', 'nope', 'one', 'two'].includes(String(value))))).toBe(true)
  })
})

describe('coffre navigateur — demandes', () => {
  it('publie seulement les métadonnées et résout une annulation', async () => {
    const requests = new BrowserVaultRequests()
    let snapshot = []
    requests.subscribe((value) => { snapshot = value })
    const waiting = requests.create({ kind: 'save', bot: 'orion', origin: 'https://example.com' }, 1000)
    expect(snapshot[0]).toMatchObject({ kind: 'save', bot: 'orion', origin: 'https://example.com', busy: false })
    expect(JSON.stringify(snapshot)).not.toContain('password')
    requests.cancel(snapshot[0].id)
    await expect(waiting).resolves.toMatchObject({ status: 'cancelled' })
    expect(snapshot).toEqual([])
    requests.close()
  })

  it('gèle le timeout pendant une injection déjà validée', async () => {
    vi.useFakeTimers()
    try {
      const requests = new BrowserVaultRequests()
      let snapshot = []
      requests.subscribe((value) => { snapshot = value })
      const waiting = requests.create({ kind: 'code', bot: 'orion', origin: 'https://example.com', targetId: 'onglet' }, 1000)
      requests.setBusy(snapshot[0].id, true)
      await vi.advanceTimersByTimeAsync(5000)
      expect(snapshot).toHaveLength(1)
      requests.complete(snapshot[0].id, { status: 'filled', fields: ['code'] })
      await expect(waiting).resolves.toMatchObject({ status: 'filled' })
      requests.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('laisse au moins 30 s après une injection, même si l’échéance est passée', async () => {
    vi.useFakeTimers()
    try {
      const requests = new BrowserVaultRequests()
      const waiting = requests.create({ kind: 'save', bot: 'orion', origin: 'https://example.com' }, 1000)
      const request = requests.snapshot()[0]
      requests.setBusy(request.id, true)
      await vi.advanceTimersByTimeAsync(5000)
      requests.setBusy(request.id, false)
      await vi.advanceTimersByTimeAsync(29_000)
      expect(requests.snapshot()).toHaveLength(1)
      const expired = expect(waiting).rejects.toThrow('request_timeout')
      await vi.advanceTimersByTimeAsync(1000)
      await expired
      requests.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ne raccourcit pas une échéance encore lointaine', async () => {
    vi.useFakeTimers()
    try {
      const requests = new BrowserVaultRequests()
      const waiting = requests.create({ kind: 'save', bot: 'orion', origin: 'https://example.com' }, 120_000)
      const request = requests.snapshot()[0]
      requests.setBusy(request.id, true)
      requests.setBusy(request.id, false)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(requests.snapshot()).toHaveLength(1)
      requests.complete(request.id, { status: 'saved' })
      await expect(waiting).resolves.toMatchObject({ status: 'saved' })
      requests.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuse au-delà de 3 demandes par bot et de 20 au total', () => {
    const requests = new BrowserVaultRequests()
    const held = []
    const hold = (promise) => { held.push(promise); promise.catch(() => undefined) }
    for (let index = 0; index < 3; index += 1) hold(requests.create({ kind: 'save', bot: 'orion', origin: 'https://example.com' }, 60_000))
    expect(() => requests.create({ kind: 'save', bot: 'orion', origin: 'https://example.com' }, 60_000)).toThrow('too_many_requests')
    for (let index = 0; index < 17; index += 1) hold(requests.create({ kind: 'code', bot: `bot${index}`, origin: 'https://example.com' }, 60_000))
    expect(requests.snapshot()).toHaveLength(20)
    expect(() => requests.create({ kind: 'save', bot: 'vega', origin: 'https://example.com' }, 60_000)).toThrow('too_many_requests')
    requests.close()
    return Promise.allSettled(held)
  })
})

describe('coffre navigateur — un Chrome par équipe', () => {
  it('envoie chaque bot vers le CDP de son équipe', async () => {
    const hits = { a: 0, b: 0 }
    const fakeCdp = (key) => http.createServer((request, response) => {
      if (request.url === '/json/list') hits[key] += 1
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end('[]')
    })
    const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
    const cdpA = fakeCdp('a')
    const cdpB = fakeCdp('b')
    const portA = await listen(cdpA)
    const portB = await listen(cdpB)
    const probe = http.createServer()
    const vaultPort = await listen(probe)
    await new Promise((resolve) => probe.close(resolve))
    const store = { available: true, list: async () => [], find: async () => null }
    const vault = createBrowserVault({
      port: vaultPort,
      adminToken: 'x',
      verifyUser: async () => true,
      store,
      cdpOriginFor: (bot) => `http://127.0.0.1:${bot === 'orion' ? portA : portB}`,
    })
    await vault.listen()
    const call = (bot) => fetch(`http://127.0.0.1:${vaultPort}/v1/fill`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bot, target: 'onglet' }),
    }).then((response) => response.json())
    try {
      expect(await call('orion')).toEqual({ error: 'target_not_found' })
      expect(hits).toEqual({ a: 1, b: 0 })
      expect(await call('iris')).toEqual({ error: 'target_not_found' })
      expect(hits).toEqual({ a: 1, b: 1 })
    } finally {
      await vault.close()
      await new Promise((resolve) => cdpA.close(resolve))
      await new Promise((resolve) => cdpB.close(resolve))
    }
  })
})

describe('coffre navigateur — mot de passe généré', () => {
  it('fait 20 caractères, avec les quatre classes, dans l’alphabet sûr', () => {
    for (let round = 0; round < 300; round += 1) {
      const password = generatePassword()
      expect(password).toHaveLength(20)
      for (const chars of PASSWORD_CLASSES) expect([...password].some((char) => chars.includes(char))).toBe(true)
      expect([...password].every((char) => PASSWORD_ALPHABET.includes(char))).toBe(true)
      expect(password).not.toMatch(/["'`\\\s]/)
    }
  })

  it('change à chaque appel', () => {
    const drawn = new Set(Array.from({ length: 200 }, () => generatePassword()))
    expect(drawn.size).toBe(200)
    expect(() => generatePassword(3)).toThrow()
  })
})

// Just enough DOM to run the page expressions: inputs, open shadow roots, labels, focus and events.
class FakeInput {
  constructor(fields = {}) {
    const { attributes = {}, shown = true, ...rest } = fields
    Object.assign(this, { type: 'text', name: '', id: '', autocomplete: '', placeholder: '', inputMode: '', maxLength: -1, disabled: false, readOnly: false, labels: [], shadowRoot: null, root: null }, rest)
    this.attributes = attributes
    this.shown = shown
    this.events = []
    this.current = ''
  }
  getAttribute(name) { return this.attributes[name] ?? null }
  getClientRects() { return this.shown ? [{ width: 10, height: 10 }] : [] }
  getBoundingClientRect() {
    if (this.rect) return this.rect
    if (!this.shown) return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
    return { left: 10, top: 10, right: 110, bottom: 40, width: 100, height: 30 }
  }
  getRootNode() { return this.root }
  focus() { this.events.push('focus') }
  dispatchEvent(event) { this.events.push(event.type); return true }
  get value() { return this.current }
  set value(value) { this.current = value; this.events.push('value') }
}

function fakeRoot(elements, named = {}) {
  const root = { querySelectorAll: () => elements, getElementById: (id) => named[id] || null }
  for (const element of elements) if (element instanceof FakeInput) element.root = root
  return root
}

const VIEW = { innerWidth: 800, innerHeight: 600 }
const computedStyle = (element) => element.computed || { visibility: 'visible', display: 'block', opacity: '1' }
const lookup = (expression, document) => new Function('document', 'HTMLInputElement', 'getComputedStyle', 'window', `return ${expression}`)(document, FakeInput, computedStyle, VIEW)
const filler = (declaration) => new Function('HTMLInputElement', 'Event', `return (${declaration})`)(FakeInput, Event)
const typeDocument = (document, location, expectedOrigin, kind, primary, secret) => {
  const typed = new Function('document', 'location', 'HTMLInputElement', 'Event', 'getComputedStyle', 'window', `return (${TYPE_DOCUMENT})`)(document, location, FakeInput, Event, computedStyle, VIEW)
  return typed(expectedOrigin, kind, primary, secret)
}

describe('coffre navigateur — repérage des champs', () => {
  it('trouve le code par jeton, one-time-code ou libellé explicite', () => {
    const search = new FakeInput({ name: 'q' })
    const byAria = new FakeInput({ attributes: { 'aria-label': 'Authentication code' } })
    expect(lookup(CODE_FIELD, fakeRoot([search, byAria]))[0]).toBe(byAria)
    const byPlaceholder = new FakeInput({ placeholder: 'One-time code' })
    expect(lookup(CODE_FIELD, fakeRoot([search, byPlaceholder]))[0]).toBe(byPlaceholder)
    const byLabel = new FakeInput({ labels: [{ textContent: 'Verification code' }] })
    expect(lookup(CODE_FIELD, fakeRoot([search, byLabel]))[0]).toBe(byLabel)
    const bare = new FakeInput({ attributes: { 'aria-label': 'Enter code' } })
    expect(lookup(CODE_FIELD, fakeRoot([search, bare]))[0]).toBeNull()
    const verification = new FakeInput({ labels: [{ textContent: 'Verification' }] })
    expect(lookup(CODE_FIELD, fakeRoot([search, verification]))[0]).toBeNull()
    const byLabelledBy = new FakeInput({ attributes: { 'aria-labelledby': 'titre' } })
    expect(lookup(CODE_FIELD, fakeRoot([search, byLabelledBy], { titre: { textContent: 'Your PIN' } }))[0]).toBe(byLabelledBy)
    const otp = new FakeInput({ name: 'otp' })
    expect(lookup(CODE_FIELD, fakeRoot([search, otp]))[0]).toBe(otp)
  })

  it('ignore codes postaux, cartes et promos, et le champ court sans indice', () => {
    const postal = new FakeInput({ name: 'postal_code', maxLength: 5 })
    const postcode = new FakeInput({ name: 'postcode', maxLength: 8 })
    const promo = new FakeInput({ placeholder: 'Promo code' })
    const barcode = new FakeInput({ id: 'barcode' })
    const encode = new FakeInput({ placeholder: 'Encode' })
    const cvv = new FakeInput({ name: 'cvv', maxLength: 4, inputMode: 'numeric' })
    const card = new FakeInput({ name: 'card', autocomplete: 'one-time-code' })
    expect(lookup(CODE_FIELD, fakeRoot([postal, postcode, promo, barcode, encode, cvv, card]))[0]).toBeNull()
    const short = new FakeInput({ type: 'tel', maxLength: 6 })
    expect(lookup(CODE_FIELD, fakeRoot([new FakeInput({ name: 'q' }), short]))[0]).toBeNull()
    const numeric = new FakeInput({ type: 'tel', maxLength: 6, inputMode: 'numeric' })
    expect(lookup(CODE_FIELD, fakeRoot([new FakeInput({ name: 'q' }), numeric]))[0]).toBe(numeric)
    const explicit = new FakeInput({ type: 'text', maxLength: 6, autocomplete: 'one-time-code' })
    expect(lookup(CODE_FIELD, fakeRoot([new FakeInput({ name: 'q' }), explicit]))[0]).toBe(explicit)
    const twin = new FakeInput({ type: 'number', maxLength: 8, inputMode: 'numeric' })
    expect(lookup(CODE_FIELD, fakeRoot([numeric, twin]))[0]).toBeNull()
    expect(lookup(CODE_FIELD, fakeRoot([new FakeInput({ type: 'tel', maxLength: 6, inputMode: 'numeric', shown: false })]))[0]).toBeNull()
  })

  it('cherche aussi dans les shadow roots ouverts', () => {
    const inner = new FakeInput({ autocomplete: 'one-time-code' })
    const host = { shadowRoot: fakeRoot([inner]) }
    expect(lookup(CODE_FIELD, fakeRoot([host]))[0]).toBe(inner)
    const password = new FakeInput({ type: 'password' })
    const email = new FakeInput({ type: 'email' })
    expect(lookup(LOGIN_FIELDS, fakeRoot([{ shadowRoot: fakeRoot([email, password]) }]))).toEqual([email, password])
  })

  it('inscription : login seulement s’il est clair, puis tous les mots de passe', () => {
    const firstName = new FakeInput({ name: 'firstName' })
    const remember = new FakeInput({ type: 'checkbox', name: 'remember_login' })
    const email = new FakeInput({ type: 'email', name: 'mail' })
    const password = new FakeInput({ type: 'password', name: 'Passwd' })
    const confirmation = new FakeInput({ type: 'password', name: 'PasswdAgain' })
    expect(lookup(SIGNUP_FIELDS, fakeRoot([firstName, remember, email, password, confirmation]))).toEqual([email, password, confirmation])
    expect(lookup(SIGNUP_FIELDS, fakeRoot([firstName, password, confirmation]))).toEqual([null, password, confirmation])
    expect(lookup(SIGNUP_FIELDS, fakeRoot([firstName]))).toEqual([null])
  })

  it('préfère autocomplete, refuse about:blob:data:, et ignore un champ invisible', () => {
    const search = new FakeInput({ name: 'user_search' })
    const email = new FakeInput({ autocomplete: 'username' })
    const shadowPassword = new FakeInput({ type: 'password' })
    const current = new FakeInput({ type: 'password', autocomplete: 'current-password' })
    const host = { shadowRoot: fakeRoot([shadowPassword]) }
    const login = fakeRoot([host, search, email, current])
    const location = { href: 'https://bank.example/login', origin: 'https://bank.example' }
    const typed = typeDocument(login, location, 'https://bank.example', 'login', 'ada', 'secret')
    expect(typed.filled).toEqual(['identifier', 'password'])
    expect(email.value).toBe('ada')
    expect(current.value).toBe('secret')
    expect(shadowPassword.value).toBe('')
    expect(search.value).toBe('')
    const loneNew = new FakeInput({ type: 'password', autocomplete: 'new-password' })
    expect(lookup(LOGIN_FIELDS, fakeRoot([loneNew]))[1]).toBeNull()

    const created = new FakeInput({ type: 'password', autocomplete: 'new-password' })
    const plain = new FakeInput({ type: 'password' })
    const again = new FakeInput({ type: 'password', autocomplete: 'current-password' })
    const firstName = new FakeInput({ name: 'firstName' })
    const signup = fakeRoot([firstName, again, plain, created])
    const signed = typeDocument(signup, location, 'https://bank.example', 'signup', 'ada', 'secret')
    expect(signed.filled).toEqual(['password'])
    expect(created.value).toBe('secret')
    expect(plain.value).toBe('')
    expect(again.value).toBe('')
    const onlyPlain = new FakeInput({ type: 'password' })
    const currentOnly = new FakeInput({ type: 'password', autocomplete: 'current-password' })
    const fallback = typeDocument(fakeRoot([onlyPlain, currentOnly]), location, 'https://bank.example', 'signup', 'ada', 'secret')
    expect(onlyPlain.value).toBe('secret')
    expect(currentOnly.value).toBe('')
    expect(fallback.filled).toEqual(['password'])

    const hidden = new FakeInput({ type: 'password', autocomplete: 'current-password', computed: { visibility: 'hidden', display: 'block', opacity: '1' } })
    const faded = new FakeInput({ type: 'password', computed: { visibility: 'visible', display: 'block', opacity: '0' } })
    const off = new FakeInput({ type: 'password', rect: { left: 900, top: 10, right: 1000, bottom: 40, width: 100, height: 30 } })
    const none = new FakeInput({ type: 'password', computed: { visibility: 'visible', display: 'none', opacity: '1' } })
    const shown = new FakeInput({ type: 'password', autocomplete: 'current-password' })
    expect(lookup(LOGIN_FIELDS, fakeRoot([hidden, faded, off, none, shown]))[1]).toBe(shown)

    const password = new FakeInput({ type: 'password', autocomplete: 'current-password' })
    const mail = new FakeInput({ type: 'email', autocomplete: 'email' })
    for (const href of ['about:blank', 'blob:https://bank.example/uuid', 'data:text/html,hi']) {
      password.value = ''
      mail.value = ''
      const rejected = typeDocument(fakeRoot([mail, password]), { href, origin: 'https://bank.example' }, 'https://bank.example', 'login', 'ada', 'secret')
      expect(rejected).toEqual({ error: 'origin_mismatch' })
      expect(password.value).toBe('')
      expect(mail.value).toBe('')
    }
  })

  it('donne le focus avant la valeur, puis input et change', () => {
    const code = new FakeInput()
    expect(filler(FILL_CODE).call([code], '123456')).toEqual({ filled: ['code'] })
    expect(code.value).toBe('123456')
    expect(code.events).toEqual(['focus', 'value', 'input', 'change'])
    const login = [new FakeInput(), new FakeInput({ type: 'password' })]
    expect(filler(FILL_LOGIN).call(login, 'moi', 'secret')).toEqual({ filled: ['identifier', 'password'] })
    expect(login[1].events[0]).toBe('focus')
    const signup = [new FakeInput({ type: 'email' }), new FakeInput({ type: 'password' }), new FakeInput({ type: 'password' })]
    expect(filler(FILL_SIGNUP).call(signup, 'moi@exemple.org', 'secret')).toEqual({ filled: ['identifier', 'password', 'confirmation'] })
    expect(signup.map((field) => field.value)).toEqual(['moi@exemple.org', 'secret', 'secret'])
    expect(filler(FILL_SIGNUP).call([null, signup[1]], 'moi', 'autre')).toEqual({ filled: ['password'] })
  })
})

const listenOn = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
const closeServer = (server) => new Promise((resolve) => server.close(resolve))

/** One tab whose origin, password fields and fill outcome the test chooses. `events` keeps the order. */
async function fakeChrome(state, events) {
  const server = http.createServer((request, response) => {
    if (request.url !== '/json/list') { response.statusCode = 404; return response.end() }
    const { port } = server.address()
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify([{ id: 'onglet', type: 'page', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/onglet` }]))
  })
  const sockets = new WebSocketServer({ server })
  sockets.on('connection', (socket) => socket.on('message', (raw) => {
    const { id, method, params } = JSON.parse(String(raw))
    const reply = (result) => socket.send(JSON.stringify({ id, result }))
    if (method === 'Page.getFrameTree') return reply({ frameTree: { frame: { id: 'frame-1' } } })
    if (method === 'Page.createIsolatedWorld') return reply(state.failIsolated ? {} : { executionContextId: 7 })
    if (method === 'Runtime.evaluate') {
      if (params.expression === 'window.location.origin') return reply({ result: { type: 'string', value: state.origin } })
      if (params.expression.includes('federated sign-in')) {
        events.push({ sso: true })
        if (state.sso === 'throw') return reply({ exceptionDetails: { text: 'boom' } })
        return reply({ result: { type: 'object', value: state.sso ?? { providers: [], hasPasswordField: false } } })
      }
      return reply({ result: { type: 'object', objectId: 'champs' } })
    }
    if (method === 'Runtime.callFunctionOn') {
      const inWorld = params.executionContextId === 7
      const checksHref = String(params.functionDeclaration || '').includes('location.href')
      if (!inWorld || !checksHref) return reply({ exceptionDetails: { text: 'main-world' } })
      const args = params.arguments || []
      const href = state.href ?? `${state.origin}/`
      const bad = /^(about:|blob:|data:)/.test(String(href))
      if (args.length <= 2) {
        if (bad && state.hrefMode !== 'type-only') return reply({ result: { type: 'object', value: { error: 'origin_mismatch' } } })
        return reply({ result: { type: 'object', value: { identifier: false, passwords: state.passwords ?? 0 } } })
      }
      if (bad) {
        state.typed = (state.typed || 0) + 1
        return reply({ result: { type: 'object', value: { error: 'origin_mismatch' } } })
      }
      events.push({ fill: args.slice(2).map((argument) => argument.value) })
      if (state.failFill) return reply({ exceptionDetails: { text: 'boom' } })
      return reply({ result: { type: 'object', value: { filled: ['password', 'confirmation'] } } })
    }
    socket.send(JSON.stringify({ id, error: { message: 'unsupported' } }))
  }))
  const port = await listenOn(server)
  return { origin: `http://127.0.0.1:${port}`, close: async () => { for (const client of sockets.clients) client.terminate(); await closeServer(server) } }
}

function memoryStore(events, initial = []) {
  const entries = new Map(initial.map((entry) => [entry.origin, entry]))
  const meta = ({ password: _password, ...entry }) => entry
  return {
    available: true,
    list: async (bot) => [...entries.values()].map(meta).filter((entry) => !bot || botAllowed(entry, bot)),
    find: async (origin) => (entries.has(normalizeOrigin(origin)) ? meta(entries.get(normalizeOrigin(origin))) : null),
    get: async (origin) => entries.get(normalizeOrigin(origin)),
    save: async (origin, identifier, password, bots, options = {}) => {
      const unconfirmed = options?.unconfirmed === true
      events.push({ save: { origin, identifier, password, bots, ...(unconfirmed ? { unconfirmed: true } : {}) } })
      const entry = { id: origin, origin: normalizeOrigin(origin), identifier, password, bots, unconfirmed }
      entries.set(entry.origin, entry)
      return meta(entry)
    },
  }
}

describe('coffre navigateur — création de compte', () => {
  const SITE = 'https://comptes.exemple.org'

  async function setup({ passwords = 2, failFill = false, initial = [], settings, verifyUser = async () => true, href, hrefMode, failIsolated = false } = {}) {
    const events = []
    const lines = []
    const page = { origin: SITE, passwords, failFill, href, hrefMode, failIsolated }
    const chrome = await fakeChrome(page, events)
    const probe = http.createServer()
    const port = await listenOn(probe)
    await closeServer(probe)
    const store = memoryStore(events, initial)
    const vault = createBrowserVault({
      port, adminToken: 'x', verifyUser, cdpOrigin: chrome.origin,
      store, audit: { append: (line) => lines.push(line) }, ...(settings ? { settings } : {}),
    })
    await vault.listen()
    const command = (action, body) => fetch(`http://127.0.0.1:${port}/v1/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bot: 'orion', target: 'onglet', ...body }),
    }).then(async (response) => ({ status: response.status, raw: await response.text() }))
    const call = (body) => command('signup', body)
    const admin = (pathname, body, headers = {}) => fetch(`http://127.0.0.1:${port}${pathname}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer x', 'X-Hermes-Cookie': 'session=test', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (response) => ({ status: response.status, body: await response.json() }))
    const pending = async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const [request] = vault.requests.snapshot()
        if (request) return request
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error('no request')
    }
    const close = async () => { await vault.close(); await chrome.close() }
    return { events, lines, vault, store, call, command, admin, pending, close, page }
  }

  it('montre une carte, puis rend cancelled sans rien ranger ni remplir', async () => {
    const { events, vault, call, pending, close } = await setup()
    try {
      const answer = call({ identifier: 'inscription@exemple.org' })
      const request = await pending()
      expect(request).toMatchObject({ kind: 'signup', bot: 'orion', origin: SITE, identifier: 'inscription@exemple.org' })
      await vault.respond(request.id, { action: 'cancel' })
      const result = await answer
      expect(result.status).toBe(200)
      expect(JSON.parse(result.raw)).toEqual({ status: 'cancelled', origin: SITE })
      expect(events).toEqual([])
    } finally {
      await close()
    }
  })

  it('accepté : range d’abord, remplit ensuite, sans jamais rendre ni journaliser le mot de passe', async () => {
    const { events, lines, vault, call, pending, close } = await setup()
    try {
      const answer = call({ identifier: 'inscription@exemple.org' })
      await vault.respond((await pending()).id, { action: 'signup' })
      const result = await answer
      expect(JSON.parse(result.raw)).toEqual({ status: 'filled', origin: SITE, saved: true, fields: ['password', 'confirmation'] })
      expect(events.map((event) => Object.keys(event)[0])).toEqual(['save', 'fill'])
      const { save } = events[0]
      expect(save).toMatchObject({ origin: SITE, identifier: 'inscription@exemple.org', bots: ['orion'] })
      expect(save.password).toHaveLength(20)
      expect(events[1].fill).toEqual(['inscription@exemple.org', save.password])
      expect(result.raw).not.toContain(save.password)
      expect(lines.join('\n')).not.toContain(save.password)
      expect(lines.map((line) => JSON.parse(line))).toContainEqual(expect.objectContaining({ action: 'signed_up', bot: 'orion', origin: SITE, identifier: 'inscription@exemple.org', result: 'filled' }))
      expect(lines.every((line) => Object.keys(JSON.parse(line)).every((key) => ['at', 'action', 'bot', 'origin', 'identifier', 'result'].includes(key)))).toBe(true)
    } finally {
      await close()
    }
  })

  it('sans champ de mot de passe : refus avant de ranger, l’erreur revient au bot', async () => {
    const { events, vault, call, pending, close } = await setup({ passwords: 0 })
    try {
      const answer = call({ identifier: 'inscription@exemple.org' })
      await expect(vault.respond((await pending()).id, { action: 'signup' })).rejects.toThrow('login_fields_not_found')
      const result = await answer
      expect(result.status).toBe(422)
      expect(JSON.parse(result.raw)).toEqual({ error: 'login_fields_not_found' })
      expect(events).toEqual([])
      expect(vault.requests.snapshot()).toEqual([])
    } finally {
      await close()
    }
  })

  it('rangé mais pas rempli : saved, filled false, pour un fill plus tard', async () => {
    const { events, vault, call, pending, close } = await setup({ failFill: true })
    try {
      const answer = call({ identifier: 'inscription@exemple.org' })
      await vault.respond((await pending()).id, { action: 'signup' })
      const result = await answer
      expect(JSON.parse(result.raw)).toEqual({ status: 'saved', origin: SITE, saved: true, filled: false, error: 'fill_failed' })
      expect(events.map((event) => Object.keys(event)[0])).toEqual(['save', 'fill', 'save'])
      expect(events[2].save.unconfirmed).toBe(true)
      expect(result.raw).not.toContain(events[0].save.password)
    } finally {
      await close()
    }
  })

  it('refuse un site déjà rangé (entry_exists) et un identifiant absent, sans carte', async () => {
    const initial = [{ id: SITE, origin: SITE, identifier: 'inscription@exemple.org', password: 'ancien', bots: ['orion'] }]
    const { events, vault, call, close } = await setup({ initial })
    try {
      const existing = await call({ identifier: 'inscription@exemple.org' })
      expect(existing.status).toBe(409)
      expect(JSON.parse(existing.raw)).toEqual({ error: 'entry_exists' })
      const missing = await call({})
      expect(missing.status).toBe(400)
      expect(JSON.parse(missing.raw)).toEqual({ error: 'invalid_credentials' })
      expect(vault.requests.snapshot()).toEqual([])
      expect(events).toEqual([])
    } finally {
      await close()
    }
  })

  // "Create accounts without asking" (Settings, Vault): no card, everything else unchanged.
  const parsed = (lines) => lines.map((line) => JSON.parse(line))

  it('réglage actif : pas de carte, entrée rangée pour ce bot seul, audit auto_approved, notification', async () => {
    const { events, lines, vault, call, admin, close } = await setup({ settings: memorySettings({ autoSignup: true }) })
    const cards = []
    const unsubscribe = vault.subscribe((snapshot) => cards.push(...snapshot))
    try {
      const result = await call({ identifier: 'inscription@exemple.org' })
      expect(result.status).toBe(200)
      expect(JSON.parse(result.raw)).toEqual({ status: 'filled', origin: SITE, saved: true, fields: ['password', 'confirmation'] })
      expect(cards).toEqual([])
      expect(events.map((event) => Object.keys(event)[0])).toEqual(['save', 'fill'])
      const { save } = events[0]
      expect(save).toMatchObject({ origin: SITE, identifier: 'inscription@exemple.org', bots: ['orion'] })
      expect(save.password).toHaveLength(20)
      expect(events[1].fill).toEqual(['inscription@exemple.org', save.password])
      expect(result.raw).not.toContain(save.password)
      const audit = parsed(lines)
      expect(audit.map(({ action, result: status }) => `${action}:${status}`)).toEqual(['signup:auto_approved', 'signed_up:filled'])
      expect(audit[0]).toMatchObject({ bot: 'orion', origin: SITE, identifier: 'inscription@exemple.org' })
      expect(lines.join('\n')).not.toContain(save.password)
      expect(audit.every((line) => Object.keys(line).every((key) => ['at', 'action', 'bot', 'origin', 'identifier', 'result'].includes(key)))).toBe(true)
      // The app reads the notice with the pending requests: bot, site, login, nothing secret.
      const { status, body } = await admin('/admin/v1/requests')
      expect(status).toBe(200)
      expect(body.requests).toEqual([])
      expect(body.notices).toHaveLength(1)
      expect(body.notices[0]).toMatchObject({ kind: 'auto_signup', bot: 'orion', origin: SITE, identifier: 'inscription@exemple.org' })
      expect(Object.keys(body.notices[0]).sort()).toEqual(['at', 'bot', 'id', 'identifier', 'kind', 'origin'])
      expect(JSON.stringify(body)).not.toContain(save.password)
    } finally {
      unsubscribe()
      await close()
    }
  })

  it('réglage actif, rangé mais pas rempli : saved, sans dire que le compte est créé', async () => {
    const { events, vault, call, close } = await setup({ failFill: true, settings: memorySettings({ autoSignup: true }) })
    try {
      const result = await call({ identifier: 'inscription@exemple.org' })
      expect(JSON.parse(result.raw)).toEqual({ status: 'saved', origin: SITE, saved: true, filled: false, error: 'fill_failed' })
      expect(events.map((event) => Object.keys(event)[0])).toEqual(['save', 'fill', 'save'])
      expect(events[2].save.unconfirmed).toBe(true)
      expect(vault.notices()).toEqual([])
    } finally {
      await close()
    }
  })

  it('réglage actif, sans champ de mot de passe : rien de rangé, pas de notification, l’erreur revient au bot', async () => {
    const { events, lines, vault, call, close } = await setup({ passwords: 0, settings: memorySettings({ autoSignup: true }) })
    try {
      const result = await call({ identifier: 'inscription@exemple.org' })
      expect(result.status).toBe(422)
      expect(JSON.parse(result.raw)).toEqual({ error: 'login_fields_not_found' })
      expect(events).toEqual([])
      expect(vault.notices()).toEqual([])
      expect(parsed(lines).map(({ action, result: status }) => `${action}:${status}`)).toEqual(['signup:auto_approved', 'signup:login_fields_not_found'])
    } finally {
      await close()
    }
  })

  it('réglage inactif (par défaut) : la carte comme avant, aucune notification', async () => {
    const { events, vault, call, pending, admin, close } = await setup()
    try {
      expect((await admin('/admin/v1/settings')).body).toEqual({ settings: { autoSignup: false } })
      const answer = call({ identifier: 'inscription@exemple.org' })
      const request = await pending()
      expect(request).toMatchObject({ kind: 'signup', bot: 'orion', origin: SITE, identifier: 'inscription@exemple.org' })
      expect(events).toEqual([])
      await vault.respond(request.id, { action: 'signup' })
      expect(JSON.parse((await answer).raw)).toMatchObject({ status: 'filled', saved: true })
      expect(vault.notices()).toEqual([])
    } finally {
      await close()
    }
  })

  it('réglage actif, protections gardées : entry_exists (même réservé à un autre bot), bot invalide, cron, trousseau absent', async () => {
    const initial = [{ id: SITE, origin: SITE, identifier: 'vega@exemple.org', password: 'ancien', bots: ['vega'] }]
    const { events, vault, store, call, close } = await setup({ initial, settings: memorySettings({ autoSignup: true }) })
    try {
      const existing = await call({ identifier: 'inscription@exemple.org' })
      expect(existing.status).toBe(409)
      expect(JSON.parse(existing.raw)).toEqual({ error: 'entry_exists' })
      expect((await store.get(SITE)).password).toBe('ancien')
      const invalidBot = await call({ bot: '../vega', identifier: 'inscription@exemple.org' })
      expect(invalidBot.status).toBe(400)
      expect(JSON.parse(invalidBot.raw)).toEqual({ error: 'invalid_bot' })
      const cron = await call({ identifier: 'inscription@exemple.org', unattended: true })
      expect(cron.status).toBe(403)
      expect(JSON.parse(cron.raw)).toEqual({ error: 'unattended_session' })
      store.available = false
      const unavailable = await call({ identifier: 'inscription@exemple.org' })
      expect(unavailable.status).toBe(503)
      expect(JSON.parse(unavailable.raw)).toEqual({ error: 'vault_unavailable' })
      expect(events).toEqual([])
      expect(vault.requests.snapshot()).toEqual([])
      expect(vault.notices()).toEqual([])
    } finally {
      await close()
    }
  })

  it('réglage inactif, en cron : refusé aussi, sans carte', async () => {
    const { events, vault, call, close } = await setup()
    try {
      const cron = await call({ identifier: 'inscription@exemple.org', unattended: true })
      expect(cron.status).toBe(403)
      expect(vault.requests.snapshot()).toEqual([])
      expect(events).toEqual([])
    } finally {
      await close()
    }
  })

  it('réglage actif : le compte créé reste réservé au bot (fill d’un autre bot refusé)', async () => {
    const { events, command, call, close } = await setup({ settings: memorySettings({ autoSignup: true }) })
    try {
      expect((await call({ identifier: 'inscription@exemple.org' })).status).toBe(200)
      const other = await command('fill', { bot: 'vega' })
      expect(other.status).toBe(403)
      expect(JSON.parse(other.raw)).toEqual({ error: 'bot_not_allowed' })
      expect(events.filter((event) => event.fill)).toHaveLength(1)
    } finally {
      await close()
    }
  })

  it('réglage actif : deux inscriptions simultanées sur un site, une seule rangée, l’autre entry_exists', async () => {
    const { events, vault, call, close } = await setup({ settings: memorySettings({ autoSignup: true }) })
    try {
      const results = await Promise.all([call({ identifier: 'un@exemple.org' }), call({ bot: 'vega', identifier: 'deux@exemple.org' })])
      expect(results.map((result) => result.status).sort()).toEqual([200, 409])
      expect(events.filter((event) => event.save)).toHaveLength(1)
      expect(events.filter((event) => event.fill)).toHaveLength(1)
      expect(vault.notices()).toHaveLength(1)
    } finally {
      await close()
    }
  })

  it('réglage actif : save et code gardent leur carte', async () => {
    const { events, vault, command, pending, close } = await setup({ settings: memorySettings({ autoSignup: true }) })
    try {
      for (const kind of ['save', 'code']) {
        const answer = command(kind, {})
        const request = await pending()
        expect(request.kind).toBe(kind)
        await vault.respond(request.id, { action: 'cancel' })
        expect(JSON.parse((await answer).raw)).toEqual({ status: 'cancelled', origin: SITE })
      }
      expect(events.filter((event) => event.save || event.fill)).toEqual([])
      expect(vault.notices()).toEqual([])
    } finally {
      await close()
    }
  })

  it('API du réglage : lecture avec le jeton, écriture avec la session Hermes seulement, booléen strict', async () => {
    let session = false
    const settings = memorySettings()
    const { lines, admin, close } = await setup({ settings, verifyUser: async () => session })
    try {
      expect((await admin('/admin/v1/settings', undefined, { Authorization: 'Bearer y' })).body).toEqual({ error: 'admin_forbidden' })
      expect(await admin('/admin/v1/settings', { autoSignup: true })).toEqual({ status: 403, body: { error: 'user_session_required' } })
      expect(settings.get().autoSignup).toBe(false)
      session = true
      for (const body of [{ autoSignup: 'true' }, { autoSignup: 1 }, {}, { autoSignup: true, autre: true }]) {
        expect(await admin('/admin/v1/settings', body)).toEqual({ status: 400, body: { error: 'invalid_settings' } })
      }
      expect(await admin('/admin/v1/settings', { autoSignup: true })).toEqual({ status: 200, body: { settings: { autoSignup: true } } })
      expect((await admin('/admin/v1/settings')).body).toEqual({ settings: { autoSignup: true } })
      expect(parsed(lines)).toContainEqual(expect.objectContaining({ action: 'admin_settings', bot: 'hermesbot', result: 'auto_signup_on' }))
    } finally {
      await close()
    }
  })

  it('refuse une quatrième demande du même bot', async () => {
    const { command, vault, close } = await setup()
    const waiting = []
    const hold = (promise) => { waiting.push(promise); promise.catch(() => undefined) }
    try {
      for (let index = 0; index < 3; index += 1) hold(command('save', {}))
      for (let attempt = 0; attempt < 100 && vault.requests.snapshot().length < 3; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(vault.requests.snapshot()).toHaveLength(3)
      const fourth = await command('save', {})
      expect(fourth.status).toBe(429)
      expect(JSON.parse(fourth.raw)).toEqual({ error: 'too_many_requests' })
    } finally {
      await close()
      await Promise.allSettled(waiting)
    }
  })

  it('cinq créations par bot et par heure, puis too_many_signups', async () => {
    const { page, events, call, close } = await setup({ settings: memorySettings({ autoSignup: true }) })
    try {
      for (let index = 0; index < 5; index += 1) {
        page.origin = `https://site${index}.exemple.org`
        const result = await call({ identifier: `u${index}@exemple.org` })
        expect(result.status).toBe(200)
      }
      page.origin = 'https://site5.exemple.org'
      const sixth = await call({ identifier: 'u5@exemple.org' })
      expect(sixth.status).toBe(429)
      expect(JSON.parse(sixth.raw)).toEqual({ error: 'too_many_signups' })
      expect(events.filter((event) => event.save)).toHaveLength(5)
    } finally {
      await close()
    }
  })

  it('un échec de frappe marque l’entrée, et le même bot peut la remplacer', async () => {
    const { events, store, vault, call, command, page, close } = await setup({ failFill: true, settings: memorySettings({ autoSignup: true }) })
    try {
      const first = await call({ identifier: 'inscription@exemple.org' })
      expect(JSON.parse(first.raw)).toEqual({ status: 'saved', origin: SITE, saved: true, filled: false, error: 'fill_failed' })
      expect(events.at(-1).save.unconfirmed).toBe(true)
      expect((await store.get(SITE)).unconfirmed).toBe(true)
      expect(vault.notices()).toEqual([])
      const other = await command('signup', { bot: 'vega', identifier: 'vega@exemple.org' })
      expect(other.status).toBe(409)
      expect(JSON.parse(other.raw)).toEqual({ error: 'entry_exists' })
      page.failFill = false
      const again = await call({ identifier: 'autre@exemple.org' })
      expect(again.status).toBe(200)
      expect(JSON.parse(again.raw).status).toBe('filled')
      expect(events.some((event) => event.save?.identifier === 'autre@exemple.org' && !event.save.unconfirmed)).toBe(true)
    } finally {
      await close()
    }
  })

  it('about:blank avec la même origine est origin_mismatch, sans rien ranger', async () => {
    const { events, call, close } = await setup({ href: 'about:blank', settings: memorySettings({ autoSignup: true }) })
    try {
      const result = await call({ identifier: 'inscription@exemple.org' })
      expect(result.status).toBe(403)
      expect(JSON.parse(result.raw)).toEqual({ error: 'origin_mismatch' })
      expect(events).toEqual([])
    } finally {
      await close()
    }
  })

  it('la frappe elle-même refuse un document qui n’est pas http', async () => {
    const { events, page, vault, call, close } = await setup({ href: 'about:blank', hrefMode: 'type-only', settings: memorySettings({ autoSignup: true }) })
    try {
      const result = await call({ identifier: 'inscription@exemple.org' })
      expect(JSON.parse(result.raw)).toEqual({ status: 'saved', origin: SITE, saved: true, filled: false, error: 'origin_mismatch' })
      expect(page.typed).toBe(1)
      expect(events.map((event) => Object.keys(event)[0])).toEqual(['save', 'save'])
      expect(events[1].save.unconfirmed).toBe(true)
      expect(vault.notices()).toEqual([])
    } finally {
      await close()
    }
  })

  it('refuse si le monde isolé ne se crée pas', async () => {
    const { events, call, close } = await setup({ failIsolated: true, settings: memorySettings({ autoSignup: true }) })
    try {
      const result = await call({ identifier: 'inscription@exemple.org' })
      expect(result.status).toBe(503)
      expect(JSON.parse(result.raw)).toEqual({ error: 'isolated_world_failed' })
      expect(events).toEqual([])
    } finally {
      await close()
    }
  })

  it('une demande save sur un site déjà rangé porte replaces, jamais le mot de passe', async () => {
    const initial = [{ id: SITE, origin: SITE, identifier: 'ada@exemple.org', password: 'ancien-secret', bots: ['vega'] }]
    const { vault, command, pending, close } = await setup({ initial })
    try {
      const answer = command('save', {})
      const request = await pending()
      expect(request.replaces).toEqual({ identifier: 'ada@exemple.org', bots: ['vega'] })
      expect(JSON.stringify(request)).not.toContain('ancien-secret')
      expect(request.password).toBeUndefined()
      await vault.respond(request.id, { action: 'cancel' })
      await answer
      const fresh = await setup()
      try {
        const first = fresh.command('save', {})
        expect((await fresh.pending()).replaces).toBeUndefined()
        await fresh.vault.respond((await fresh.pending()).id, { action: 'cancel' })
        await first
      } finally {
        await fresh.close()
      }
    } finally {
      await close()
    }
  })

  it('GET ne vérifie pas la session, logout vide le cache', async () => {
    let checks = 0
    const { admin, vault, close } = await setup({ verifyUser: async () => { checks += 1; return true } })
    try {
      expect((await admin('/admin/v1/requests')).status).toBe(200)
      expect((await admin('/admin/v1/nope')).status).toBe(400)
      expect(checks).toBe(0)
      expect((await admin('/admin/v1/settings', { autoSignup: false })).status).toBe(200)
      expect(checks).toBe(1)
      expect((await admin('/admin/v1/settings', { autoSignup: false })).status).toBe(200)
      expect(checks).toBe(1)
      const port = vault.server.address().port
      const logout = await fetch(`http://127.0.0.1:${port}/admin/v1/logout`, { method: 'POST', headers: { Authorization: 'Bearer x' } })
      expect(logout.status).toBe(200)
      expect(await logout.json()).toEqual({ ok: true })
      expect((await admin('/admin/v1/settings', { autoSignup: false })).status).toBe(200)
      expect(checks).toBe(2)
      const denied = await fetch(`http://127.0.0.1:${port}/admin/v1/logout`, { method: 'POST', headers: { Authorization: 'Bearer y' } })
      expect(denied.status).toBe(403)
      expect(await denied.json()).toEqual({ error: 'admin_forbidden' })
    } finally {
      await close()
    }
  })
})

// Page elements for the federated sign-in lookup: tag, text, attributes, sources, shadow roots, frames.
class FakeElement {
  constructor(tagName, fields = {}) {
    const { attributes = {}, children = [], ...rest } = fields
    Object.assign(this, { tagName, textContent: '', shadowRoot: null }, rest)
    this.attributes = attributes
    this.children = children
  }
  getAttribute(name) { return this.attributes[name] ?? null }
}
const page = (...elements) => ({ querySelectorAll: () => elements })
const federated = (document) => new Function('document', 'getComputedStyle', 'window', `return ${FEDERATED_SIGNIN}`)(document, computedStyle, VIEW)

describe('coffre navigateur — connexion fédérée, repérage sur la page', () => {
  it('bouton Google seul : google, sans champ de mot de passe', () => {
    const button = new FakeElement('BUTTON', { textContent: '  Continue with\n  Google ' })
    const email = new FakeInput({ tagName: 'INPUT', type: 'email' })
    expect(federated(page(button, email))).toEqual({ providers: ['google'], hasPasswordField: false })
  })

  it('Google et mot de passe : google, avec champ de mot de passe', () => {
    const button = new FakeElement('DIV', { attributes: { role: 'button', 'aria-label': 'Sign in with Google' } })
    const password = new FakeInput({ tagName: 'INPUT', type: 'password' })
    expect(federated(page(new FakeInput({ tagName: 'INPUT', type: 'email' }), password, button))).toEqual({ providers: ['google'], hasPasswordField: true })
  })

  it('aucun bouton fédéré : rien, même avec un champ de mot de passe caché ou des scripts Google sans connexion', () => {
    const hidden = new FakeInput({ tagName: 'INPUT', type: 'password', shown: false })
    const faded = new FakeInput({ tagName: 'INPUT', type: 'password', computed: { visibility: 'visible', display: 'block', opacity: '0' } })
    const analytics = new FakeElement('SCRIPT', { src: 'https://www.googletagmanager.com/gtag/js?id=G-1' })
    const signIn = new FakeElement('BUTTON', { textContent: 'Sign in with your email' })
    const help = new FakeElement('A', { textContent: 'Google Workspace help', href: 'https://support.google.com/' })
    expect(federated(page(hidden, faded, analytics, signIn, help))).toEqual({ providers: [], hasPasswordField: false })
  })

  it('textes français, Apple et Microsoft, dans l’ordre de la page', () => {
    const apple = new FakeElement('A', { textContent: 'Se connecter avec Apple' })
    const microsoft = new FakeElement('BUTTON', { textContent: 'Continuer avec un compte Microsoft' })
    const google = new FakeElement('BUTTON', { textContent: 'Continuer avec Google' })
    const submit = new FakeElement('INPUT', { type: 'submit', value: 'S’inscrire avec Google' })
    expect(federated(page(apple, microsoft, google, submit)).providers).toEqual(['apple', 'microsoft', 'google'])
    expect(federated(page(submit)).providers).toEqual(['google'])
  })

  it('scripts, iframes et liens des fournisseurs, shadow roots et iframes de même origine', () => {
    const gsi = new FakeElement('SCRIPT', { src: 'https://accounts.google.com/gsi/client' })
    expect(federated(page(gsi)).providers).toEqual(['google'])
    const appleFrame = new FakeElement('IFRAME', { src: 'https://appleid.apple.com/auth/authorize?client_id=x' })
    expect(federated(page(appleFrame)).providers).toEqual(['apple'])
    const microsoftLink = new FakeElement('A', { href: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize' })
    expect(federated(page(microsoftLink)).providers).toEqual(['microsoft'])
    const inShadow = { shadowRoot: page(new FakeElement('BUTTON', { textContent: 'Log in with Google' })) }
    expect(federated(page(inShadow)).providers).toEqual(['google'])
    const sameOrigin = new FakeElement('IFRAME', { src: '/login-frame', contentDocument: page(new FakeElement('BUTTON', { textContent: 'Continue with Apple' }), new FakeInput({ tagName: 'INPUT', type: 'password' })) })
    expect(federated(page(sameOrigin))).toEqual({ providers: ['apple'], hasPasswordField: true })
    // A cross-origin frame cannot be read: no error, nothing found inside it.
    const crossOrigin = new FakeElement('IFRAME', { src: 'https://ads.example/frame' })
    Object.defineProperty(crossOrigin, 'contentDocument', { get() { throw new Error('SecurityError') } })
    expect(federated(page(crossOrigin))).toEqual({ providers: [], hasPasswordField: false })
  })

  it('accounts.google.com : la page du compte Google lui-même, même sans bouton', () => {
    expect(accountPageProvider('https://accounts.google.com')).toBe('google')
    expect(accountPageProvider('https://appleid.apple.com')).toBe('apple')
    expect(accountPageProvider('https://login.live.com')).toBe('microsoft')
    expect(accountPageProvider('https://login.exemple.org')).toBeNull()
    expect(federatedSignIn('https://accounts.google.com', { providers: [], hasPasswordField: true })).toEqual({ provider: 'google', providers: ['google'], hasPasswordField: true, accountPage: true })
    expect(federatedSignIn('https://accounts.google.com', null)).toMatchObject({ provider: 'google', accountPage: true })
  })

  it('ne garde que des noms de fournisseur connus venus de la page', () => {
    expect(federatedSignIn('https://login.exemple.org', null)).toBeNull()
    expect(federatedSignIn('https://login.exemple.org', { providers: ['<img>', 'google', 'google'], hasPasswordField: 'yes' })).toEqual({ provider: 'google', providers: ['google'], hasPasswordField: false })
    expect(federatedSignIn('https://login.exemple.org', { providers: 'google' })).toBeNull()
  })
})

describe('coffre navigateur — connexion fédérée, réponse au bot', () => {
  const SITE = 'https://login.exemple.org'

  async function setup({ origin = SITE, sso } = {}) {
    const events = []
    const lines = []
    const chrome = await fakeChrome({ origin, passwords: 1, sso }, events)
    const probe = http.createServer()
    const port = await listenOn(probe)
    await closeServer(probe)
    const vault = createBrowserVault({
      port, adminToken: 'x', verifyUser: async () => true, cdpOrigin: chrome.origin,
      store: memoryStore(events), audit: { append: (line) => lines.push(line) },
    })
    await vault.listen()
    const save = () => fetch(`http://127.0.0.1:${port}/v1/save`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bot: 'orion', target: 'onglet' }),
    }).then(async (response) => ({ status: response.status, body: await response.json() }))
    const pending = async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const [request] = vault.requests.snapshot()
        if (request) return request
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error('no request')
    }
    const close = async () => { await vault.close(); await chrome.close() }
    return { events, lines, vault, save, pending, close }
  }

  it('la demande save porte le bouton Google vu sur la page', async () => {
    const { vault, save, pending, close } = await setup({ sso: { providers: ['google'], hasPasswordField: false } })
    try {
      const answer = save()
      const request = await pending()
      expect(request).toMatchObject({ kind: 'save', origin: SITE, sso: { provider: 'google', providers: ['google'], hasPasswordField: false } })
      await vault.respond(request.id, { action: 'cancel' })
      expect((await answer).body).toEqual({ status: 'cancelled', origin: SITE })
    } finally {
      await close()
    }
  })

  it('sso : rend use_sso avec la consigne, ne range rien, journal save use_sso', async () => {
    const { events, lines, vault, save, pending, close } = await setup({ sso: { providers: ['google'], hasPasswordField: true } })
    try {
      const answer = save()
      await vault.respond((await pending()).id, { action: 'sso', provider: 'google' })
      const result = await answer
      expect(result.status).toBe(200)
      expect(result.body).toEqual(useSsoResult(SITE, 'google'))
      expect(result.body).toMatchObject({ status: 'use_sso', origin: SITE, provider: 'google' })
      expect(result.body.next).toBe("The user signs in to this site with Google: click the site's 'Continue with Google' button and pick the account already signed in in this Chrome. Do not ask for a password.")
      expect(events.some((event) => event.save || event.fill)).toBe(false)
      expect(lines.map((line) => JSON.parse(line))).toContainEqual(expect.objectContaining({ action: 'save', bot: 'orion', origin: SITE, result: 'use_sso' }))
    } finally {
      await close()
    }
  })

  it('sso accepté sans bouton repéré (Apple choisi), refuse un fournisseur inconnu sans fermer la demande', async () => {
    const { vault, save, pending, close } = await setup()
    try {
      const answer = save()
      const request = await pending()
      expect(request.sso).toBeUndefined()
      await expect(vault.respond(request.id, { action: 'sso', provider: 'facebook' })).rejects.toThrow('invalid_provider')
      expect(vault.requests.snapshot()[0]).toMatchObject({ id: request.id, busy: false })
      await vault.respond(request.id, { action: 'sso', provider: 'apple' })
      expect((await answer).body).toMatchObject({ status: 'use_sso', provider: 'apple' })
    } finally {
      await close()
    }
  })

  it('repérage en échec : la demande part quand même, sans indice', async () => {
    const { events, vault, save, pending, close } = await setup({ sso: 'throw' })
    try {
      const answer = save()
      const request = await pending()
      expect(events).toContainEqual({ sso: true })
      expect(request.sso).toBeUndefined()
      await vault.respond(request.id, { action: 'cancel' })
      expect((await answer).body.status).toBe('cancelled')
    } finally {
      await close()
    }
  })

  it('accounts.google.com : indice « compte Google lui-même », sso refusé (aucun bouton à cliquer)', async () => {
    const { vault, save, pending, close } = await setup({ origin: 'https://accounts.google.com' })
    try {
      const answer = save()
      const request = await pending()
      expect(request.sso).toEqual({ provider: 'google', providers: ['google'], hasPasswordField: false, accountPage: true })
      await expect(vault.respond(request.id, { action: 'sso', provider: 'google' })).rejects.toThrow('invalid_action')
      await vault.respond(request.id, { action: 'cancel' })
      expect((await answer).body.status).toBe('cancelled')
    } finally {
      await close()
    }
  })

  it('sso réservé à une demande save', async () => {
    const { vault, pending, close } = await setup()
    try {
      const answer = fetch(`http://127.0.0.1:${vault.server.address().port}/v1/code`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bot: 'orion', target: 'onglet' }),
      }).then((response) => response.json())
      const request = await pending()
      await expect(vault.respond(request.id, { action: 'sso', provider: 'google' })).rejects.toThrow('invalid_action')
      await vault.respond(request.id, { action: 'cancel' })
      expect((await answer).status).toBe('cancelled')
    } finally {
      await close()
    }
  })
})

describe('coffre navigateur — fichier des réglages', () => {
  it('désactivé par défaut, booléen strict seulement', () => {
    expect(parseSettings(undefined)).toEqual({ autoSignup: false })
    expect(parseSettings({ autoSignup: 'true' })).toEqual({ autoSignup: false })
    expect(parseSettings({ autoSignup: true, autre: 1 })).toEqual({ autoSignup: true })
  })

  it('écrit en 0600, relu au démarrage suivant ; illisible, corrompu ou ouvert aux autres : désactivé', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'hermesbot-vault-settings-'))
    const file = path.join(directory, 'HermesBot', 'browser-vault-settings.json')
    try {
      expect(fileSettings(file).get()).toEqual({ autoSignup: false })
      await expect(fileSettings(file).set({ autoSignup: 'oui' })).rejects.toThrow('invalid_settings')
      expect(existsSync(file)).toBe(false)
      expect(await fileSettings(file).set({ autoSignup: true })).toEqual({ autoSignup: true })
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ autoSignup: true })
      expect(fileSettings(file).get()).toEqual({ autoSignup: true })
      chmodSync(file, 0o620)
      expect(fileSettings(file).get()).toEqual({ autoSignup: false })
      chmodSync(file, 0o600)
      writeFileSync(file, '{pas du json')
      expect(fileSettings(file).get()).toEqual({ autoSignup: false })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('coffre navigateur — origine Hermes et journal', () => {
  it('n’accepte qu’une origine loopback pour la session', () => {
    expect(loopbackOrigin('http://127.0.0.1:9120')).toBe('http://127.0.0.1:9120')
    expect(loopbackOrigin('http://localhost:9120')).toBe('http://localhost:9120')
    expect(loopbackOrigin('http://[::1]:9120')).toBe('http://[::1]:9120')
    expect(loopbackOrigin('https://evil.example')).toBeNull()
    expect(loopbackOrigin('http://127.0.0.1.evil.example')).toBeNull()
    expect(loopbackOrigin('http://0.0.0.0:9120')).toBeNull()
    expect(loopbackOrigin('file:///tmp/x')).toBeNull()
    expect(loopbackOrigin('http://user:secret@127.0.0.1:9120')).toBeNull()
  })

  it('renomme le journal au-delà de 2 Mio et ne garde qu’un ancien', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'hermesbot-vault-audit-'))
    const file = path.join(directory, 'browser-vault-audit.jsonl')
    try {
      writeFileSync(file, 'x'.repeat(AUDIT_MAX_BYTES))
      appendAudit(file, '{"action":"list"}')
      expect(existsSync(`${file}.1`)).toBe(false)
      expect(readFileSync(file, 'utf8').endsWith('{"action":"list"}\n')).toBe(true)
      writeFileSync(file, 'y'.repeat(AUDIT_MAX_BYTES + 1))
      appendAudit(file, '{"action":"list"}')
      expect(readFileSync(`${file}.1`, 'utf8')).toBe('y'.repeat(AUDIT_MAX_BYTES + 1))
      expect(readFileSync(file, 'utf8')).toBe('{"action":"list"}\n')
      expect(statSync(file).mode & 0o777).toBe(0o600)
      writeFileSync(file, 'z'.repeat(AUDIT_MAX_BYTES + 1))
      appendAudit(file, '{"action":"fill"}')
      expect(readFileSync(`${file}.1`, 'utf8')).toBe('z'.repeat(AUDIT_MAX_BYTES + 1))
      expect(existsSync(`${file}.2`)).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('coffre navigateur — socket CDP', () => {
  it('ignore un debugger hors du port configuré ou hors loopback', async () => {
    let mode = 'wrong-port'
    const server = http.createServer((request, response) => {
      if (request.url !== '/json/list') { response.statusCode = 404; return response.end() }
      const { port } = server.address()
      const url = mode === 'remote' ? `ws://169.254.1.1:${port}/devtools/page/onglet`
        : mode === 'secure' ? `wss://127.0.0.1:${port}/devtools/page/onglet`
          : `ws://127.0.0.1:9/devtools/page/onglet`
      const list = mode === 'missing'
        ? [{ id: 'autre', type: 'page', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/autre` }]
        : [{ id: 'onglet', type: 'page', webSocketDebuggerUrl: url }]
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify(list))
    })
    const port = await listenOn(server)
    try {
      const cdp = new BrowserVaultCdp(`http://127.0.0.1:${port}`)
      await expect(cdp.activeOrigin('onglet')).rejects.toThrow('cdp_unavailable')
      mode = 'remote'
      await expect(cdp.activeOrigin('onglet')).rejects.toThrow('cdp_unavailable')
      mode = 'secure'
      await expect(cdp.activeOrigin('onglet')).rejects.toThrow('cdp_unavailable')
      mode = 'missing'
      await expect(cdp.activeOrigin('onglet')).rejects.toThrow('target_not_found')
    } finally {
      await closeServer(server)
    }
  })
})
