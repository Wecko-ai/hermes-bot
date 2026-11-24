// One file per conversation, plus the sidebar, the last selection, pending sends and host capabilities.
// Same idea as a main-process replica store: the renderer paints the file, then the gateway rewrites it.
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const REPLICA_MESSAGES = 200
export const CACHE_MAX_BYTES = 50 * 1024 * 1024
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const JOURNAL_CAP = 20

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function createConvCache(dir, { maxBytes = CACHE_MAX_BYTES, now = () => Date.now() } = {}) {
  const replicas = path.join(dir, 'replicas')

  async function ensure() {
    await mkdir(replicas, { recursive: true, mode: 0o700 })
  }

  async function writeJson(file, value) {
    await ensure()
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(value), { mode: 0o600 })
    await rename(tmp, file)
  }

  function replicaFile(profile) {
    if (typeof profile !== 'string' || !PROFILE.test(profile)) return ''
    return path.join(replicas, `${profile}.json`)
  }

  async function evict() {
    const names = await readdir(replicas).catch(() => [])
    const files = []
    let total = 0
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const file = path.join(replicas, name)
      const info = await stat(file).catch(() => null)
      if (!info?.isFile()) continue
      total += info.size
      files.push({ file, size: info.size, mtime: info.mtimeMs })
    }
    files.sort((a, b) => a.mtime - b.mtime)
    while (total > maxBytes && files.length > 1) {
      const oldest = files.shift()
      await rm(oldest.file, { force: true })
      total -= oldest.size
    }
    return total
  }

  return {
    async boot(profile = '') {
      const [roster, selection, capabilities, journal] = await Promise.all([
        readJson(path.join(dir, 'roster.json'), []),
        readJson(path.join(dir, 'selection.json'), null),
        readJson(path.join(dir, 'capabilities.json'), {}),
        readJson(path.join(dir, 'journal.json'), []),
      ])
      const selected = typeof selection?.profile === 'string' ? selection.profile : ''
      const wanted = profile || selected
      return {
        selection: selected,
        roster: Array.isArray(roster) ? roster : [],
        capabilities: capabilities && typeof capabilities === 'object' ? capabilities : {},
        journal: Array.isArray(journal) ? journal : [],
        replica: wanted ? await this.replica(wanted) : null,
      }
    },

    async replica(profile) {
      const file = replicaFile(profile)
      if (!file) return null
      const value = await readJson(file, null)
      if (!value || value.profile !== profile || !Array.isArray(value.messages)) return null
      return value
    },

    async saveReplica(replica) {
      const file = replicaFile(replica?.profile)
      if (!file) return false
      const messages = replica.messages.slice(-REPLICA_MESSAGES)
      await writeJson(file, {
        v: 1,
        profile: replica.profile,
        sessionId: typeof replica.sessionId === 'string' ? replica.sessionId : '',
        revision: typeof replica.revision === 'string' ? replica.revision : '',
        lastId: Number.isInteger(replica.lastId) ? replica.lastId : 0,
        lastTime: typeof replica.lastTime === 'string' ? replica.lastTime : '',
        title: typeof replica.title === 'string' ? replica.title : 'Bot Chat',
        model: typeof replica.model === 'string' ? replica.model : '',
        usage: replica.usage && typeof replica.usage === 'object' ? replica.usage : null,
        hasOlder: replica.hasOlder === true || replica.messages.length > messages.length,
        messages,
        scroll: replica.scroll && typeof replica.scroll === 'object' ? replica.scroll : { stick: true },
        savedAt: now(),
      })
      await evict()
      return true
    },

    async saveRoster(roster) {
      if (!Array.isArray(roster)) return false
      await writeJson(path.join(dir, 'roster.json'), roster)
      return true
    },

    async saveSelection(profile) {
      if (profile && !PROFILE.test(profile)) return false
      await writeJson(path.join(dir, 'selection.json'), { profile: profile || '', savedAt: now() })
      return true
    },

    async saveCapabilities(capabilities) {
      if (!capabilities || typeof capabilities !== 'object') return false
      await writeJson(path.join(dir, 'capabilities.json'), capabilities)
      return true
    },

    async saveJournal(journal) {
      if (!Array.isArray(journal)) return false
      await writeJson(path.join(dir, 'journal.json'), journal.slice(-JOURNAL_CAP))
      return true
    },

    evict,
  }
}
