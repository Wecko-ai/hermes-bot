// Local video for a bot message. The file stays on this machine: Range responses, an allowlist of
// folders, and no path that resolves outside them (including through a symlink). A file that is not
// here is not opened; the caller relays that path to the gateway, which is how a desktop app on
// another Mac plays a render that lives on the server Mac.
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const VIDEO_CONTENT_TYPES = {
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  webm: 'video/webm',
}

const RANGE = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i

/** Folders a bot actually writes renders and media into. Override with config `videoRoots` or `HERMESBOT_VIDEO_ROOTS`. */
export function defaultVideoRoots(home) {
  return [
    path.join(home, 'projects'),
    path.join(home, 'Movies'),
    path.join(home, 'bots-workspace'),
    path.join(home, '.hermes', 'images'),
    path.join(home, '.hermes', 'cache'),
    path.join(home, '.hermes', 'profiles'),
  ]
}

export function expandHome(raw, home) {
  if (raw === '~') return home
  if (raw.startsWith('~/')) return path.join(home, raw.slice(2))
  return raw
}

/** Absolute folder prefixes. Empty or invalid entries are dropped. An empty result is the default list. */
export function videoRootList(value, env, home) {
  const fromEnv = typeof env.HERMESBOT_VIDEO_ROOTS === 'string'
    ? env.HERMESBOT_VIDEO_ROOTS.split(path.delimiter)
    : []
  const configured = [...fromEnv, ...(Array.isArray(value) ? value : [])]
  const cleaned = []
  for (const item of configured) {
    if (typeof item !== 'string') continue
    const expanded = expandHome(item.trim(), home)
    if (!expanded || expanded.length > 4096 || expanded.includes('\0') || !path.isAbsolute(expanded)) continue
    if (expanded.split(/[\\/]/).some((part) => part === '.' || part === '..')) continue
    cleaned.push(path.resolve(expanded))
    if (cleaned.length >= 32) break
  }
  return cleaned.length ? cleaned : defaultVideoRoots(home)
}

export function pathWithin(root, file) {
  const relative = path.relative(root, file)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

/**
 * One `Range` header against a file of `size` bytes.
 * No header, several ranges, or a unit this does not read: the whole file (not partial).
 * A range the file cannot satisfy: `{ unsatisfiable: true }`.
 * Otherwise `{ start, end, partial }` with `end` inclusive, matching Node's `createReadStream`.
 */
export function parseByteRange(header, size) {
  const total = Number.isSafeInteger(size) && size >= 0 ? size : 0
  const whole = () => (total === 0 ? { start: 0, end: -1, partial: false } : { start: 0, end: total - 1, partial: false })
  if (header == null || header === '') return whole()
  if (typeof header !== 'string' || header.includes(',')) return whole()
  const match = RANGE.exec(header)
  if (!match || (match[1] === '' && match[2] === '')) return whole()
  if (match[1] === '') {
    if (match[2].length > 15) return { unsatisfiable: true, size: total }
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || total === 0) return { unsatisfiable: true, size: total }
    return { start: Math.max(total - suffix, 0), end: total - 1, partial: true }
  }
  if (match[1].length > 15 || (match[2] && match[2].length > 15)) return { unsatisfiable: true, size: total }
  const start = Number(match[1])
  const endRaw = match[2] === '' ? total - 1 : Number(match[2])
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endRaw)) return whole()
  if (match[2] !== '' && endRaw < start) return whole()
  if (start >= total) return { unsatisfiable: true, size: total }
  return { start, end: Math.min(endRaw, total - 1), partial: true }
}

function rejectPath(raw) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 4096 || /[\u0000-\u001f\u007f]/.test(raw)) return 'invalid_path'
  const text = raw.trim()
  if (!(text.startsWith('/') || text.startsWith('~/')) || text.startsWith('//') || text.endsWith('/')) return 'invalid_path'
  if (text.split(/[\\/]/).some((part) => part === '.' || part === '..')) return 'invalid_path'
  return ''
}

/**
 * The file to stream, or a refusal. `status === 404` means it is not on this machine (relay it).
 * An existing file outside the allowlist, or a symlink whose target leaves the allowlist, is 403.
 */
export async function resolveVideoFile(rawPath, roots, { home = os.homedir(), fsStat = stat, fsRealpath = realpath } = {}) {
  const invalid = rejectPath(rawPath)
  if (invalid) return { ok: false, status: 400, error: invalid }
  const expanded = path.resolve(expandHome(rawPath.trim(), home))
  const rootList = (Array.isArray(roots) ? roots : []).map((root) => path.resolve(root))
  const listed = rootList.some((root) => pathWithin(root, expanded))
  let info
  try {
    info = await fsStat(expanded)
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, status: 404, error: 'media_not_found' }
    return { ok: false, status: 403, error: 'media_forbidden' }
  }
  if (!listed) return { ok: false, status: 403, error: 'media_forbidden' }
  let real
  try {
    real = await fsRealpath(expanded)
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, status: 404, error: 'media_not_found' }
    return { ok: false, status: 403, error: 'media_forbidden' }
  }
  const realRoots = []
  for (const root of rootList) {
    try {
      realRoots.push(await fsRealpath(root))
    } catch {
      // A missing root cannot contain the file.
    }
  }
  if (!realRoots.some((root) => pathWithin(root, real))) return { ok: false, status: 403, error: 'media_forbidden' }
  let realInfo
  try {
    realInfo = await fsStat(real)
  } catch {
    return { ok: false, status: 403, error: 'media_forbidden' }
  }
  if (!realInfo.isFile()) return { ok: false, status: 403, error: 'media_forbidden' }
  const contentType = VIDEO_CONTENT_TYPES[path.extname(real).slice(1).toLowerCase()]
  if (!contentType) return { ok: false, status: 415, error: 'unsupported_media' }
  return { ok: true, file: real, size: realInfo.size, contentType }
}

/** What `/api/video` does once the path has been resolved. A missing file is relayed; anything refused is not. */
export function videoRouteDecision({ authed, opened }) {
  if (!authed) return { action: 'deny', status: 401, error: 'unauthenticated' }
  if (opened?.ok) return { action: 'serve' }
  if (opened?.status === 404) return { action: 'relay' }
  return { action: 'deny', status: opened?.status || 400, error: opened?.error || 'invalid_path' }
}

function inlineName(file) {
  return path.basename(file).replace(/["\r\n\\]/g, '') || 'video'
}

/** GET/HEAD with Range. `opened` is the result of `resolveVideoFile`. */
export function serveVideoFile(request, response, opened) {
  const method = request.method === 'HEAD' ? 'HEAD' : 'GET'
  const range = parseByteRange(request.headers?.range || request.headers?.Range, opened.size)
  if (range.unsatisfiable) {
    response.writeHead(416, {
      'Content-Type': opened.contentType,
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes */${range.size}`,
      'X-Content-Type-Options': 'nosniff',
    })
    return response.end()
  }
  const length = range.end >= range.start ? range.end - range.start + 1 : 0
  const headers = {
    'Content-Type': opened.contentType,
    'Content-Length': String(length),
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `inline; filename="${inlineName(opened.file)}"`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
  }
  if (range.partial) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${opened.size}`
  response.writeHead(range.partial ? 206 : 200, headers)
  if (method === 'HEAD' || length === 0) return response.end()
  const stream = createReadStream(opened.file, { start: range.start, end: range.end })
  stream.on('error', () => {
    if (!response.writableEnded) response.destroy()
  })
  stream.pipe(response)
}
