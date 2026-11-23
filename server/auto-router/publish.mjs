import { copyFile, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

// The iPhone talks to the Hermes gateway, which has no Auto routes. It already reads
// ~/.hermes/hermesbot-settings.json through the gateway's file API. Publishing the capability
// there is how Auto shows up away from the desktop server (127.0.0.1:4330).
export const PUBLISHED_TABLE_PATH = '~/.hermes/hermesbot-auto-router.table.json'
export const PUBLISHED_TABLE_NAME = 'hermesbot-auto-router.table.json'

/** What the shared file should say. The table path is the copy under the Hermes home, never the private source. */
export function publicAutoRouter(autoRouter, { tablePublished = false } = {}) {
  if (autoRouter?.enabled !== true) return { enabled: false }
  return tablePublished ? { enabled: true, tablePath: PUBLISHED_TABLE_PATH } : { enabled: true }
}

export function publishedTableFile(hermesHome) {
  return path.join(hermesHome, PUBLISHED_TABLE_NAME)
}

export async function publishedTableReady(hermesHome, statImpl = stat) {
  if (!hermesHome || !path.isAbsolute(hermesHome)) return false
  try {
    const info = await statImpl(publishedTableFile(hermesHome))
    return info.isFile() && info.size > 0
  } catch {
    return false
  }
}

/**
 * Writes `autoRouter` into the shared settings file and, when Auto is on, copies the scoring table
 * next to it. Other keys (hidden models, compaction) stay. A file that is not a JSON object is left
 * untouched. Returns without throwing when the home cannot be used.
 */
export async function publishAutoRouterFiles({
  hermesHome,
  autoRouter,
  sourceTablePath = '',
  readFileImpl = readFile,
  writeFileImpl = writeFile,
  copyFileImpl = copyFile,
} = {}) {
  if (!hermesHome || !path.isAbsolute(hermesHome)) return { ok: false, reason: 'no_home' }
  const settingsPath = path.join(hermesHome, 'hermesbot-settings.json')
  let tablePublished = false
  if (autoRouter?.enabled === true && sourceTablePath && path.isAbsolute(sourceTablePath)) {
    try {
      await copyFileImpl(sourceTablePath, publishedTableFile(hermesHome))
      tablePublished = true
    } catch {
      tablePublished = false
    }
  }
  const published = publicAutoRouter(autoRouter, { tablePublished })
  let existing = ''
  try {
    existing = await readFileImpl(settingsPath, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') return { ok: false, reason: 'unreadable' }
  }
  let parsed = {}
  if (existing.trim()) {
    try {
      parsed = JSON.parse(existing)
    } catch {
      return { ok: false, reason: 'unreadable', tablePublished }
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'unreadable', tablePublished }
  }
  if (JSON.stringify(parsed.autoRouter ?? null) === JSON.stringify(published)) {
    return { ok: true, changed: false, tablePublished }
  }
  parsed.autoRouter = published
  if (parsed.version == null) parsed.version = 1
  try {
    await writeFileImpl(settingsPath, `${JSON.stringify(parsed, null, 2)}\n`)
  } catch {
    return { ok: false, reason: 'unwritable', tablePublished }
  }
  return { ok: true, changed: true, tablePublished }
}
