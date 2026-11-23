import http from 'node:http'
import { describe, expect, it, afterEach } from 'vitest'
import { createPushRelay } from './push-relay.mjs'
import { fnv1a64Hex, pushAccountId } from './push-account.mjs'

describe('push-account.mjs', () => {
  it('matches the iPhone FNV-1a account id', () => {
    expect(pushAccountId('http://127.0.0.1:9120', 'alice')).toBe(fnv1a64Hex('http://127.0.0.1:9120|alice'))
    expect(pushAccountId('http://127.0.0.1:9120', '')).toBe(fnv1a64Hex('http://127.0.0.1:9120|'))
  })
})

describe('push-relay.mjs', () => {
  /** @type {http.Server | null} */
  let server = null
  const notifications = []

  afterEach(async () => {
    if (server) await new Promise((resolve) => server.close(resolve))
    server = null
    notifications.length = 0
  })

  function startRelay(secret) {
    return new Promise((resolve) => {
      server = http.createServer((request, response) => {
        const auth = request.headers.authorization || ''
        if (auth !== `Bearer ${secret}`) {
          response.writeHead(401)
          response.end('{}')
          return
        }
        const chunks = []
        request.on('data', (chunk) => chunks.push(chunk))
        request.on('end', () => {
          notifications.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
          response.writeHead(200, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ ok: true, sent: 1 }))
        })
      })
      server.listen(0, '127.0.0.1', () => resolve(server.address().port))
    })
  }

  it('posts to /v1/notify with clipped preview and skips when the window is in front', async () => {
    const port = await startRelay('relay-secret')
    const relay = createPushRelay({
      relayUrl: `http://127.0.0.1:${port}`,
      secretCommand: [process.execPath],
      readCommand: async () => 'relay-secret',
      debounceMs: 5,
      fetchImpl: fetch,
    })
    relay.setWindowInFront(true)
    relay.enqueue({ accountId: 'acc', slug: 'nova', title: 'Nova', body: 'Line one' })
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(notifications).toHaveLength(0)

    relay.setWindowInFront(false)
    relay.enqueue({ accountId: 'acc', slug: 'nova', title: 'Nova', body: `${'word '.repeat(80)}tail` })
    await relay.flushNow('nova')
    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toMatchObject({
      account_id: 'acc',
      slug: 'nova',
      title: 'Nova',
    })
    expect(notifications[0].body.length).toBeLessThanOrEqual(200)
    expect(notifications[0].body).not.toContain('relay-secret')
  })

  it('debounces multiple events for the same slug', async () => {
    const port = await startRelay('second-secret')
    const relay = createPushRelay({
      relayUrl: `http://127.0.0.1:${port}`,
      secretCommand: [process.execPath],
      readCommand: async () => 'second-secret',
      debounceMs: 40,
      fetchImpl: fetch,
    })
    relay.setWindowInFront(false)
    relay.enqueue({ accountId: 'acc', slug: 'orion', title: 'Orion', body: 'first' })
    relay.enqueue({ accountId: 'acc', slug: 'orion', title: 'Orion', body: 'second' })
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(notifications).toHaveLength(1)
    expect(notifications[0].body).toBe('second')
  })
})