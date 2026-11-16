import net from 'node:net'

const DEFAULTS = {
  E2E_PORT: '4332',
  E2E_GATEWAY_PORT: '9121',
  E2E_CDP_PORT: '9223',
  E2E_VAULT_PORT: '4333',
}

/** @returns {{ E2E_PORT: string, E2E_GATEWAY_PORT: string, E2E_CDP_PORT: string, E2E_VAULT_PORT: string, E2E_APP_ORIGIN: string, E2E_GATEWAY_ORIGIN: string, E2E_CDP_ORIGIN: string, E2E_CDP_WS: string }} */
export function e2ePorts(env = process.env) {
  const E2E_PORT = env.E2E_PORT || DEFAULTS.E2E_PORT
  const E2E_GATEWAY_PORT = env.E2E_GATEWAY_PORT || DEFAULTS.E2E_GATEWAY_PORT
  const E2E_CDP_PORT = env.E2E_CDP_PORT || DEFAULTS.E2E_CDP_PORT
  const E2E_VAULT_PORT = env.E2E_VAULT_PORT || DEFAULTS.E2E_VAULT_PORT
  return {
    E2E_PORT,
    E2E_GATEWAY_PORT,
    E2E_CDP_PORT,
    E2E_VAULT_PORT,
    E2E_APP_ORIGIN: `http://127.0.0.1:${E2E_PORT}`,
    E2E_GATEWAY_ORIGIN: `http://127.0.0.1:${E2E_GATEWAY_PORT}`,
    E2E_CDP_ORIGIN: `http://127.0.0.1:${E2E_CDP_PORT}`,
    E2E_CDP_WS: `ws://127.0.0.1:${E2E_CDP_PORT}`,
  }
}

function portLabel(name) {
  return name.replace(/^E2E_/, '').replace(/_PORT$/, '') || name
}

/**
 * @param {Record<string, string>} ports keys E2E_PORT, E2E_GATEWAY_PORT, …
 */
export function assertE2ePortsFree(ports) {
  const entries = Object.entries(ports).filter(([key]) => key.endsWith('_PORT') || key === 'E2E_PORT')
  return Promise.all(entries.map(([name, value]) => assertPortFree(Number(value), name)))
}

function assertPortFree(port, envName) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return Promise.reject(new Error(`Invalid ${envName}=${port}: need a TCP port between 1 and 65535.`))
  }
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        reject(new Error(
          `E2E port ${port} (${envName}) is already in use. Stop the process holding it or set ${envName} to a free port.`,
        ))
        return
      }
      reject(error)
    })
    server.listen(port, '127.0.0.1', () => {
      server.close((closeError) => (closeError ? reject(closeError) : resolve()))
    })
  })
}

export { portLabel, DEFAULTS }