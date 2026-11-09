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
