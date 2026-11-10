const fs = require('node:fs')

const file = process.env.HERMESBOT_TEST_SESSION_FILE
const credentials = `${file}.credentials`

globalThis.__hermesBotSessionPersistence = {
  load: () => {
    try { return fs.readFileSync(file, 'utf8') } catch { return '' }
  },
  save: (json) => fs.writeFileSync(file, json, { mode: 0o600 }),
}

// In clear text here only: the real app encrypts with safeStorage (electron/main.cjs).
globalThis.__hermesBotCredentialStore = {
  load: () => {
    try { return fs.readFileSync(credentials, 'utf8') } catch { return '' }
  },
  save: (json) => fs.writeFileSync(credentials, json, { mode: 0o600 }),
  clear: () => fs.rmSync(credentials, { force: true }),
}
