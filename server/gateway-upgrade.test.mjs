import { randomBytes } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { RELAY_BUFFER_CAP, attachGatewayUpgrade, holdWhenBuffered, sameUpgradeSession } from './gateway-upgrade.mjs'

const session = { id: 'session-1', kind: 'local' }

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()))
}

describe('upgrade session', () => {
  it('requires the same session id and kind after the awaits', () => {
    expect(sameUpgradeSession(null, null)).toBe(true)
    expect(sameUpgradeSession(session, { ...session })).toBe(true)
    expect(sameUpgradeSession(session, null)).toBe(false)
    expect(sameUpgradeSession(session, { id: session.id, kind: 'cookie' })).toBe(false)
    expect(sameUpgradeSession(null, session)).toBe(false)
  })
})

describe('relay backpressure', () => {
  it('pauses the source once the target is holding more than the cap and resumes on drain', () => {
    const source = {
      paused: false,
      pause() { this.paused = true },
      resume() { this.paused = false },
    }
    const outgoing = new EventEmitter()
    const target = { bufferedAmount: 100, _socket: outgoing, send() {} }
    holdWhenBuffered(source, target, 8)
    expect(source.paused).toBe(true)
    outgoing.emit('drain')
    expect(source.paused).toBe(false)
    holdWhenBuffered(source, { ...target, bufferedAmount: 1 }, 8)
    expect(source.paused).toBe(false)
  })
})

