const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// Extensions the server will serve. Copied from server/index.mjs MEDIA_TYPES and DOCUMENT_TYPES.
// Do not import the server: this check runs in the Electron main process before that module loads.
const REVEAL_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp',
  'mp4', 'mov', 'webm',
  'mp3', 'm4a', 'wav', 'ogg', 'opus', 'flac',
  'pdf', 'html', 'htm', 'md', 'markdown', 'txt', 'log',
])

/** Only an absolute local file can be revealed; `~/` belongs to this Mac's current user. */
function localMediaPath(value, home = os.homedir()) {
  if (typeof value !== 'string' || !value.trim()) return null
  const candidate = value.startsWith('~/') ? path.resolve(home, value.slice(2)) : value
  return path.isAbsolute(candidate) ? candidate : null
}

function revealExtension(file) {
  return REVEAL_EXTENSIONS.has(path.extname(file).slice(1).toLowerCase())
}

function isRegularFile(info) {
  return Boolean(info) && typeof info.isFile === 'function' && info.isFile()
}

/**
 * Reveal an existing media or document file in Finder. Directories and any other extension
 * do nothing, so a path named by a page is not an existence check for arbitrary files.
 */
function revealMedia(value, { home = os.homedir(), stat = fs.statSync, reveal } = {}) {
  const local = localMediaPath(value, home)
  if (!local || typeof reveal !== 'function' || !revealExtension(local)) return false
  let info
  try {
    info = stat(local)
  } catch {
    return false
  }
  if (!isRegularFile(info)) return false
  reveal(local)
  return true
}

module.exports = { localMediaPath, revealMedia, REVEAL_EXTENSIONS }
