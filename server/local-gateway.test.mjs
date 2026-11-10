import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import { createLocalGateway, holdsPeer, listensOn, loopbackPort, ownedBy, parseIdentify } from './local-gateway.mjs'

const TOKEN = 'A'.repeat(43)

describe('helpers', () => {
  it('only takes plain http on this machine', () => {
    expect(loopbackPort('http://127.0.0.1:9120')).toBe(9120)
    expect(loopbackPort('http://localhost:9120')).toBe(9120)
    expect(loopbackPort('http://[::1]:9120')).toBeNull()
    expect(loopbackPort('https://127.0.0.1:9120')).toBeNull()
    expect(loopbackPort('http://192.168.1.10:9120')).toBeNull()
    expect(loopbackPort('http://hermes.example.test')).toBeNull()
    expect(loopbackPort('not a url')).toBeNull()
  })

  it('reads the process and the home of an identify answer, and nothing else', () => {
    const answer = (extra) => JSON.stringify({ ok: true, protocol: 1, id: 1, result: { pid: 4242, hermes_home: '/h', ...extra } })
    expect(parseIdentify(answer({}))).toEqual({ pid: 4242, home: '/h' })
    expect(parseIdentify(answer({ pid: 1 }))).toBeNull()
    expect(parseIdentify(answer({ pid: '4242' }))).toBeNull()
    expect(parseIdentify(answer({ hermes_home: undefined }))).toBeNull()
    expect(parseIdentify(JSON.stringify({ ok: false, protocol: 1, id: 1, result: { pid: 4242, hermes_home: '/h' } }))).toBeNull()
    expect(parseIdentify(JSON.stringify({ ok: true, protocol: 2, id: 1, result: { pid: 4242, hermes_home: '/h' } }))).toBeNull()
    expect(parseIdentify('not json')).toBeNull()
  })

  it('needs a listener on the exact address, and the other end of the exact connection', () => {
    expect(listensOn('p4242\nf6\nn127.0.0.1:9120\n', 9120)).toBe(true)
    expect(listensOn('p4242\nf6\nn*:9120\n', 9120)).toBe(false)
    expect(listensOn('p4242\nf6\nn[::1]:9120\n', 9120)).toBe(false)
    expect(listensOn('p4242\nf6\nn127.0.0.1:91200\n', 9120)).toBe(false)
    expect(listensOn('', 9120)).toBe(false)
    expect(holdsPeer('p4242\nf7\nn127.0.0.1:9120->127.0.0.1:50001\n', 9120, 50001)).toBe(true)
    expect(holdsPeer('p4242\nf7\nn127.0.0.1:9120->127.0.0.1:50002\n', 9120, 50001)).toBe(false)
    expect(holdsPeer('p4242\nf6\nn127.0.0.1:9120\n', 9120, 50001)).toBe(false)
  })

  it('refuses what another account can change, or read when closed is asked', () => {
    expect(ownedBy({ uid: 501, mode: 0o40700 }, 501)).toBe(true)
    expect(ownedBy({ uid: 501, mode: 0o40755 }, 501)).toBe(true)
    expect(ownedBy({ uid: 501, mode: 0o40775 }, 501)).toBe(false)
    expect(ownedBy({ uid: 502, mode: 0o40700 }, 501)).toBe(false)
    expect(ownedBy({ uid: 501, mode: 0o100644 }, 501, { closed: true })).toBe(false)
    expect(ownedBy({ uid: 501, mode: 0o100600 }, 501, { closed: true })).toBe(true)
  })
})

