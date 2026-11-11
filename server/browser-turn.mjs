import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

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
    turns.push({ owner, since: since === null ? null : new Date(since).toISOString() })
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

/** Read-only call to the arbiter. Any failure means « nobody », never an error for the window. */
export async function readBrowserTurns(argv) {
  if (!argv?.length) return []
  try {
    const { stdout } = await execFileAsync(argv[0], argv.slice(1), {
      timeout: 4000,
      maxBuffer: 16_384,
      windowsHide: true,
      env: process.env,
    })
    return parseBrowserTurns(stdout)
  } catch {
    return []
  }
}

export async function readBrowserOwners(argv) {
  return (await readBrowserTurns(argv)).map((turn) => turn.owner)
}
