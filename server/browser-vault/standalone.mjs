#!/usr/bin/env node
// Shared Chrome vault, run on its own (LaunchAgent on the bots' machine): the session keychain is only readable
// from the graphical session, and the bots use it even when the HermesBot app is closed.
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createBrowserVault } from './service.mjs'
import { cdpOriginForBot, loadChromeTeams } from '../chrome-teams.mjs'

const auditFile = process.env.HERMESBOT_VAULT_AUDIT
  || path.join(os.homedir(), 'Library/Application Support/HermesBot/browser-vault-audit.jsonl')
fs.mkdirSync(path.dirname(auditFile), { recursive: true, mode: 0o700 })

// Admin API token, reserved for the HermesBot app. Created once, readable by this account only.
const tokenFile = process.env.HERMESBOT_VAULT_TOKEN_FILE
  || path.join(os.homedir(), 'Library/Application Support/HermesBot/vault-admin.token')
function adminToken() {
  try {
    // A token open to other accounts, or placed by someone else, is replaced.
    const info = fs.statSync(tokenFile)
    const value = fs.readFileSync(tokenFile, 'utf8').trim()
    if (info.uid === process.getuid() && (info.mode & 0o077) === 0 && /^[0-9a-f]{64}$/.test(value)) return value
  } catch { /* created below */ }
  const value = randomBytes(32).toString('hex')
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 })
  const temporary = `${tokenFile}.${randomBytes(8).toString('hex')}.tmp`
  const handle = fs.openSync(temporary, 'wx', 0o600)
  try { fs.writeSync(handle, `${value}\n`) } finally { fs.closeSync(handle) }
  fs.renameSync(temporary, tokenFile)
  return value
}

// The user's Hermes session, passed by the app for each write: the gateway says whether it is valid.
const hermesOrigin = process.env.HERMES_ORIGIN || 'http://127.0.0.1:9120'
async function verifyUser(cookie) {
  const response = await fetch(`${hermesOrigin}/api/auth/me`, { headers: { cookie }, redirect: 'manual', signal: AbortSignal.timeout(8000) })
  await response.arrayBuffer().catch(() => undefined)
  return response.status === 200
}

// CDP origin: BROWSER_VAULT_CDP_ORIGIN forces a single Chrome; otherwise the teams file; otherwise 9222.
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
console.log(`HermesBot vault on 127.0.0.1:${process.env.BROWSER_VAULT_PORT || 4331}`)
const stop = () => vault.close().finally(() => process.exit(0))
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
