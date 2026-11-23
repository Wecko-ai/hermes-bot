import { execFileSync, spawn } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const SESSION_ID = 'testsessionid0123456789abcd'

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

function sessionPreload(dir, session) {
  const preload = path.join(dir, 'preload.cjs')
  writeFileSync(preload, `globalThis.__hermesBotSessionPersistence = {
  load: () => ${JSON.stringify(JSON.stringify([session]))},
  save: () => {},
}
`)
  return preload
}

async function startServer(config, { vaultPort = 0, vaultTokenFile = '', gatewayOrigin = 'http://127.0.0.1:9', session } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hb-flags-'))
  const home = path.join(dir, 'home')
  mkdirSync(home, { recursive: true })
  const configPath = path.join(dir, 'config.json')
  writeFileSync(configPath, JSON.stringify(config))
  const preload = sessionPreload(dir, session || { id: SESSION_ID, kind: 'local', expiresAt: Date.now() + 86_400_000 })
  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port: free } = probe.address()
      probe.close(() => resolve(free))
    })
    probe.on('error', reject)
  })
  const env = {
    PATH: process.env.PATH,
    HOME: path.join(dir, 'home'),
    TMPDIR: os.tmpdir(),
    NODE_ENV: 'production',
    PORT: String(port),
    HERMESBOT_NO_PRIVATE: '1',
    HERMESBOT_CONFIG: configPath,
    HERMES_ORIGIN: gatewayOrigin,
    OLLAMA_ORIGIN: gatewayOrigin,
  }
  if (vaultPort) {
    env.BROWSER_VAULT_PORT = String(vaultPort)
    env.HERMESBOT_VAULT_TOKEN_FILE = vaultTokenFile || path.join(dir, 'vault.token')
    if (!vaultTokenFile) writeFileSync(env.HERMESBOT_VAULT_TOKEN_FILE, 'test-token-32-chars-minimum-pad')
  }
  if (config.computerPanel?.cdpOrigin) {
    env.HERMESBOT_COMPUTER_CDP_ORIGIN = config.computerPanel.cdpOrigin
  }
  const child = spawn(process.execPath, ['--require', preload, 'server/index.mjs'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (chunk) => { log += chunk })
  child.stderr.on('data', (chunk) => { log += chunk })
  const origin = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${origin}/api/health`)).ok) {
        return { origin, child, dir, stop: () => { child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }) } }
      }
    } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  child.kill('SIGKILL')
  rmSync(dir, { recursive: true, force: true })
  throw new Error(`server did not start: ${log}`)
}

function authHeaders(origin) {
  return { cookie: `hermesbot_session=${SESSION_ID}`, origin, accept: 'application/json' }
}

describe('feature flags — routes off by default', () => {
  let server

  beforeAll(async () => {
    server = await startServer({
      features: { usageGlobal: true, vaultWallet: false, pagesLibrary: false },
      computerPanel: { enabled: false },
    })
  }, 20_000)

  afterAll(() => server?.stop())

  it('hides wallet, pages library and computer panel APIs', async () => {
    const h = authHeaders(server.origin)
    expect((await fetch(`${server.origin}/api/browser-vault/wallet`, { headers: h })).status).toBe(404)
    expect((await fetch(`${server.origin}/api/pages-library?profile=orion`, { headers: h })).status).toBe(404)
    expect((await fetch(`${server.origin}/api/computer-panel/status?bot=orion`, { headers: h })).status).toBe(404)
  })
})

describe('feature flags — pages library on', () => {
  let server
  let pagesDir

  beforeAll(async () => {
    pagesDir = mkdtempSync(path.join(os.tmpdir(), 'hb-pages-api-'))
    server = await startServer({
      features: { vaultWallet: false, pagesLibrary: true },
      computerPanel: { enabled: false },
      pagesLibraryDir: pagesDir,
    })
  }, 20_000)

  afterAll(() => server?.stop())

  it('creates the library folder, lists and archives a page', async () => {
    const h = { ...authHeaders(server.origin), 'content-type': 'application/json' }
    const touch = await fetch(`${server.origin}/api/pages-library`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ action: 'touch', profile: 'orion', path: '/tmp/note.md', name: 'note.md', title: 'Note' }),
    })
    expect(touch.status).toBe(200)
    const list = await (await fetch(`${server.origin}/api/pages-library?profile=orion`, { headers: authHeaders(server.origin) })).json()
    expect(list.items?.some((item) => item.path === '/tmp/note.md')).toBe(true)
    const id = list.items.find((item) => item.path === '/tmp/note.md').id
    const archive = await fetch(`${server.origin}/api/pages-library`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ action: 'archive', profile: 'orion', id }),
    })
    expect(archive.status).toBe(200)
    const active = await (await fetch(`${server.origin}/api/pages-library?profile=orion`, { headers: authHeaders(server.origin) })).json()
    expect(active.items).toHaveLength(0)
  })
})

describe('feature flags — computer panel on', () => {
  let cdpServer
  let cdpWss
  let cdpPort
  let server

  beforeAll(async () => {
    cdpServer = http.createServer((request, response) => {
      if (request.url === '/json/list') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify([{
          id: 'tab1',
          type: 'page',
          url: 'https://example.test/page',
          title: 'Example',
          webSocketDebuggerUrl: `ws://127.0.0.1:${cdpPort}/devtools/page/tab1`,
        }]))
        return
      }
      response.statusCode = 404
      response.end()
    })
    cdpPort = await listen(cdpServer)
    cdpWss = new WebSocketServer({ noServer: true })
    cdpWss.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const frame = JSON.parse(String(raw))
        const { id, method, params } = frame
        if (method === 'Page.enable' || method === 'Page.startScreencast' || method === 'Page.stopScreencast') {
          socket.send(JSON.stringify({ id, result: {} }))
          if (method === 'Page.startScreencast') {
            socket.send(JSON.stringify({
              method: 'Page.screencastFrame',
              params: { data: Buffer.from('jpeg').toString('base64'), sessionId: 's1', metadata: { deviceWidth: 640, deviceHeight: 480 } },
            }))
          }
          return
        }
        if (method === 'Page.screencastFrameAck') return
        if (method === 'Runtime.evaluate' && String(params?.expression || '').includes('location.href')) {
          socket.send(JSON.stringify({ id, result: { result: { value: { url: 'https://example.test/page', title: 'Example' } } } }))
          return
        }
        socket.send(JSON.stringify({ id, error: { message: 'unsupported' } }))
      })
    })
    cdpServer.on('upgrade', (request, socket, head) => {
      if (!request.url?.startsWith('/devtools/page/')) return socket.destroy()
      cdpWss.handleUpgrade(request, socket, head, (client) => cdpWss.emit('connection', client))
    })
    server = await startServer({
      features: { vaultWallet: false, pagesLibrary: false },
      computerPanel: { enabled: true, cdpOrigin: `http://127.0.0.1:${cdpPort}` },
    })
  }, 25_000)

  afterAll(async () => {
    server?.stop()
    if (cdpWss) await new Promise((resolve) => cdpWss.close(resolve))
    if (cdpServer) await new Promise((resolve) => cdpServer.close(resolve))
  })

  it('exposes the configured CDP origin (idle until a stream attaches)', async () => {
    const response = await fetch(`${server.origin}/api/computer-panel/status?bot=orion`, { headers: authHeaders(server.origin) })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.enabled).toBe(true)
    expect(body.origin).toBe(`http://127.0.0.1:${cdpPort}`)
    expect(body.state).toBe('idle')
  })

  it('reports chrome_unconfigured when CDP is not set up', async () => {
    const bare = await startServer({
      features: { vaultWallet: false, pagesLibrary: false },
      computerPanel: { enabled: true },
    })
    try {
      const response = await fetch(`${bare.origin}/api/computer-panel/status?bot=orion`, { headers: authHeaders(bare.origin) })
      expect(response.status).toBe(503)
      expect((await response.json()).error).toBe('chrome_unconfigured')
    } finally {
      bare.stop()
    }
  })
})

