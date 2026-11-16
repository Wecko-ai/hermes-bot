// Environment handed to child processes (lsof, the browser-turn arbiter).
// The vault admin token may live in the parent environment; children must not inherit it.

export function childEnv(source = process.env) {
  const env = { ...source }
  delete env.HERMESBOT_VAULT_TOKEN
  return env
}
