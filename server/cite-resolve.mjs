// A citation is not always an absolute path. Bots write `1112.mov`, `video/capcut/1112.mov`,
// or `MEDIA:1112.mov`. Resolve that to one real file inside the video allowlist, or refuse.
// `..` is never folded away. A basename search may return only a unique match.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { expandHome, pathWithin, resolveVideoFile } from './video-stream.mjs'

const CACHE_MAX = 200
const CACHE_TTL_MS = 10 * 60 * 1000
const SEARCH_TIMEOUT_MS = 2000
const WALK_DEPTH = 4
const WALK_DIRS = 4000
const SKIP_DIRS = new Set(['node_modules', '.git', 'Library', 'DerivedData', '.Trash', 'Caches', 'cache'])

const resolutionCache = new Map()
const workspaceCache = new Map()

export function resetCitedCache() {
  resolutionCache.clear()
  workspaceCache.clear()
}

export function hasParentSegment(raw) {
  if (typeof raw !== 'string') return true
  const spellings = [raw]
  try {
    const decoded = decodeURIComponent(raw)
    if (decoded !== raw) spellings.push(decoded)
  } catch {
    // A broken escape is judged as written.
  }
  return spellings.some((text) => text.split(/[\\/]/).includes('..'))
}

function classify(raw) {
  if (typeof raw !== 'string') return 'invalid'
  const text = raw.trim()
  if (!text || text.length > 4096 || /[\u0000-\u001f\u007f]/.test(text)) return 'invalid'
  if (text.startsWith('//') || text.endsWith('/') || text.includes('\\')) return 'invalid'
  const parts = text.split('/')
  if (parts.some((part, index) => part === '..' || part === '.' || (part === '' && index !== 0))) return 'invalid'
  if (text.startsWith('/') || text.startsWith('~/')) return 'absolute'
  if (text.includes('/')) return 'relative'
  return 'basename'
}

function remember(key, value) {
  if (resolutionCache.has(key)) resolutionCache.delete(key)
  resolutionCache.set(key, { at: Date.now(), value })
  while (resolutionCache.size > CACHE_MAX) {
    const oldest = resolutionCache.keys().next().value
    resolutionCache.delete(oldest)
  }
}

function recall(key) {
  const hit = resolutionCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    resolutionCache.delete(key)
    return null
  }
  resolutionCache.delete(key)
  resolutionCache.set(key, hit)
  return hit.value
}

function uniqueByFile(opened) {
  const seen = new Map()
  for (const item of opened) {
    if (item?.ok) seen.set(item.file, item)
  }
  return [...seen.values()]
}

async function tryFile(candidate, roots, { home, fsStat, fsRealpath, types }) {
  if (!candidate || !path.isAbsolute(candidate)) return null
  const opened = await resolveVideoFile(candidate, roots, { home, fsStat, fsRealpath, types })
  return opened.ok ? opened : null
}

function runCapture(command, args, timeoutMs) {
  return new Promise((resolve) => {
    let child
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      finish({ code: -1, out: '', error: error?.code || 'spawn' })
      return
    }
    let out = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ code: -1, out, timedOut: true })
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => {
      if (out.length < 1_000_000) out += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      finish({ code: -1, out: '', error: error?.code || 'spawn' })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish({ code: code ?? -1, out })
    })
  })
}

/**
 * Basename matches inside `roots`. Spotlight first (2s), then a shallow walk of whatever
 * time is left. An unfinished walk with a single hit is not treated as unique.
 */
export async function searchBasename(name, roots, { timeoutMs = SEARCH_TIMEOUT_MS, platform = process.platform, run = runCapture } = {}) {
  const started = Date.now()
  if (!name || name.includes('/') || name.includes('\\') || name.includes('"') || name.includes('..')) return []
  let indexed = null
  if (platform === 'darwin') {
    const query = `kMDItemFSName == "${name}"c`
    const found = []
    let timedOut = false
    let available = false
    await Promise.all(roots.map(async (root) => {
      const result = await run('mdfind', ['-onlyin', root, query], timeoutMs)
      if (result.error === 'ENOENT') return
      available = true
      if (result.timedOut) timedOut = true
      for (const line of String(result.out || '').split('\n')) {
        const text = line.trim()
        if (text && path.basename(text).toLowerCase() === name.toLowerCase()) found.push(text)
      }
    }))
    if (available && !timedOut) indexed = found
  }
  if (indexed?.length) return indexed
  const left = timeoutMs - (Date.now() - started)
  if (left < 50) return indexed || []
  const walked = await walkBasename(name, roots, left)
  if (!walked.complete && walked.matches.length <= 1) return []
  return walked.matches
}

async function walkBasename(name, roots, budgetMs) {
  const deadline = Date.now() + budgetMs
  const matches = []
  const stack = roots.map((dir) => ({ dir, depth: 0 }))
  let visits = 0
  let complete = true
  const wanted = name.toLowerCase()
  while (stack.length) {
    if (Date.now() >= deadline || visits >= WALK_DIRS || matches.length > 1) {
      complete = false
      break
    }
    const { dir, depth } = stack.pop()
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      visits += 1
      if (entry.name.toLowerCase() === wanted && entry.isFile()) matches.push(path.join(dir, entry.name))
      else if (entry.isDirectory() && depth < WALK_DEPTH && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        stack.push({ dir: path.join(dir, entry.name), depth: depth + 1 })
      }
      if (Date.now() >= deadline || visits >= WALK_DIRS || matches.length > 1) {
        complete = false
        break
      }
    }
  }
  return { matches, complete }
}

