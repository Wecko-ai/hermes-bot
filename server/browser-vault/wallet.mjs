/**
 * Cards and addresses in the session keychain (generic passwords). Card numbers are the secret;
 * only last4 is ever returned to the app UI or bots.
 */
import { randomUUID } from 'node:crypto'
import { BrowserVaultError } from './errors.mjs'
import { defaultKeychain, parseKeychainItems, quote, runSecurity, validBots, botAllowed } from './keychain.mjs'

const WALLET_SERVICE = 'HermesBot Wallet'
const CREATOR = 'HBot'
const ID = /^[a-z0-9-]{8,64}$/
const LAST4 = /^\d{4}$/
const EXPIRY = /^(0[1-9]|1[0-2])\/\d{2}$/
const CONTROL = /[\u0000-\u001f\u007f]/

function record(comment) {
  try {
    const value = JSON.parse(comment || '{}')
    if (value.type !== 'card' && value.type !== 'address') return null
    const bots = Array.isArray(value.bots) && value.bots.length ? value.bots : ['*']
    return { ...value, bots }
  } catch {
    return null
  }
}

function sanitizeText(value, max) {
  if (typeof value !== 'string' || !value || value.length > max || CONTROL.test(value)) throw new BrowserVaultError('invalid_credentials', 400)
  return value.trim()
}

function cardDigits(value) {
  const digits = String(value || '').replace(/\D/g, '')
  if (digits.length < 12 || digits.length > 19) throw new BrowserVaultError('invalid_credentials', 400)
  return digits
}

export class WalletStore {
  constructor({ keychain = defaultKeychain(), run = runSecurity } = {}) {
    this.keychain = keychain
    this.run = run
    /** @type {Map<string, { meta: object, secret?: string }>} */
    this.memory = null
  }

  useMemory() {
    this.memory = new Map()
    return this
  }

  get available() {
    return this.memory || process.platform === 'darwin' || this.run !== runSecurity
  }

  async items() {
    if (this.memory) return [...this.memory.entries()].map(([id, { meta }]) => ({ id, ...meta }))
    const result = await this.run(['dump-keychain', this.keychain])
    if (result.code !== 0) throw new BrowserVaultError('vault_unavailable', 503)
    return parseKeychainItems(result.stdout)
      .filter((item) => item.class === 'genp' && item.attributes.crtr === CREATOR && item.attributes.svce === WALLET_SERVICE)
      .map((item) => {
        const meta = record(item.attributes.icmt)
        if (!meta) return null
        const id = item.attributes.acct || ''
        if (!ID.test(id)) return null
        return { id, ...meta, updatedAt: item.attributes.mdate || item.attributes.cdate || null }
      })
      .filter(Boolean)
  }

  async list(bot) {
    return (await this.items())
      .map((entry) => {
        if (entry.type === 'card') {
          return {
            id: entry.id,
            type: 'card',
            label: entry.label || '',
            holder: entry.holder || '',
            last4: entry.last4 || '',
            expiry: entry.expiry || '',
            bots: entry.bots,
            updatedAt: entry.updatedAt || null,
          }
        }
        return {
          id: entry.id,
          type: 'address',
          label: entry.label || '',
          line1: entry.line1 || '',
          line2: entry.line2 || '',
          city: entry.city || '',
          region: entry.region || '',
          postal: entry.postal || '',
          country: entry.country || '',
          bots: entry.bots,
          updatedAt: entry.updatedAt || null,
        }
      })
      .filter((entry) => !bot || botAllowed(entry, bot))
      .sort((a, b) => (a.label || a.id).localeCompare(b.label || b.id))
  }

  async remove(id) {
    if (!ID.test(id)) throw new BrowserVaultError('invalid_credentials', 400)
    if (this.memory) {
      if (!this.memory.delete(id)) throw new BrowserVaultError('origin_not_found', 404)
      return
    }
    const result = await this.run(['delete-generic-password', '-s', quote(WALLET_SERVICE), '-a', quote(id), quote(this.keychain)])
    if (result.code !== 0) throw new BrowserVaultError('origin_not_found', 404)
  }

