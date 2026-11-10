import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Ne retourne que le profil propriétaire. La file, le pid et les dates restent locaux. */
export function parseBrowserTurn(output) {
  const first = String(output || '').split('\n', 1)[0]
  const match = /^tour\s*:\s*([A-Za-z0-9][A-Za-z0-9_.-]{0,63})(?:\s|$)/.exec(first)
  const owner = match?.[1] || ''
  return owner === 'libre' ? '' : owner
}

/** Lecture seule d’un arbitre du Chrome partagé, facultatif : `BROWSER_TOUR_COMMAND`, qui écrit « tour : <profil> ». */
export async function readBrowserOwner() {
  const command = process.env.BROWSER_TOUR_COMMAND
  if (!command) return ''
  const args = ['statut']
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: 4000,
      maxBuffer: 16_384,
      windowsHide: true,
      env: process.env,
    })
    return parseBrowserTurn(stdout)
  } catch {
    return ''
  }
}
