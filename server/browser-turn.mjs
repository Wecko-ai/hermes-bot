import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Owners of the shared Chrome, one per team: `tour[team] : <profile> …` lines, or the older single `tour : <profile> …`.
 * The queue, pid and dates stay local. `libre` (free) and old anonymous locks are left out.
 */
export function parseBrowserOwners(output) {
  const owners = []
  for (const line of String(output || '').split('\n')) {
    const match = /^tour(?:\[[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\])?\s*:\s*([A-Za-z0-9][A-Za-z0-9_.-]{0,63})(?:\s|$)/.exec(line)
    const owner = match?.[1] || ''
    if (owner && owner !== 'libre' && !owners.includes(owner)) owners.push(owner)
  }
  return owners
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
export async function readBrowserOwners(argv) {
  if (!argv?.length) return []
  try {
    const { stdout } = await execFileAsync(argv[0], argv.slice(1), {
      timeout: 4000,
      maxBuffer: 16_384,
      windowsHide: true,
      env: process.env,
    })
    return parseBrowserOwners(stdout)
  } catch {
    return []
  }
}
