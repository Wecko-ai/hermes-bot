#!/usr/bin/env node
// Coffre du Chrome partagé, lancé seul (LaunchAgent de la machine des bots) : le trousseau de session n’est lisible
// que depuis la session graphique, et les bots s’en servent même quand l’app HermesBot est fermée.
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createBrowserVault } from './service.mjs'
import { cdpOriginForBot, loadChromeTeams } from '../chrome-teams.mjs'

const auditFile = process.env.HERMESBOT_VAULT_AUDIT
  || path.join(os.homedir(), 'Library/Application Support/HermesBot/browser-vault-audit.jsonl')
fs.mkdirSync(path.dirname(auditFile), { recursive: true, mode: 0o700 })

// Jeton de l’API d’administration, réservé à l’app HermesBot. Créé une fois, lisible par ce compte seulement.
const tokenFile = process.env.HERMESBOT_VAULT_TOKEN_FILE
  || path.join(os.homedir(), 'Library/Application Support/HermesBot/vault-admin.token')
function adminToken() {
  try {
    // Un jeton ouvert à d’autres comptes, ou posé par un autre, est remplacé.
    const info = fs.statSync(tokenFile)
    const value = fs.readFileSync(tokenFile, 'utf8').trim()
    if (info.uid === process.getuid() && (info.mode & 0o077) === 0 && /^[0-9a-f]{64}$/.test(value)) return value
  } catch { /* créé ci-dessous */ }
  const value = randomBytes(32).toString('hex')
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 })
  const temporary = `${tokenFile}.${randomBytes(8).toString('hex')}.tmp`
  const handle = fs.openSync(temporary, 'wx', 0o600)
  try { fs.writeSync(handle, `${value}\n`) } finally { fs.closeSync(handle) }
  fs.renameSync(temporary, tokenFile)
  return value
}

// Session Hermes de l’utilisateur, transmise par l’app pour chaque écriture : la gateway dit si elle est valide.
const hermesOrigin = process.env.HERMES_ORIGIN || 'http://127.0.0.1:9120'
async function verifyUser(cookie) {
  const response = await fetch(`${hermesOrigin}/api/auth/me`, { headers: { cookie }, redirect: 'manual', signal: AbortSignal.timeout(8000) })
  await response.arrayBuffer().catch(() => undefined)
  return response.status === 200
}

// Origine CDP : BROWSER_VAULT_CDP_ORIGIN force un seul Chrome ; sinon le fichier des équipes ; sinon 9222.
const chromeTeams = process.env.BROWSER_VAULT_CDP_ORIGIN ? null
  : loadChromeTeams(process.env.HERMESBOT_CHROME_TEAMS || path.join(os.homedir(), '.config/chrome-teams.json'))

const vault = createBrowserVault({
  adminToken: adminToken(),
  verifyUser,
  port: Number(process.env.BROWSER_VAULT_PORT || 4331),
  cdpOrigin: process.env.BROWSER_VAULT_CDP_ORIGIN || undefined,
  cdpOriginFor: chromeTeams ? (bot) => cdpOriginForBot(chromeTeams, bot) : undefined,
  audit: { append: (line) => fs.appendFileSync(auditFile, `${line}\n`, { mode: 0o600 }) },
})

await vault.listen()
console.log(`Coffre HermesBot sur 127.0.0.1:${process.env.BROWSER_VAULT_PORT || 4331}`)
const stop = () => vault.close().finally(() => process.exit(0))
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
