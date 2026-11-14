const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/** Only an absolute local file can be revealed; `~/` belongs to this Mac's current user. */
function localMediaPath(value, home = os.homedir()) {
  if (typeof value !== 'string' || !value.trim()) return null
  const candidate = value.startsWith('~/') ? path.resolve(home, value.slice(2)) : value
  return path.isAbsolute(candidate) ? candidate : null
}

/** Reveal an existing image in Finder. A gateway path absent from this Mac does nothing. */
function revealMedia(value, { home = os.homedir(), exists = fs.existsSync, reveal } = {}) {
  const local = localMediaPath(value, home)
  if (!local || typeof reveal !== 'function' || !exists(local)) return false
  reveal(local)
  return true
}

module.exports = { localMediaPath, revealMedia }
