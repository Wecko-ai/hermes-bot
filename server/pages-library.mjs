import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const PROFILE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const TITLE = /^[\s\S]{1,128}$/
const FILE = /^[\s\S]{1,4096}$/

function safeName(value) {
  return String(value || '').replace(/[^\w.-]+/g, '_').slice(0, 120) || 'page'
}

export class PagesLibrary {
  constructor(root) {
    this.root = root
  }

  profileDir(profile) {
    if (!PROFILE.test(profile)) throw new Error('invalid_profile')
    return path.join(this.root, profile)
  }

  indexPath(profile) {
    return path.join(this.profileDir(profile), 'index.json')
  }

  async ensureProfile(profile) {
    await fs.mkdir(this.profileDir(profile), { recursive: true })
  }

  async readAll(profile) {
    await this.ensureProfile(profile)
    try {
      const raw = JSON.parse(await fs.readFile(this.indexPath(profile), 'utf8'))
      return Array.isArray(raw) ? raw : []
    } catch {
      return []
    }
  }

  async list(profile, { query = '', archived = false } = {}) {
    const items = await this.readAll(profile)
    const q = String(query || '').trim().toLowerCase()
    return items
      .filter((item) => item && typeof item === 'object' && item.archived === archived)
      .filter((item) => !q || String(item.title || item.name || '').toLowerCase().includes(q) || String(item.path || '').toLowerCase().includes(q))
      .sort((a, b) => String(b.openedAt || '').localeCompare(String(a.openedAt || '')))
  }

  async write(profile, items) {
    await this.ensureProfile(profile)
    await fs.writeFile(this.indexPath(profile), JSON.stringify(items, null, 2), { mode: 0o600 })
  }

  async touch({ profile, filePath, title, name }) {
    if (!FILE.test(filePath || '')) throw new Error('invalid_path')
    const now = new Date().toISOString()
    const all = await this.readAll(profile)
    const existing = all.find((item) => item.path === filePath)
  if (existing) {
      const next = all.map((item) => item.id === existing.id ? { ...item, openedAt: now, title: title || item.title, name: name || item.name } : item)
      await this.write(profile, next)
      return existing.id
    }
    const entry = {
      id: randomUUID(),
      profile,
      path: filePath,
      name: safeName(name || path.basename(filePath)),
      title: TITLE.test(title || '') ? title.trim() : safeName(name || path.basename(filePath)),
      openedAt: now,
      archived: false,
    }
    await this.write(profile, [...all, entry])
    return entry.id
  }

  async rename(profile, id, title) {
    if (!TITLE.test(title || '')) throw new Error('invalid_title')
    const all = await this.readAll(profile)
    if (!all.some((item) => item.id === id)) throw new Error('not_found')
    const next = all.map((item) => item.id === id ? { ...item, title: title.trim() } : item)
    await this.write(profile, next)
  }

  async archive(profile, id) {
    const all = await this.readAll(profile)
    if (!all.some((item) => item.id === id)) throw new Error('not_found')
    const next = all.map((item) => item.id === id ? { ...item, archived: true, archivedAt: new Date().toISOString() } : item)
    await this.write(profile, next)
  }
}