const fs = require('node:fs')

const file = process.env.HERMESBOT_TEST_SESSION_FILE

globalThis.__hermesBotSessionPersistence = {
  load: () => {
    try { return fs.readFileSync(file, 'utf8') } catch { return '' }
  },
  save: (json) => fs.writeFileSync(file, json, { mode: 0o600 }),
}
