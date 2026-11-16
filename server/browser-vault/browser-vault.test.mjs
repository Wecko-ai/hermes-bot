import http from 'node:http'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { normalizeOrigin } from './store.mjs'
import { attributeValue, botAllowed, KeychainStore, parseDump, passwordValue, runSecurity, validBots } from './keychain.mjs'
import { WebSocketServer } from 'ws'
import { BrowserVaultRequests } from './requests.mjs'
import { createBrowserVault } from './service.mjs'
import { generatePassword, PASSWORD_ALPHABET, PASSWORD_CLASSES } from './password.mjs'
import { CODE_FIELD, FILL_CODE, FILL_LOGIN, FILL_SIGNUP, LOGIN_FIELDS, SIGNUP_FIELDS } from './cdp.mjs'

const darwin = process.platform === 'darwin' && existsSync('/usr/bin/security')

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
    const run = (args, input) => { calls.push(args); return runSecurity(args, input) }
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
      expect(calls.flat().some((value) => value.includes('deadbeef') || value.includes(secret))).toBe(false)
    } finally {
      await runSecurity(['delete-keychain', keychain])
      rmSync(directory, { recursive: true, force: true })
    }
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

const lookup = (expression, document) => new Function('document', 'HTMLInputElement', `return ${expression}`)(document, FakeInput)
const filler = (declaration) => new Function('HTMLInputElement', 'Event', `return (${declaration})`)(FakeInput, Event)

describe('coffre navigateur — repérage des champs', () => {
  it('trouve le code par aria-label, placeholder, label ou aria-labelledby', () => {
    const search = new FakeInput({ name: 'q' })
    const byAria = new FakeInput({ attributes: { 'aria-label': 'Enter code' } })
    expect(lookup(CODE_FIELD, fakeRoot([search, byAria]))[0]).toBe(byAria)
    const byPlaceholder = new FakeInput({ placeholder: 'Code à 6 chiffres' })
    expect(lookup(CODE_FIELD, fakeRoot([search, byPlaceholder]))[0]).toBe(byPlaceholder)
    const byLabel = new FakeInput({ labels: [{ textContent: 'Verification' }] })
    expect(lookup(CODE_FIELD, fakeRoot([search, byLabel]))[0]).toBe(byLabel)
    const byLabelledBy = new FakeInput({ attributes: { 'aria-labelledby': 'titre' } })
    expect(lookup(CODE_FIELD, fakeRoot([search, byLabelledBy], { titre: { textContent: 'Your PIN' } }))[0]).toBe(byLabelledBy)
  })

  it('ignore codes postaux et promos, prend le seul champ court en dernier recours', () => {
    const postal = new FakeInput({ name: 'postal_code', maxLength: 5 })
    const promo = new FakeInput({ placeholder: 'Promo code' })
    expect(lookup(CODE_FIELD, fakeRoot([postal, promo]))[0]).toBeNull()
    const short = new FakeInput({ type: 'tel', maxLength: 6 })
    expect(lookup(CODE_FIELD, fakeRoot([new FakeInput({ name: 'q' }), short]))[0]).toBe(short)
    const twin = new FakeInput({ type: 'number', maxLength: 8 })
    expect(lookup(CODE_FIELD, fakeRoot([short, twin]))[0]).toBeNull()
    expect(lookup(CODE_FIELD, fakeRoot([new FakeInput({ type: 'tel', maxLength: 6, shown: false })]))[0]).toBeNull()
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
    if (method === 'Runtime.evaluate') {
      if (params.expression === 'window.location.origin') return reply({ result: { type: 'string', value: state.origin } })
      return reply({ result: { type: 'object', objectId: 'champs' } })
    }
    if (method === 'Runtime.callFunctionOn' && !params.arguments) return reply({ result: { type: 'object', value: { identifier: false, passwords: state.passwords } } })
    if (method === 'Runtime.callFunctionOn') {
      events.push({ fill: params.arguments.map((argument) => argument.value) })
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
    save: async (origin, identifier, password, bots) => {
      events.push({ save: { origin, identifier, password, bots } })
      const entry = { id: origin, origin: normalizeOrigin(origin), identifier, password, bots }
      entries.set(entry.origin, entry)
      return meta(entry)
    },
  }
}

describe('coffre navigateur — création de compte', () => {
  const SITE = 'https://comptes.exemple.org'

  async function setup({ passwords = 2, failFill = false, initial = [] } = {}) {
    const events = []
    const lines = []
    const chrome = await fakeChrome({ origin: SITE, passwords, failFill }, events)
    const probe = http.createServer()
    const port = await listenOn(probe)
    await closeServer(probe)
    const vault = createBrowserVault({
      port, adminToken: 'x', verifyUser: async () => true, cdpOrigin: chrome.origin,
      store: memoryStore(events, initial), audit: { append: (line) => lines.push(line) },
    })
    await vault.listen()
    const call = (body) => fetch(`http://127.0.0.1:${port}/v1/signup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bot: 'orion', target: 'onglet', ...body }),
    }).then(async (response) => ({ status: response.status, raw: await response.text() }))
    const pending = async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const [request] = vault.requests.snapshot()
        if (request) return request
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error('no request')
    }
    const close = async () => { await vault.close(); await chrome.close() }
    return { events, lines, vault, call, pending, close }
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
      expect(events.map((event) => Object.keys(event)[0])).toEqual(['save', 'fill'])
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
})
