/**
 * Bot credentials in the macOS session keychain, through `/usr/bin/security`.
 *
 * One credential = one "Internet password": server, protocol and port of the origin, account =
 * login, creator `HBot`, label "HermesBot · <origin>", comment `{"bots":[…]}` (allowed bots,
 * `*` for all). Visible and editable in Keychain Access.
 *
 * The password goes through the standard input of `security -i`, never through its arguments (readable
 * in `ps`). It is only read when filling. The session keychain is only readable from the user's
 * graphical session (not over SSH): the service runs as a LaunchAgent on the bots' machine.
 */
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { BrowserVaultError } from './errors.mjs'
import { normalizeOrigin } from './store.mjs'

const SECURITY = '/usr/bin/security'
const CREATOR = 'HBot'
const LABEL_PREFIX = 'HermesBot · '
const BOT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
// A line break would end the `security -i` command: refused everywhere, like the other checks.
const CONTROL = /[\u0000-\u001f\u007f]/

export const defaultKeychain = () => process.env.HERMESBOT_KEYCHAIN || path.join(os.homedir(), 'Library/Keychains/login.keychain-db')

/** Runs `security`. `input` goes to the standard input. Never rejects: the exit code is what counts. */
export function runSecurity(args, input = '', timeoutMs = 15_000) {
  return new Promise((resolve) => {
    const child = spawn(SECURITY, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', () => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: 'spawn_failed' }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }) })
    child.stdin.end(input)
  })
}

/** Attribute value from `security`: `<NULL>`, plain `"text"` or `0xHEX  "escaped"`. */
export function attributeValue(raw) {
  const value = raw.trim()
  if (!value || value === '<NULL>') return null
  const hex = /^0x([0-9A-Fa-f]*)/.exec(value)
  if (hex) return Buffer.from(hex[1], 'hex').toString('utf8')
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) return value.slice(1, -1)
  return value
}

/** Password from `find-internet-password -g` (error output): plain text, or hexadecimal as soon as there are quotes, `\` or accents. */
export function passwordValue(stderr) {
  const line = String(stderr).split('\n').find((item) => item.startsWith('password:'))
  if (line === undefined) return null
  const value = line.slice('password:'.length).trim()
  if (!value) return ''
  const hex = /^0x([0-9A-Fa-f]+)/.exec(value)
  if (hex) return Buffer.from(hex[1], 'hex').toString('utf8')
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value
}

/** `inet` items from `dump-keychain`, attributes decoded. */
export function parseDump(text) {
  const items = []
  let current = null
  for (const line of String(text).split('\n')) {
    if (line.startsWith('keychain:')) {
      current = { class: '', attributes: {} }
      items.push(current)
      continue
    }
    if (!current) continue
    const kind = /^class: "?([^"]*)"?/.exec(line)
    if (kind) {
      current.class = kind[1]
      continue
    }
    const attribute = /^\s+"([a-z]{4})"<([a-z0-9]+)>=(.*)$/.exec(line)
    if (!attribute) continue
    const [, name, type, raw] = attribute
    // An integer (`port`) is written in hexadecimal: it is a number, not text.
    const number = type === 'uint32' ? /^0x([0-9A-Fa-f]+)\s*$/.exec(raw.trim()) : null
    current.attributes[name] = number ? Number.parseInt(number[1], 16) : attributeValue(raw)
  }
  return items.filter((item) => item.class === 'inet')
}

const PROTOCOLS = { 'https:': 'htps', 'http:': 'http' }

/** Origin → server, `security` protocol and explicit port (0 for the default one). */
export function originParts(origin) {
  const url = new URL(normalizeOrigin(origin))
  return { origin: url.origin, server: url.hostname, protocol: PROTOCOLS[url.protocol], port: Number(url.port || 0) }
}

function itemOrigin(attributes) {
  const scheme = attributes.ptcl === 'htps' ? 'https' : attributes.ptcl === 'http' ? 'http' : ''
  const server = attributes.srvr || ''
  if (!scheme || !server) return ''
  const port = typeof attributes.port === 'number' ? attributes.port : 0
  try {
    return normalizeOrigin(`${scheme}://${server.includes(':') ? `[${server}]` : server}${port ? `:${port}` : ''}`)
  } catch {
    return ''
  }
}

function itemBots(comment) {
  try {
    const value = JSON.parse(comment || '{}')
    return Array.isArray(value.bots) ? value.bots.filter((bot) => bot === '*' || (typeof bot === 'string' && BOT_NAME.test(bot))) : []
  } catch {
    return []
  }
}

