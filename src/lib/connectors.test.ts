import { describe, expect, it, vi } from 'vitest'
import { connectorApiKeyCli, connectorApiKeyState, setConnectorApiKey } from './connectors'
import type { HermesClient } from './hermes'

describe('connectors api keys', () => {
  it('calls mcp.servers.set_api_key without retaining the value', async () => {
    const request = vi.fn(async () => ({ ok: true, env_var: 'LINEAR_API_KEY' }))
    const client = { request } as unknown as HermesClient
    await setConnectorApiKey(client, 'orion', 'linear', 'secret-value', 'LINEAR_API_KEY')
    expect(request).toHaveBeenCalledWith('mcp.servers.set_api_key', {
      profile: 'orion',
      name: 'linear',
      value: 'secret-value',
      env_var: 'LINEAR_API_KEY',
    })
  })

  it('infers set vs missing from mcp.servers.test', async () => {
    const client = {
      request: vi.fn(async () => ({ ok: true })),
    } as unknown as HermesClient
    await expect(connectorApiKeyState(client, 'orion', 'linear', false)).resolves.toBe('set')
    ;(client.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false })
    await expect(connectorApiKeyState(client, 'orion', 'linear', false)).resolves.toBe('missing')
  })

  it('prints a CLI fallback with placeholders', () => {
    expect(connectorApiKeyCli('orion', 'linear', 'LINEAR_API_KEY')).toBe('hermes -p orion mcp set-api-key linear --env LINEAR_API_KEY')
  })
})