// Shared memory: four typed Markdown files (profile, rules, people, workstreams) stored on this machine.
// Bots can read them through an optional skill; the app may inject a short summary into api_text per turn.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const MEMORY_TYPES = ['profile', 'rules', 'people', 'workstreams']
export const MEMORY_FILES = {
  profile: 'profile.md',
  rules: 'rules.md',
  people: 'people.md',
  workstreams: 'workstreams.md',
}
export const MEMORY_BODY_MAX_BYTES = 256 * 1024
export const MEMORY_ENTRY_MAX_BYTES = 32 * 1024
export const MEMORY_SEARCH_MAX = 200

const TYPE_SET = new Set(MEMORY_TYPES)
const META_RE = /<!--\s*memory:\s*([^|]+)\|\s*source:\s*([^>]+)\s*-->/i
const HEADING_RE = /^##\s+(.+)$/m

export function memoryType(value) {
  return typeof value === 'string' && TYPE_SET.has(value) ? value : null
}

export function memoryDir(configured, dataDir) {
  const candidate = typeof configured === 'string' ? configured.trim() : ''
  if (candidate && path.isAbsolute(candidate)) return candidate
  return path.join(dataDir, 'shared-memory')
}

export function filePath(dir, type) {
  return path.join(dir, MEMORY_FILES[type])
}

/** Default file header when a store is first created. */
export function defaultFileText(type) {
  const titles = { profile: 'Profile', rules: 'Rules', people: 'People and organizations', workstreams: 'Workstreams' }
  return `# ${titles[type]}\n\n`
}

export async function ensureStore(dir) {
  await mkdir(dir, { recursive: true })
  for (const type of MEMORY_TYPES) {
    const target = filePath(dir, type)
    try {
      await readFile(target, 'utf8')
    } catch {
      await writeFile(target, defaultFileText(type), 'utf8')
    }
  }
}

/** Parses one memory file into structured entries. */
export function parseMemoryFile(text, type) {
  const source = String(text || '')
  const entries = []
  const chunks = source.split(/\n(?=##\s+)/)
  for (const chunk of chunks) {
    const titleMatch = chunk.match(/^##\s+(.+)$/m)
    if (!titleMatch) continue
    const title = titleMatch[1].trim().slice(0, 200)
    const id = slugId(title)
    const metaMatch = chunk.match(META_RE)
    const date = metaMatch ? metaMatch[1].trim().slice(0, 64) : ''
    const entrySource = metaMatch ? metaMatch[2].trim().slice(0, 120) : ''
    const body = chunk
      .replace(/^##\s+.+$/m, '')
      .replace(META_RE, '')
      .trim()
    entries.push({ id, title, date, source: entrySource, body, type })
  }
  return { type, text: source, entries }
}

export function slugId(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'entry'
}

export function formatEntry({ title, date, source, body }) {
  const when = date || new Date().toISOString()
  const from = source || 'user'
  return `## ${title}\n<!-- memory: ${when} | source: ${from} -->\n${String(body || '').trim()}\n`
}

export function upsertEntry(text, entry) {
  const parsed = parseMemoryFile(text, entry.type)
  const next = parsed.entries.filter((item) => item.id !== entry.id)
  next.push({ ...entry, body: String(entry.body || '').trim() })
  const header = String(text || '').split(/\n(?=##\s+)/)[0].trimEnd()
  const body = next.map((item) => formatEntry(item)).join('\n')
  return header.endsWith('#') ? `${header}\n\n${body}\n` : `${header}\n\n${body}\n`
}

export function removeEntry(text, id) {
  const parsed = parseMemoryFile(text, '')
  const kept = parsed.entries.filter((item) => item.id !== id)
  const header = String(text || '').split(/\n(?=##\s+)/)[0].trimEnd()
  const body = kept.map((item) => formatEntry(item)).join('\n')
  return body ? `${header}\n\n${body}\n` : `${header}\n\n`
}

export function searchEntries(filesByType, query, limit = MEMORY_SEARCH_MAX) {
  const needle = String(query || '').trim().toLowerCase()
  if (!needle) return []
  const hits = []
  for (const type of MEMORY_TYPES) {
    const parsed = parseMemoryFile(filesByType[type] || '', type)
    for (const entry of parsed.entries) {
      const hay = `${entry.title}\n${entry.body}`.toLowerCase()
      if (hay.includes(needle)) hits.push(entry)
      if (hits.length >= limit) return hits
    }
  }
  return hits
}

/** Short plain-text summary for one-turn api_text injection (English; the model's working language). */
export function summarizeForTurn(filesByType, maxChars = 2000) {
  const lines = ['[HermesBot shared memory (this turn only). Facts below are shared across bots; do not repeat them back unless asked.]']
  for (const type of MEMORY_TYPES) {
    const parsed = parseMemoryFile(filesByType[type] || '', type)
  if (!parsed.entries.length) continue
    lines.push(`\n${type}:`)
    for (const entry of parsed.entries.slice(0, 12)) {
      const snippet = entry.body.replace(/\s+/g, ' ').trim().slice(0, 220)
      lines.push(`- ${entry.title}: ${snippet}`)
    }
  }
  const text = lines.join('\n')
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`
}