  async saveCard({ holder, number, expiry, label, bots }) {
    const accountHolder = sanitizeText(holder, 128)
    const digits = cardDigits(number)
    const last4 = digits.slice(-4)
    if (!EXPIRY.test(String(expiry || ''))) throw new BrowserVaultError('invalid_credentials', 400)
    const title = sanitizeText(label || `${accountHolder} ·••• ${last4}`, 128)
    const allowed = validBots(bots)
    const id = randomUUID()
    const meta = { type: 'card', holder: accountHolder, last4, expiry: String(expiry), label: title, bots: allowed }
    if (this.memory) {
      this.memory.set(id, { meta, secret: digits })
      return { id, type: 'card', label: title, holder: accountHolder, last4, expiry: meta.expiry, bots: allowed, ref: `hbvault:card:${id}` }
    }
    const command = [
      'add-generic-password',
      '-s', quote(WALLET_SERVICE),
      '-a', quote(id),
      '-l', quote(title),
      '-c', CREATOR,
      '-j', quote(JSON.stringify(meta)),
      '-T', '/usr/bin/security',
      '-w', quote(digits),
      quote(this.keychain),
    ].join(' ')
    const written = await this.run(['-i'], `${command}\n`)
    if (written.code !== 0) throw new BrowserVaultError('vault_write_failed', 503)
    return { id, type: 'card', label: title, holder: accountHolder, last4, expiry: meta.expiry, bots: allowed, ref: `hbvault:card:${id}` }
  }

  async saveAddress({ label, line1, line2, city, region, postal, country, bots }) {
    const title = sanitizeText(label, 128)
    const payload = {
      type: 'address',
      label: title,
      line1: sanitizeText(line1, 256),
      line2: line2 ? sanitizeText(line2, 256) : '',
      city: sanitizeText(city, 128),
      region: region ? sanitizeText(region, 128) : '',
      postal: sanitizeText(postal, 32),
      country: sanitizeText(country, 64),
      bots: validBots(bots),
    }
    const id = randomUUID()
    if (this.memory) {
      this.memory.set(id, { meta: payload, secret: '' })
      return { id, ...payload, ref: `hbvault:address:${id}` }
    }
    const command = [
      'add-generic-password',
      '-s', quote(WALLET_SERVICE),
      '-a', quote(id),
      '-l', quote(title),
      '-c', CREATOR,
      '-j', quote(JSON.stringify(payload)),
      '-T', '/usr/bin/security',
      '-w', quote('-'),
      quote(this.keychain),
    ].join(' ')
    const written = await this.run(['-i'], `${command}\n`)
    if (written.code !== 0) throw new BrowserVaultError('vault_write_failed', 503)
    return { id, ...payload, ref: `hbvault:address:${id}` }
  }

  /** Stores secure-form fields; returns vault references only. */
  async storeSecureForm(fields, bots) {
    const refs = []
    const allowed = validBots(bots)
    for (const field of fields) {
      if (!field || typeof field !== 'object') continue
      const kind = field.kind || field.type
      const key = typeof field.key === 'string' ? field.key : ''
      if (!key) continue
      if (kind === 'card') {
        refs.push(await this.saveCard({
          holder: field.holder || 'Cardholder',
          number: String(field.value ?? ''),
          expiry: field.expiry || '01/99',
          label: field.label || key,
          bots: allowed,
        }))
      } else if (kind === 'address') {
        const value = field.value && typeof field.value === 'object' ? field.value : {}
        refs.push(await this.saveAddress({ label: field.label || key, ...value, bots: allowed }))
      }
    }
    return refs.map(({ ref, id, type, last4, label }) => ({ ref, id, type, last4, label }))
  }
}
