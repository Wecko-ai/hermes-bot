import { randomUUID } from 'node:crypto'
import { BrowserVaultError, vaultError } from './errors.mjs'

/** Origine exacte : protocole, hôte IDN normalisé et port effectif. */
export function normalizeOrigin(value) {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('unsupported')
    return url.origin
  } catch {
    throw new BrowserVaultError('invalid_origin', 400)
  }
}

function validEntry(value) {
  return value && typeof value.id === 'string' && typeof value.origin === 'string'
    && typeof value.identifier === 'string' && typeof value.password === 'string'
}

export class BrowserVaultStore {
  constructor(persistence) {
    this.persistence = persistence || null
    this.entries = null
  }

  get available() {
    return Boolean(this.persistence)
  }

  load() {
    if (!this.persistence) throw new BrowserVaultError('vault_unavailable', 503)
    if (this.entries) return this.entries
    try {
      const raw = this.persistence.load() || ''
      const parsed = raw ? JSON.parse(raw) : []
      if (!Array.isArray(parsed) || parsed.some((entry) => !validEntry(entry))) {
        throw new BrowserVaultError('vault_corrupt', 503)
      }
      this.entries = parsed.map((entry) => ({ ...entry, origin: normalizeOrigin(entry.origin) }))
      return this.entries
    } catch (error) {
      throw vaultError(error, 'vault_unavailable', 503)
    }
  }

  persist() {
    if (!this.persistence) throw new BrowserVaultError('vault_unavailable', 503)
    try {
      this.persistence.save(JSON.stringify(this.entries))
    } catch {
      throw new BrowserVaultError('vault_write_failed', 503)
    }
  }

  list() {
    return this.load().map((entry) => ({
      id: entry.id,
      origin: entry.origin,
      identifier: entry.identifier,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      lastUsedAt: entry.lastUsedAt || null,
    })).sort((a, b) => a.origin.localeCompare(b.origin))
  }

  save(originValue, identifier, password) {
    const origin = normalizeOrigin(originValue)
    if (typeof identifier !== 'string' || !identifier || identifier.length > 1024
      || typeof password !== 'string' || !password || password.length > 4096) {
      throw new BrowserVaultError('invalid_credentials', 400)
    }
    const entries = this.load()
    const now = new Date().toISOString()
    const previous = entries.find((entry) => entry.origin === origin)
    const entry = {
      id: previous?.id || randomUUID(),
      origin,
      identifier,
      password,
      createdAt: previous?.createdAt || now,
      updatedAt: now,
      lastUsedAt: previous?.lastUsedAt || null,
    }
    this.entries = [...entries.filter((item) => item.origin !== origin), entry]
    try {
      this.persist()
    } catch (error) {
      this.entries = entries
      throw error
    }
    return this.list().find((item) => item.id === entry.id)
  }

  get(originValue) {
    const origin = normalizeOrigin(originValue)
    const entry = this.load().find((item) => item.origin === origin)
    if (!entry) throw new BrowserVaultError('origin_not_found', 404)
    return { ...entry }
  }

  markUsed(originValue) {
    const origin = normalizeOrigin(originValue)
    const entries = this.load()
    this.entries = entries.map((entry) => entry.origin === origin
      ? { ...entry, lastUsedAt: new Date().toISOString() }
      : entry)
    try {
      this.persist()
    } catch (error) {
      this.entries = entries
      throw error
    }
  }
}
