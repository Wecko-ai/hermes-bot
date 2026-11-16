import { describe, expect, it } from 'vitest'
import net from 'node:net'
import { assertE2ePortsFree, e2ePorts } from './e2e-ports.mjs'

describe('e2ePorts', () => {
  it('uses defaults when env is empty', () => {
    const ports = e2ePorts({})
    expect(ports.E2E_PORT).toBe('4332')
    expect(ports.E2E_APP_ORIGIN).toBe('http://127.0.0.1:4332')
    expect(ports.E2E_GATEWAY_ORIGIN).toBe('http://127.0.0.1:9121')
  })

  it('honours E2E_* overrides', () => {
    const ports = e2ePorts({
      E2E_PORT: '4400',
      E2E_GATEWAY_PORT: '9100',
      E2E_CDP_PORT: '9200',
      E2E_VAULT_PORT: '4401',
    })
    expect(ports.E2E_CDP_WS).toBe('ws://127.0.0.1:9200')
    expect(ports.E2E_VAULT_PORT).toBe('4401')
  })
})

describe('assertE2ePortsFree', () => {
  it('rejects when a port is already bound', async () => {
    const blocker = net.createServer()
    await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    const { port } = blocker.address()
    await expect(assertE2ePortsFree({ E2E_PORT: String(port) })).rejects.toThrow(/already in use/)
    await new Promise((resolve) => blocker.close(resolve))
  })
})