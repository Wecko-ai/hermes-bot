import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Propriétaires du Chrome, un par équipe : lignes `tour[équipe] : <profil> …` ou ancienne ligne `tour : <profil> …`.
 * La file, le pid et les dates restent locaux. `libre` et les anciens verrous anonymes sont exclus.
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

/** Premier propriétaire, pour les clients d’avant les équipes. */
export function parseBrowserTurn(output) {
  return parseBrowserOwners(output)[0] || ''
}

/** Lecture seule d’un arbitre du Chrome partagé, facultatif : `BROWSER_TOUR_COMMAND`, qui écrit « tour : <profil> ». */
export async function readBrowserOwners() {
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
    return parseBrowserOwners(stdout)
  } catch {
    return []
  }
}

export async function readBrowserOwner() {
  return (await readBrowserOwners())[0] || ''
}
