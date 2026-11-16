// Vault admin token. It stays in memory (`globalThis.__hermesBotVaultToken`) and is never
// written to process.env, so a child process does not inherit it. The server reads the
// global first, then HERMESBOT_VAULT_TOKEN for a standalone run or a test.

const TOKEN = /^[0-9a-f]{64}$/
const ENV_KEY = 'HERMESBOT_VAULT_TOKEN'

function currentVaultToken() {
  const value = globalThis.__hermesBotVaultToken
  return typeof value === 'string' ? value : ''
}

function rememberVaultToken(value) {
  if (typeof value !== 'string' || !TOKEN.test(value)) return false
  globalThis.__hermesBotVaultToken = value
  return true
}

/** Move a token that arrived in the environment into memory and drop the variable. */
function adoptEnvironmentVaultToken(env) {
  if (!env || typeof env !== 'object') return false
  const value = env[ENV_KEY]
  const kept = typeof value === 'string' && rememberVaultToken(value)
  if (Object.prototype.hasOwnProperty.call(env, ENV_KEY)) delete env[ENV_KEY]
  return kept
}

/** A copy of `source` safe to give to a child. The source itself is left unchanged. */
function envWithoutVaultToken(source) {
  const env = { ...source }
  delete env[ENV_KEY]
  return env
}

module.exports = {
  ENV_KEY,
  currentVaultToken,
  rememberVaultToken,
  adoptEnvironmentVaultToken,
  envWithoutVaultToken,
}