function terminalCwd(yaml) {
  const lines = String(yaml || '').split('\n')
  let inTerminal = false
  for (const line of lines) {
    if (!inTerminal) {
      if (/^terminal:\s*(?:#.*)?$/.test(line)) inTerminal = true
      continue
    }
    if (/^\S/.test(line)) break
    const match = /^[ \t]+cwd:[ \t]*(.*?)\s*(?:#.*)?$/.exec(line)
    if (!match) continue
    let value = match[1].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    return value.trim()
  }
  return ''
}

function expandWorkspace(raw, home) {
  if (!raw || raw.split(/[\\/]/).includes('..')) return ''
  const expanded = raw === '~' ? home : raw.startsWith('~/') ? path.join(home, raw.slice(2)) : raw
  return path.isAbsolute(expanded) ? path.resolve(expanded) : ''
}

/** Session cwd, then the profile's `terminal.cwd`. Both are optional. */
export function workspacesForProfile(profile, { hermesHome, home, now = Date.now() } = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(profile || '') || !hermesHome) return []
  const key = `${hermesHome}\0${profile}`
  const cached = workspaceCache.get(key)
  if (cached && now - cached.at < 30_000) return cached.list
  const list = []
  const session = sessionCwd(hermesHome, profile)
  const configured = profileCwd(hermesHome, profile, home)
  for (const dir of [session, configured]) {
    if (dir && !list.includes(dir)) list.push(dir)
  }
  workspaceCache.set(key, { at: now, list })
  return list
}

function sessionCwd(hermesHome, profile) {
  const db = path.join(hermesHome, 'state.db')
  if (!existsSync(db)) return ''
  const sql = `SELECT cwd FROM sessions WHERE profile_name = '${profile}' AND IFNULL(archived,0) = 0 AND cwd GLOB '/*' ORDER BY CASE WHEN title = 'Bot Chat' THEN 0 ELSE 1 END, IFNULL(last_activity_at,0) DESC LIMIT 1;`
  let result
  try {
    result = spawnSync('sqlite3', ['-readonly', db, sql], { timeout: 800, encoding: 'utf8' })
  } catch {
    return ''
  }
  if (!result || result.status !== 0) return ''
  const cwd = String(result.stdout || '').trim().split('\n')[0]
  return expandWorkspace(cwd, '')
}

function profileCwd(hermesHome, profile, home) {
  const file = path.join(hermesHome, 'profiles', profile, 'config.yaml')
  let text = ''
  try {
    const info = statSync(file)
    if (!info.isFile() || info.size > 256_000) return ''
    text = readFileSync(file, 'utf8')
  } catch {
    return ''
  }
  return expandWorkspace(terminalCwd(text), home)
}

/**
 * The file a citation names, inside `roots`, or a refusal.
 * Absolute paths use the stream allowlist (`404` when this Mac does not have the file).
 * A relative path is tried in each workspace, then under each root. A basename with no
 * workspace hit is a unique search inside the roots only.
 */
export async function resolveCitedFile(raw, {
  roots,
  home,
  workspaces = [],
  types,
  fsStat = stat,
  fsRealpath = realpath,
  search = searchBasename,
} = {}) {
  if (hasParentSegment(raw)) return { ok: false, status: 400, error: 'invalid_path' }
  const kind = classify(raw)
  if (kind === 'invalid') return { ok: false, status: 400, error: 'invalid_path' }
  const rootList = (Array.isArray(roots) ? roots : []).map((root) => path.resolve(root))
  if (kind === 'absolute') return resolveVideoFile(raw, rootList, { home, fsStat, fsRealpath, types })

  const text = raw.trim()
  const extension = path.extname(text).slice(1).toLowerCase()
  if (!types?.[extension]) return { ok: false, status: 415, error: 'unsupported_media' }
  const cacheKey = `${text}\0${workspaces.join('\0')}\0${rootList.join('\0')}\0${extension}`
  const cached = recall(cacheKey)
  if (cached) {
    if (!cached.ok) return cached
    const fresh = await tryFile(cached.file, rootList, { home, fsStat, fsRealpath, types })
    if (fresh && fresh.size === cached.size && fresh.mtimeMs === cached.mtimeMs) return fresh
  }

  const open = (candidate) => tryFile(candidate, rootList, { home, fsStat, fsRealpath, types })
  for (const workspace of workspaces) {
    if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) continue
    const opened = await open(path.resolve(workspace, text))
    if (opened) {
      remember(cacheKey, opened)
      return opened
    }
  }

  if (kind === 'relative') {
    const hits = []
    for (const root of rootList) {
      const candidate = path.resolve(root, text)
      if (!pathWithin(root, candidate)) continue
      const opened = await open(candidate)
      if (opened) hits.push(opened)
    }
    const unique = uniqueByFile(hits)
    const result = unique.length === 1 ? unique[0] : { ok: false, status: 404, error: 'media_not_found' }
    remember(cacheKey, result)
    return result
  }

  const direct = []
  for (const root of rootList) {
    const opened = await open(path.join(root, text))
    if (opened) direct.push(opened)
  }
  const directUnique = uniqueByFile(direct)
  if (directUnique.length === 1) {
    remember(cacheKey, directUnique[0])
    return directUnique[0]
  }
  if (directUnique.length > 1) {
    const result = { ok: false, status: 404, error: 'media_not_found' }
    remember(cacheKey, result)
    return result
  }

  let found = []
  try {
    found = await search(text, rootList)
  } catch {
    found = []
  }
  const hits = []
  for (const candidate of Array.isArray(found) ? found : []) {
    const opened = await open(candidate)
    if (opened) hits.push(opened)
  }
  const unique = uniqueByFile(hits)
  const result = unique.length === 1 ? unique[0] : { ok: false, status: 404, error: 'media_not_found' }
  remember(cacheKey, result)
  return result
}
