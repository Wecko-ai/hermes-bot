const fs = require('node:fs')

const file = process.env.HERMESBOT_TEST_SESSION_FILE
const credentials = `${file}.credentials`

globalThis.__hermesBotSessionPersistence = {
  load: () => {
    try { return fs.readFileSync(file, 'utf8') } catch { return '' }
  },
  save: (json) => fs.writeFileSync(file, json, { mode: 0o600 }),
}

// En clair ici seulement : l’app réelle chiffre avec safeStorage (electron/main.cjs).
globalThis.__hermesBotCredentialStore = {
  load: () => {
    try { return fs.readFileSync(credentials, 'utf8') } catch { return '' }
  },
  save: (json) => fs.writeFileSync(credentials, json, { mode: 0o600 }),
  clear: () => fs.rmSync(credentials, { force: true }),
}

// Coffre CDP : en clair seulement dans cette fixture. L’app Electron utilise safeStorage.
const browserVault = `${file}.browser-vault`
globalThis.__hermesBotBrowserVaultPersistence = {
  load: () => {
    try { return fs.readFileSync(browserVault, 'utf8') }
    catch (error) { if (error.code === 'ENOENT') return ''; throw error }
  },
  save: (json) => fs.writeFileSync(browserVault, json, { mode: 0o600 }),
}
globalThis.__hermesBotBrowserVaultAudit = {
  append: (line) => fs.appendFileSync(`${browserVault}-audit.jsonl`, `${line}\n`, { mode: 0o600 }),
}
