#!/usr/bin/env node

const [command, ...args] = process.argv.slice(2)
const option = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const bot = option('--bot') ?? process.env.HERMES_BOT_PROFILE
const target = option('--target') ?? process.env.HERMES_BROWSER_TARGET
// Sign-up only: the login being registered (an e-mail, a username). Never a password.
const identifier = option('--identifier')
// Hermes marks a scheduled task. save, code and signup are refused here, before any request.
const unattended = /^(1|true|yes|on)$/i.test(String(process.env.HERMES_CRON_SESSION || '').trim())
const port = Number(process.env.HERMESBOT_VAULT_PORT || 4331)

if (!['list', 'fill', 'save', 'code', 'signup'].includes(command) || !bot || (command !== 'list' && !target) || (command === 'signup' && !identifier)) {
  console.error('Usage: node scripts/browser-vault.mjs <list|fill|save|code|signup> --bot <profil> [--target <targetId CDP>] [--identifier <login> (signup)]')
  process.exit(2)
}

// A scheduled task never asks the user. Refuse before any request. The server only honors a client-supplied flag.
if (unattended && (command === 'save' || command === 'code' || command === 'signup')) {
  // Same JSON shape as every other error of this CLI: bots parse it.
  console.error(JSON.stringify({
    error: 'unattended_session',
    message: `A scheduled task never asks the user: ${command} is refused while HERMES_CRON_SESSION is set, before any request.`,
  }))
  process.exit(1)
}

try {
  const response = await fetch(`http://127.0.0.1:${port}/v1/${command}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bot, ...(command === 'list' ? {} : { target }), ...(command === 'signup' ? { identifier, ...(unattended ? { unattended: true } : {}) } : {}) }),
    // The server caps each CDP call; 60 s lets the two connections of a fill finish.
    signal: AbortSignal.timeout(command === 'save' || command === 'signup' ? 360_000 : command === 'code' ? 180_000 : 60_000),
  })
  const result = await response.json()
  if (!response.ok) {
    console.error(JSON.stringify(result))
    process.exit(1)
  }
  console.log(JSON.stringify(result))
} catch {
  console.error(JSON.stringify({ error: 'vault_unavailable' }))
  process.exit(1)
}