describe.skipIf(process.platform !== 'darwin')('feature flags — vault wallet on', () => {
  let server
  let vaultChild
  let vaultDir
  let keychain
  let mockGateway
  let gatewayOrigin

  beforeAll(async () => {
    vaultDir = mkdtempSync(path.join(os.tmpdir(), 'hb-wallet-vault-'))
    keychain = path.join(vaultDir, 'wallet.keychain-db')
    const tokenFile = path.join(vaultDir, 'token')
    writeFileSync(tokenFile, 'e2e-wallet-token-32-chars-minimum-xx')
    for (const args of [['create-keychain', '-p', 'test', keychain], ['unlock-keychain', '-p', 'test', keychain], ['set-keychain-settings', keychain]]) {
      execFileSync('/usr/bin/security', args)
    }
    mockGateway = http.createServer((request, response) => {
      if (request.url === '/api/auth/me') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{"username":"test"}')
        return
      }
      response.statusCode = 404
      response.end('{}')
    })
    const gatewayPort = await listen(mockGateway)
    gatewayOrigin = `http://127.0.0.1:${gatewayPort}`
    const vaultPort = await new Promise((resolve, reject) => {
      const probe = net.createServer()
      probe.listen(0, '127.0.0.1', () => {
        const { port } = probe.address()
        probe.close(() => resolve(port))
      })
      probe.on('error', reject)
    })
    vaultChild = spawn(process.execPath, ['server/browser-vault/standalone.mjs'], {
      cwd: ROOT,
      env: {
        ...process.env,
        BROWSER_VAULT_PORT: String(vaultPort),
        HERMESBOT_KEYCHAIN: keychain,
        HERMESBOT_VAULT_TOKEN_FILE: tokenFile,
        HERMES_ORIGIN: gatewayOrigin,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let vaultLog = ''
    vaultChild.stdout.on('data', (c) => { vaultLog += c })
    vaultChild.stderr.on('data', (c) => { vaultLog += c })
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && !vaultLog.includes('HermesBot vault on')) await new Promise((r) => setTimeout(r, 50))
    if (!vaultLog.includes('HermesBot vault on')) throw new Error(`vault failed: ${vaultLog}`)
    const passwordSession = {
      id: SESSION_ID,
      kind: 'password',
      expiresAt: Date.now() + 86_400_000,
      cookieHeader: 'hermes_session=testcookie',
    }
    server = await startServer({
      features: { vaultWallet: true, pagesLibrary: false },
      computerPanel: { enabled: false },
    }, { vaultPort, vaultTokenFile: tokenFile, gatewayOrigin, session: passwordSession })
  }, 40_000)

  afterAll(() => {
    server?.stop()
    vaultChild?.kill('SIGKILL')
    if (mockGateway) mockGateway.close()
    try { execFileSync('/usr/bin/security', ['delete-keychain', keychain], { stdio: 'ignore' }) } catch { /* gone */ }
    rmSync(vaultDir, { recursive: true, force: true })
  })

  it('stores a card and never returns the full number', async () => {
    const h = { ...authHeaders(server.origin), 'content-type': 'application/json' }
    const save = await fetch(`${server.origin}/api/browser-vault/wallet/card`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ label: 'Test', holder: 'Alex', number: '4111111111114242', expiry: '12/30', bots: ['orion'] }),
    })
    expect(save.status).toBe(200)
    const saveBody = await save.json()
    expect(saveBody.entry?.last4).toBe('4242')
    expect(JSON.stringify(saveBody)).not.toContain('4111')
    const list = await (await fetch(`${server.origin}/api/browser-vault/wallet`, { headers: authHeaders(server.origin) })).json()
    const text = JSON.stringify(list)
    expect(text).toContain('4242')
    expect(text).not.toContain('4111')
    const refs = await fetch(`${server.origin}/api/browser-vault/wallet/secure-form`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({
        bots: ['orion'],
        fields: [{ key: 'c', kind: 'card', label: 'Card', value: '4000000000000002', holder: 'A', expiry: '01/29' }],
      }),
    })
    expect(refs.status).toBe(200)
    const refBody = await refs.json()
    expect(refBody.refs?.[0]?.ref).toMatch(/^hbvault:card:/)
    expect(JSON.stringify(refBody)).not.toContain('0002".')
  })

  it('returns 503 when the vault service is down', async () => {
    const orphan = await startServer({
      features: { vaultWallet: true, pagesLibrary: false },
      computerPanel: { enabled: false },
    }, { vaultPort: 1 })
    try {
      const response = await fetch(`${orphan.origin}/api/browser-vault/wallet`, { headers: authHeaders(orphan.origin) })
      expect(response.status).toBe(503)
      expect((await response.json()).error).toBe('vault_service_unavailable')
    } finally {
      orphan.stop()
    }
  })
})