describe('gateway upgrade', () => {
  it('closes the upstream when the client FINs during ticket mint', async () => {
    const gateway = http.createServer()
    const open = new Set()
    let seen = 0
    gateway.on('connection', (sock) => {
      seen += 1
      open.add(sock)
      sock.on('close', () => open.delete(sock))
    })
    const gwPort = await listen(gateway)

    let release = () => {}
    const gate = new Promise((resolve) => { release = resolve })
    let ticketStarted = () => {}
    const ticketEntered = new Promise((resolve) => { ticketStarted = resolve })
    let checked = null
    const app = http.createServer()
    const wss = new WebSocketServer({ noServer: true, handleProtocols: () => 'hermes-gateway-v1' })
    const appPort = await listen(app)
    const origin = `http://127.0.0.1:${appPort}`
    attachGatewayUpgrade(app, wss, {
      host: '127.0.0.1',
      port: appPort,
      accept: (request) => request.headers.host === `127.0.0.1:${appPort}` && request.headers.origin === origin,
      browserSession: () => session,
      hermesFetch: async () => ({ ok: true, status: 200, body: { cancel: async () => {} } }),
      mintSocketTicket: async () => {
        ticketStarted()
        await gate
        return 'ticket'
      },
      localGateway: {
        socketOrigin: `ws://127.0.0.1:${gwPort}`,
        connect: () => new Promise((resolve, reject) => {
          checked = net.connect({ host: '127.0.0.1', port: gwPort })
          checked.once('connect', () => resolve(checked))
          checked.once('error', reject)
        }),
      },
      hermesWsOrigin: `ws://127.0.0.1:${gwPort}`,
      browserOrigin: origin,
      maxPayload: 1024 * 1024,
    })

    const client = net.connect({ host: '127.0.0.1', port: appPort })
    await new Promise((resolve, reject) => {
      client.once('connect', resolve)
      client.once('error', reject)
    })
    const key = randomBytes(16).toString('base64')
    client.write([
      'GET /api/ws?profile=default HTTP/1.1',
      `Host: 127.0.0.1:${appPort}`,
      `Origin: ${origin}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Protocol: hermes-gateway-v1',
      '',
      '',
    ].join('\r\n'))
    await ticketEntered
    client.end()
    await new Promise((resolve) => setTimeout(resolve, 40))
    release()
    const deadline = Date.now() + 2000
    while ((open.size > 0 || !checked?.destroyed) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(seen).toBeGreaterThan(0)
    expect(open.size).toBe(0)
    expect(checked.destroyed).toBe(true)
    client.destroy()
    wss.close()
    await close(app)
    await close(gateway)
  })

  it('closes the browser socket on an upstream 401 without waiting out the handshake', async () => {
    const extensions = []
    const gateway = http.createServer()
    gateway.on('upgrade', (request, socket) => {
      extensions.push(request.headers['sec-websocket-extensions'])
      const status = request.url.includes('forbidden') ? 403 : request.url.includes('boom') ? 500 : 401
      socket.write(`HTTP/1.1 ${status} No\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`)
      socket.end()
    })
    const gwPort = await listen(gateway)
    const app = http.createServer()
    const wss = new WebSocketServer({ noServer: true, handleProtocols: () => 'hermes-gateway-v1' })
    const appPort = await listen(app)
    const origin = `http://127.0.0.1:${appPort}`
    attachGatewayUpgrade(app, wss, {
      host: '127.0.0.1',
      port: appPort,
      accept: (request) => request.headers.host === `127.0.0.1:${appPort}` && request.headers.origin === origin,
      browserSession: () => ({ id: 'session-1', kind: 'cookie' }),
      hermesFetch: async () => ({ ok: true, status: 200, body: { cancel: async () => {} } }),
      mintSocketTicket: async (_request, profile) => profile,
      localGateway: { socketOrigin: '', connect: async () => { throw new Error('not local') } },
      hermesWsOrigin: `ws://127.0.0.1:${gwPort}`,
      browserOrigin: origin,
      maxPayload: 1024 * 1024,
    })

    const closed = (profile) => new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${appPort}/api/ws?profile=${profile}`, { origin })
      const timer = setTimeout(() => { ws.terminate(); reject(new Error('timed out')) }, 2000)
      ws.on('error', () => {})
      ws.on('close', (code) => { clearTimeout(timer); resolve(code) })
    })
    expect(await closed('default')).toBe(4401)
    expect(await closed('forbidden')).toBe(4401)
    expect(await closed('boom')).toBe(1011)
    expect(extensions.every((value) => value === undefined)).toBe(true)
    wss.close()
    await close(app)
    await close(gateway)
  })

  it('does not open the upstream when the session is gone after the ticket await', async () => {
    const gateway = http.createServer()
    let seen = 0
    gateway.on('connection', () => { seen += 1 })
    const gwPort = await listen(gateway)
    let drop = false
    let release = () => {}
    const gate = new Promise((resolve) => { release = resolve })
    let markEntered = () => {}
    const entered = new Promise((resolve) => { markEntered = resolve })
    const app = http.createServer()
    const wss = new WebSocketServer({ noServer: true })
    const appPort = await listen(app)
    const origin = `http://127.0.0.1:${appPort}`
    attachGatewayUpgrade(app, wss, {
      host: '127.0.0.1',
      port: appPort,
      accept: (request) => request.headers.host === `127.0.0.1:${appPort}` && request.headers.origin === origin,
      browserSession: () => (drop ? null : session),
      hermesFetch: async () => ({ ok: true, status: 200, body: { cancel: async () => {} } }),
      mintSocketTicket: async () => {
        markEntered()
        await gate
        drop = true
        return 'ticket'
      },
      localGateway: {
        socketOrigin: `ws://127.0.0.1:${gwPort}`,
        connect: () => new Promise((resolve, reject) => {
          const socket = net.connect({ host: '127.0.0.1', port: gwPort })
          socket.once('connect', () => resolve(socket))
          socket.once('error', reject)
        }),
      },
      hermesWsOrigin: `ws://127.0.0.1:${gwPort}`,
      browserOrigin: origin,
      maxPayload: 1024,
    })
    const code = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${appPort}/api/ws`, { origin })
      const timer = setTimeout(() => reject(new Error('timed out')), 2000)
      ws.on('error', () => {})
      ws.on('close', (closeCode) => { clearTimeout(timer); resolve(closeCode) })
      ws.on('unexpected-response', () => { clearTimeout(timer); resolve(401) })
      entered.then(() => release())
    })
    // The handshake may already have been refused with HTTP 401, which the client reports as a close.
    expect([401, 1006]).toContain(code)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(seen).toBe(0)
    wss.close()
    await close(app)
    await close(gateway)
  })

  it('pauses the browser socket when the upstream does not read', async () => {
    const gateway = http.createServer()
    const gwss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 })
    const peers = []
    gateway.on('upgrade', (request, socket, head) => {
      gwss.handleUpgrade(request, socket, head, (ws) => {
        ws._socket.pause()
        peers.push(ws)
      })
    })
    const gwPort = await listen(gateway)
    const app = http.createServer()
    const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024, handleProtocols: () => 'hermes-gateway-v1' })
    const appPort = await listen(app)
    const origin = `http://127.0.0.1:${appPort}`
    let browser = null
    let upstream = null
    attachGatewayUpgrade(app, wss, {
      host: '127.0.0.1',
      port: appPort,
      accept: (request) => request.headers.host === `127.0.0.1:${appPort}` && request.headers.origin === origin,
      browserSession: () => ({ id: 'session-1', kind: 'cookie' }),
      hermesFetch: async () => ({ ok: true, status: 200, body: { cancel: async () => {} } }),
      mintSocketTicket: async () => 'ticket',
      localGateway: { socketOrigin: '', connect: async () => null },
      hermesWsOrigin: `ws://127.0.0.1:${gwPort}`,
      browserOrigin: origin,
      maxPayload: 32 * 1024 * 1024,
      onRelay: (nextBrowser, nextUpstream) => { browser = nextBrowser; upstream = nextUpstream },
    })
    const client = new WebSocket(`ws://127.0.0.1:${appPort}/api/ws`, { origin })
    await new Promise((resolve, reject) => {
      client.once('open', resolve)
      client.once('error', reject)
    })
    const payload = Buffer.alloc(RELAY_BUFFER_CAP + 64 * 1024, 7)
    client.send(payload)
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && !(upstream?.bufferedAmount > RELAY_BUFFER_CAP && browser?._socket?.isPaused())) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(upstream.bufferedAmount).toBeGreaterThan(RELAY_BUFFER_CAP)
    expect(browser._socket.isPaused()).toBe(true)
    peers[0]._socket.resume()
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('drain timed out')), 5000)
      const check = () => {
        if (!browser._socket.isPaused()) { clearTimeout(timer); resolve() }
      }
      browser._socket.on('resume', check)
      upstream._socket.on('drain', check)
      check()
    })
    client.terminate()
    peers.forEach((peer) => peer.terminate())
    gwss.close()
    wss.close()
    await close(app)
    await close(gateway)
  })
})
