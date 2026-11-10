#!/usr/bin/env node
// Coffre du Chrome partagé, lancé seul (LaunchAgent de la machine des bots) : le trousseau de session n’est lisible
// que depuis la session graphique, et les bots s’en servent même quand l’app HermesBot est fermée.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createBrowserVault } from './service.mjs'

const auditFile = process.env.HERMESBOT_VAULT_AUDIT
  || path.join(os.homedir(), 'Library/Application Support/HermesBot/browser-vault-audit.jsonl')
fs.mkdirSync(path.dirname(auditFile), { recursive: true, mode: 0o700 })

const vault = createBrowserVault({
  port: Number(process.env.BROWSER_VAULT_PORT || 4331),
  cdpOrigin: process.env.BROWSER_VAULT_CDP_ORIGIN || undefined,
  audit: { append: (line) => fs.appendFileSync(auditFile, `${line}\n`, { mode: 0o600 }) },
})

await vault.listen()
console.log(`Coffre HermesBot sur 127.0.0.1:${process.env.BROWSER_VAULT_PORT || 4331}`)
const stop = () => vault.close().finally(() => process.exit(0))
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
