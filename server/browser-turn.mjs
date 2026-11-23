import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { childEnv } from './child-env.mjs'

const execFileAsync = promisify(execFile)

/** The arbiter hands a turn held longer than this to the next bot in line: past it, the holder is gone. */
export const BROWSER_TURN_MAX_MINUTES = 45

/** `2026-01-05T10:00:00+0200` (strftime `%z`), `+02:00` or `Z`, in milliseconds; `null` if absent or unreadable. */
function turnStart(text) {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(Z|[+-]\d{2}:?\d{2})$/.exec(text || '')
  if (!match) return null
  const zone = match[2] === 'Z' ? 'Z' : `${match[2].slice(0, 3)}:${match[2].slice(-2)}`
  const time = Date.parse(match[1] + zone)
  return Number.isFinite(time) ? time : null
}

/**
 * Turns of the shared Chrome, one per team: `tour[team] : <profile> <start> pid=… depuis <n> min` lines, or the older
 * single `tour : <profile> …`. Only the profile and the start time leave this module: the queue and pid stay local.
 * `libre` (free), old anonymous locks and turns held past the arbiter's limit are left out.
 */
export function parseBrowserTurns(output) {
  const turns = []
  for (const line of String(output || '').split('\n')) {
    const match = /^tour(?:\[[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\])?\s*:\s*([A-Za-z0-9][A-Za-z0-9_.-]{0,63})(?:\s+(\S+))?/.exec(line)
    const owner = match?.[1] || ''
    if (!owner || owner === 'libre' || turns.some((turn) => turn.owner === owner)) continue
    const minutes = Number(/\bdepuis (\d+) min\b/.exec(line)?.[1] ?? 0)
    if (minutes >= BROWSER_TURN_MAX_MINUTES) continue
    const since = turnStart(match[2])
    const targetId = /\btarget=([A-Za-z0-9-]{4,})\b/.exec(line)?.[1] || ''
    turns.push({ owner, since: since === null ? null : new Date(since).toISOString(), ...(targetId ? { targetId } : {}) })
  }
  return turns
}

/** Owners of the shared Chrome, one per team (see `parseBrowserTurns`). */
export function parseBrowserOwners(output) {
  return parseBrowserTurns(output).map((turn) => turn.owner)
}

/** First owner, for clients older than teams. */
export function parseBrowserTurn(output) {
  return parseBrowserOwners(output)[0] || ''
}

/**
 * Which command reads the arbiter, from the `browserTurn` setting. None configured: no arbiter, nobody is shown
 * as driving the browser. With `user`, the command runs only as that macOS user and everyone else runs `remoteCommand`.
 */
export function browserTurnCommand(setting, username = os.userInfo().username) {
  if (!setting?.command) return null
  if (setting.user && username !== setting.user) return setting.remoteCommand || null
  return setting.command
}

const BROWSER_TURN_CACHE_MS = 2_000
let browserTurnCache = null
let browserTurnInflight = null

/** Drops the short-lived arbiter cache. Tests use this; the server does not. */
export function clearBrowserTurnCache() {
  browserTurnCache = null
  browserTurnInflight = null
}

function commandKey(argv) {
  return argv.join('\0')
}

async function runBrowserTurn(argv) {
  try {
    const { stdout } = await execFileAsync(argv[0], argv.slice(1), {
      timeout: 4000,
      maxBuffer: 16_384,
      windowsHide: true,
      // The vault token must not ride along into the arbiter (often ssh).
      env: childEnv(),
    })
    return parseBrowserTurns(stdout)
  } catch {
    return []
  }
}

/**
 * Read-only call to the arbiter. Any failure means « nobody », never an error for the window.
 * The same command is cached for 2s, and concurrent callers share one run.
 */
export async function readBrowserTurns(argv) {
  if (!argv?.length) return []
  const key = commandKey(argv)
  const now = Date.now()
  if (browserTurnCache && browserTurnCache.key === key && now - browserTurnCache.at < BROWSER_TURN_CACHE_MS) return browserTurnCache.turns
  if (browserTurnInflight && browserTurnInflight.key === key) return browserTurnInflight.promise
  const promise = runBrowserTurn(argv).then((turns) => {
    browserTurnCache = { key, at: Date.now(), turns }
    if (browserTurnInflight?.promise === promise) browserTurnInflight = null
    return turns
  })
  browserTurnInflight = { key, promise }
  return promise
}

export async function readBrowserOwners(argv) {
  return (await readBrowserTurns(argv)).map((turn) => turn.owner)
}