describe('createLocalGateway', () => {
  let home
  let control
  let identify
  let statusBody
  let statusCalls
  let listening
  let peerSeen
  let upstream
  let port
  let received

  // lsof as the module reads it: the listener line, and one line per connection this process holds.
  const fakeLsof = (pid) => {
    if (pid !== 4242) return ''
    const lines = [`p${pid}`]
    if (listening) lines.push('f6', `n127.0.0.1:${port}`)
    if (peerSeen) for (const local of peerSeen()) lines.push('f7', `n127.0.0.1:${port}->127.0.0.1:${local}`)
    return `${lines.join('\n')}\n`
  }

  const gateway = (options = {}) => createLocalGateway({
    gatewayOrigin: options.origin || `http://127.0.0.1:${port}`,
    hermesHome: home,
    deps: {
      fetch: async () => {
        statusCalls += 1
        if (statusBody === null) throw new Error('down')
        return new Response(JSON.stringify(statusBody), { status: 200 })
      },
      lsofSockets: async (pid) => fakeLsof(pid),
    },
  })

  beforeEach(async () => {
    home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'hb-')))
    chmodSync(home, 0o700)
    mkdirSync(path.join(home, 'webapp'), { mode: 0o700 })
    writeFileSync(path.join(home, 'webapp', 'session-token'), `${TOKEN}\n`, { mode: 0o600 })
    statusBody = { auth_required: false }
    statusCalls = 0
    listening = true
    received = []
    const clients = new Set()
    upstream = http.createServer((request, response) => {
      received.push({ url: request.url, token: request.headers['x-hermes-session-token'], host: request.headers.host })
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ ok: true }))
    })
    upstream.on('connection', (socket) => { clients.add(socket.remotePort); socket.on('close', () => clients.delete(socket.remotePort)) })
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    port = upstream.address().port
    peerSeen = () => [...clients]
    identify = { ok: true, protocol: 1, id: 1, result: { pid: 4242, hermes_home: home } }
    control = net.createServer((socket) => socket.once('data', () => socket.end(`${JSON.stringify(identify)}\n`)))
    await new Promise((resolve) => control.listen(path.join(home, 'gateway.sock'), resolve))
  })

  afterEach(async () => {
    await new Promise((resolve) => control.close(resolve))
    upstream.closeAllConnections?.()
    await new Promise((resolve) => upstream.close(resolve))
    rmSync(home, { recursive: true, force: true })
  })

  it('is available when this user’s own gateway holds the port, and keeps the token to itself', async () => {
    expect(await gateway().check()).toEqual({ ok: true })
  })

  it('sends the token on a connection whose other end is the gateway', async () => {
    const response = await gateway().fetch('/api/auth/me', { headers: { accept: 'application/json' } })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(received).toEqual([{ url: '/api/auth/me', token: TOKEN, host: `127.0.0.1:${port}` }])
  })

  it('sends nothing when another process holds the other end of the connection', async () => {
    // The port answers, but the gateway's process does not hold this connection: taken over, or tunneled.
    peerSeen = () => []
    await expect(gateway().fetch('/api/auth/me')).rejects.toMatchObject({ status: 401, reason: 'gateway_elsewhere' })
    expect(received).toEqual([])
  })

  it('sends nothing when any earlier check fails', async () => {
    identify = { ok: false }
    await expect(gateway().fetch('/api/auth/me')).rejects.toMatchObject({ status: 401, reason: 'gateway_not_running' })
    expect(received).toEqual([])
  })

  it('stays off when Hermes asks for a sign-in', async () => {
    statusBody = { auth_required: true, auth_providers: ['basic'] }
    expect(await gateway().check()).toEqual({ ok: false, reason: 'password_required' })
    statusBody = {}
    expect(await gateway().check()).toEqual({ ok: false, reason: 'password_required' })
  })

  it('stays off when nothing answers, or when the gateway is not on this machine', async () => {
    statusBody = null
    expect(await gateway().check()).toEqual({ ok: false, reason: 'gateway_down' })
    statusBody = { auth_required: false }
    expect(await gateway({ origin: 'http://192.168.1.10:9120' }).check()).toEqual({ ok: false, reason: 'not_local' })
    expect(await gateway({ origin: 'https://127.0.0.1:9120' }).check()).toEqual({ ok: false, reason: 'not_local' })
    expect(await gateway({ origin: 'http://[::1]:9120' }).check()).toEqual({ ok: false, reason: 'not_local' })
  })

  it('is not available when the gateway of this home does not listen on that exact address', async () => {
    // An SSH tunnel, or a process of another account: the port answers, but not as this home’s gateway.
    listening = false
    expect(await gateway().check()).toEqual({ ok: false, reason: 'gateway_elsewhere' })
  })

  it('needs the gateway of this very home on its control socket', async () => {
    identify.result.hermes_home = path.join(home, 'webapp')
    expect(await gateway().check()).toEqual({ ok: false, reason: 'gateway_not_running' })
    identify = { ok: false, error: 'unknown verb' }
    expect(await gateway().check()).toEqual({ ok: false, reason: 'gateway_not_running' })
  })

  it('refuses a home that another account can write to', async () => {
    chmodSync(home, 0o777)
    expect(await gateway().check()).toEqual({ ok: false, reason: 'unsafe_home' })
  })

  it('refuses a token that is open to others, linked or malformed', async () => {
    const file = path.join(home, 'webapp', 'session-token')
    chmodSync(file, 0o644)
    expect(await gateway().check()).toEqual({ ok: false, reason: 'no_token' })
    rmSync(file)
    writeFileSync(path.join(home, 'elsewhere'), `${TOKEN}\n`, { mode: 0o600 })
    symlinkSync(path.join(home, 'elsewhere'), file)
    expect(await gateway().check()).toEqual({ ok: false, reason: 'no_token' })
    rmSync(file)
    writeFileSync(file, 'too-short\n', { mode: 0o600 })
    expect(await gateway().check()).toEqual({ ok: false, reason: 'no_token' })
    rmSync(file)
    expect(await gateway().check()).toEqual({ ok: false, reason: 'no_token' })
  })

  it('keeps only the public status for a moment, never a refusal, and asks again when told', async () => {
    const local = gateway()
    await local.check()
    await local.check()
    expect(statusCalls).toBe(1)
    local.invalidate()
    await local.check()
    expect(statusCalls).toBe(2)
    // The process and the token are read again at each use: a gateway gone since the last call is seen at once.
    const answer = identify
    identify = { ok: false }
    expect(await local.check()).toEqual({ ok: false, reason: 'gateway_not_running' })
    identify = answer

    const down = gateway()
    statusBody = null
    await down.check()
    statusBody = { auth_required: false }
    expect((await down.check()).ok).toBe(true)
  })
})
