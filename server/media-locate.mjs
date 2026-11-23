// Turn a basename or relative citation into a path the media routes can open.
// Candidates come from the turn (absolute paths the bot already wrote) and one workspace.
import path from 'node:path'

const MEDIA_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'heif',
  'mp4', 'm4v', 'mov', 'webm',
  'mp3', 'm4a', 'wav', 'ogg', 'opus', 'flac',
  'pdf',
])

export function mediaExtension(file) {
  return path.posix.extname(String(file || '')).slice(1).toLowerCase()
}

export function isLocateName(name) {
  if (typeof name !== 'string') return false
  const text = name.trim()
  if (!text || text.length > 4096 || /[\u0000-\u001f\u007f]/.test(text)) return false
  if (text.startsWith('/') || text.startsWith('~/') || text.startsWith('//')) return false
  if (text.split(/[\\/]/).some((part) => !part || part === '.' || part === '..')) return false
  return MEDIA_EXT.has(mediaExtension(text))
}

function basenameOf(file) {
  return path.posix.basename(String(file).replace(/\\/g, '/'))
}

/** Absolute hints that name this file, then `workspace/name` when a workspace is known. */
export function locateCandidates(name, hints, workspace) {
  const wanted = name.trim().replace(/^\.\//, '')
  const base = basenameOf(wanted)
  const relative = wanted.includes('/')
  const found = []
  const add = (file) => {
    if (typeof file !== 'string') return
    const text = file.trim()
    if (!(text.startsWith('/') || text.startsWith('~/')) || text.includes('\0')) return
    if (text.split('/').some((part) => part === '.' || part === '..')) return
    const hit = relative ? text.endsWith(`/${wanted}`) : basenameOf(text) === base
    if (hit && !found.includes(text)) found.push(text)
  }
  for (const hint of Array.isArray(hints) ? hints : []) add(hint)
  if (typeof workspace === 'string' && (workspace.startsWith('/') || workspace.startsWith('~/'))) {
    const root = workspace.replace(/\/+$/, '')
    add(`${root}/${wanted}`)
  }
  return found
}

/**
 * What to do with one candidate after a local lookup.
 * `opened` is a `resolveVideoFile` result. Images are not read locally: `ask`.
 */
export function locateStep(opened, { remote = false } = {}) {
  if (remote) return { action: 'ask' }
  if (opened?.ok) return { action: 'use' }
  if (opened?.status === 403) return { action: 'stop', state: 'not_allowed' }
  if (opened?.status === 404) return { action: 'ask' }
  return { action: 'stop', state: 'not_found' }
}

/** Gateway HEAD status → keep looking, or a final state. */
export function locateFromStatus(status) {
  if (status === 200 || status === 206) return { action: 'use' }
  if (status === 403) return { action: 'stop', state: 'not_allowed' }
  if (status === 404) return { action: 'next' }
  return { action: 'stop', state: 'not_found' }
}
