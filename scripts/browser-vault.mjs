#!/usr/bin/env node

const [command, ...args] = process.argv.slice(2)
const botIndex = args.indexOf('--bot')
const bot = botIndex >= 0 ? args[botIndex + 1] : process.env.HERMES_BOT_PROFILE
const targetIndex = args.indexOf('--target')
const target = targetIndex >= 0 ? args[targetIndex + 1] : process.env.HERMES_BROWSER_TARGET
const port = Number(process.env.HERMESBOT_VAULT_PORT || 4331)

if (!['list', 'fill', 'save', 'code'].includes(command) || !bot || (command !== 'list' && !target)) {
  console.error('Usage: node scripts/browser-vault.mjs <list|fill|save|code> --bot <profil> [--target <targetId CDP>]')
  process.exit(2)
}

try {
  const response = await fetch(`http://127.0.0.1:${port}/v1/${command}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bot, ...(command === 'list' ? {} : { target }) }),
    // The server caps each CDP call; 60 s lets the two connections of a fill finish.
    signal: AbortSignal.timeout(command === 'save' ? 360_000 : command === 'code' ? 180_000 : 60_000),
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
