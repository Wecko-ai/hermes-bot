#!/usr/bin/env node
// Coffre du Chrome partagé, lancé seul (LaunchAgent de la machine des bots) : le trousseau de session n’est lisible
// que depuis la session graphique, et les bots s’en servent même quand l’app HermesBot est fermée.
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createBrowserVault } from './service.mjs'

const auditFile = process.env.HERMESBOT_VAULT_AUDIT
  || path.join(os.homedir(), 'Library/Application Support/HermesBot/browser-vault-audit.jsonl')
fs.mkdirSync(path.dirname(auditFile), { recursive: true, mode: 0o700 })

// Jeton de l’API d’administration, réservé à l’app HermesBot. Créé une fois, lisible par ce compte seulement.
const tokenFile = process.env.HERMESBOT_VAULT_TOKEN_FILE
  || path.join(os.homedir(), 'Library/Application Support/HermesBot/vault-admin.token')
function adminToken() {
  try {
    const value = fs.readFileSync(tokenFile, 'utf8').trim()
    if (/^[0-9a-f]{64}$/.test(value)) return value
  } catch { /* créé ci-dessous */ }
  const value = randomBytes(32).toString('hex')
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 })
  fs.writeFileSync(`${tokenFile}.tmp`, `${value}\n`, { mode: 0o600 })
  fs.renameSync(`${tokenFile}.tmp`, tokenFile)
  return value
}

const vault = createBrowserVault({
  adminToken: adminToken(),
  port: Number(process.env.BROWSER_VAULT_PORT || 4331),
  cdpOrigin: process.env.BROWSER_VAULT_CDP_ORIGIN || undefined,
  audit: { append: (line) => fs.appendFileSync(auditFile, `${line}\n`, { mode: 0o600 }) },
})

await vault.listen()
console.log(`Coffre HermesBot sur 127.0.0.1:${process.env.BROWSER_VAULT_PORT || 4331}`)
const stop = () => vault.close().finally(() => process.exit(0))
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