const keychainDate = (value) => {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z/.exec(value || '')
  return match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z` : null
}

/** String for `security -i`: quotes and `\` escaped. Line breaks are refused beforehand. */
const quote = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

export function validBots(value) {
  const bots = Array.isArray(value) ? [...new Set(value)] : []
  if (!bots.length || bots.length > 64 || bots.some((bot) => bot !== '*' && (typeof bot !== 'string' || !BOT_NAME.test(bot)))) {
    throw new BrowserVaultError('invalid_bots', 400)
  }
  return bots.includes('*') ? ['*'] : bots.sort()
}

export const botAllowed = (entry, bot) => entry.bots.includes('*') || entry.bots.includes(bot)

export class KeychainStore {
  constructor({ keychain = defaultKeychain(), run = runSecurity } = {}) {
    this.keychain = keychain
    this.run = run
  }

  get available() {
    return process.platform === 'darwin' || this.run !== runSecurity
  }

  async items() {
    const result = await this.run(['dump-keychain', this.keychain])
    if (result.code !== 0) throw new BrowserVaultError('vault_unavailable', 503)
    return parseDump(result.stdout)
      .filter((item) => item.attributes.crtr === CREATOR)
      .map((item) => ({ attributes: item.attributes, origin: itemOrigin(item.attributes) }))
      .filter((item) => item.origin)
  }

  /** Metadata only: never a password. `bot` restricts to the credentials it can use. */
  async list(bot) {
    return (await this.items())
      .map(({ attributes, origin }) => ({
        id: origin,
        origin,
        identifier: attributes.acct || '',
        bots: itemBots(attributes.icmt),
        createdAt: keychainDate(attributes.cdat),
        updatedAt: keychainDate(attributes.mdat),
      }))
      .filter((entry) => !bot || botAllowed(entry, bot))
      .sort((a, b) => a.origin.localeCompare(b.origin))
  }

  async find(originValue) {
    const { origin } = originParts(originValue)
    return (await this.list()).find((entry) => entry.origin === origin) || null
  }

  /** Login and password of an origin, for filling only. */
  async get(originValue) {
    const entry = await this.find(originValue)
    if (!entry) throw new BrowserVaultError('origin_not_found', 404)
    const { server, protocol, port } = originParts(entry.origin)
    const args = ['find-internet-password', '-s', server, '-r', protocol, '-P', String(port), '-c', CREATOR, '-a', entry.identifier]
    const result = await this.run([...args, '-g', this.keychain])
    const password = result.code === 0 ? passwordValue(result.stderr) : null
    if (password === null) throw new BrowserVaultError('vault_unavailable', 503)
    return { ...entry, password }
  }

  async deleteOrigin(origin) {
    const { server, protocol, port } = originParts(origin)
    // A changed login leaves the old item behind: we remove all those of this origin.
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const args = ['delete-internet-password', '-s', server, '-r', protocol, '-P', String(port), '-c', CREATOR]
      const result = await this.run([...args, this.keychain])
      if (result.code !== 0) return
    }
  }

  /** Creates or replaces the credential of an origin. Without `password`, keeps the current one (login or bots change). */
  async save(originValue, identifier, password, bots) {
    const { origin, server, protocol, port } = originParts(originValue)
    const allowed = validBots(bots)
    if (typeof identifier !== 'string' || !identifier || identifier.length > 1024 || CONTROL.test(identifier)) {
      throw new BrowserVaultError('invalid_credentials', 400)
    }
    let secret = password
    if (secret === undefined || secret === null) secret = (await this.get(origin)).password
    if (typeof secret !== 'string' || !secret || secret.length > 4096 || CONTROL.test(secret)) {
      throw new BrowserVaultError('invalid_credentials', 400)
    }
    await this.deleteOrigin(origin)
    const command = [
      'add-internet-password',
      '-a', quote(identifier),
      '-s', quote(server),
      '-r', protocol,
      '-P', String(port),
      '-l', quote(`${LABEL_PREFIX}${origin}`),
      '-c', CREATOR,
      '-j', quote(JSON.stringify({ bots: allowed })),
      // `security` alone reads the item without an authorization window: the service has no screen.
      '-T', SECURITY,
      '-w', quote(secret),
      quote(this.keychain),
    ].join(' ')
    const result = await this.run(['-i'], `${command}\n`)
    // `security -i` returns 0 even if the command fails: we check by reading back.
    const saved = await this.find(origin)
    if (result.code !== 0 || !saved || saved.identifier !== identifier) throw new BrowserVaultError('vault_write_failed', 503)
    return saved
  }

  async setBots(originValue, bots) {
    const entry = await this.find(originValue)
    if (!entry) throw new BrowserVaultError('origin_not_found', 404)
    return this.save(entry.origin, entry.identifier, undefined, bots)
  }

  async remove(originValue) {
    const { origin } = originParts(originValue)
    if (!(await this.find(origin))) throw new BrowserVaultError('origin_not_found', 404)
    await this.deleteOrigin(origin)
    if (await this.find(origin)) throw new BrowserVaultError('vault_write_failed', 503)
  }

  async markUsed() {
    // The keychain keeps its own modification date; usage is in the vault log.
  }
}
