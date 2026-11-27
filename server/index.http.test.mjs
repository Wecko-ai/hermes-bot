import { spawn } from 'node:child_process'
import net from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const SESSION_ID = 'testsessionid0123456789abcd'

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

describe('local routes require a real session', () => {
  let appPort
  let child
  let log = ''
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hermesbot-http-'))

  beforeAll(async () => {
    const preload = path.join(dir, 'preload.cjs')
    writeFileSync(preload, `globalThis.__hermesBotSessionPersistence = {
  load: () => ${JSON.stringify(JSON.stringify([{ id: SESSION_ID, kind: 'local', expiresAt: Date.now() + 86_400_000 }]))},
  save: () => {},
}
`)
    appPort = await new Promise((resolve, reject) => {
      const probe = net.createServer()
      probe.listen(0, '127.0.0.1', () => {
        const { port } = probe.address()
        probe.close(() => resolve(port))
      })
      probe.on('error', reject)
    })
    child = spawn(process.execPath, ['--require', preload, 'server/index.mjs'], {
      cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
      env: {
        PATH: process.env.PATH,
        HOME: os.homedir(),
        // This harness keeps the real home. Do not publish Auto into the live shared settings file.
        HERMESBOT_SKIP_AUTO_PUBLISH: '1',
        TMPDIR: os.tmpdir(),
        NODE_ENV: 'production',
        PORT: String(appPort),
        HERMESBOT_NO_PRIVATE: '1',
        HERMESBOT_CONFIG: path.join(dir, 'missing.json'),
        HERMES_ORIGIN: 'http://127.0.0.1:9',
        OMLX_ORIGIN: 'http://127.0.0.1:9',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk) => { log += chunk })
    child.stderr.on('data', (chunk) => { log += chunk })
    const deadline = Date.now() + 8000
    let ready = false
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`http://127.0.0.1:${appPort}/api/health`)).ok) { ready = true; break }
      } catch { /* not up yet */ }
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    if (!ready) throw new Error(`server did not start: ${log}`)
  }, 15_000)

  afterAll(async () => {
    child?.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  })

  it('rejects a forged hermes cookie on the model probe, the browser turn and the computer panel', async () => {
    const forged = { cookie: 'hermes_x=1', origin: `http://127.0.0.1:${appPort}` }
    const paths = [
      ['/api/model-probe', 'POST'],
      ['/api/browser-turn', 'GET'],
      ['/api/computer-panel/status?bot=orion', 'GET'],
      ['/api/computer-panel/stream?bot=orion', 'GET'],
      ['/api/computer-panel/control?bot=orion', 'GET'],
      ['/api/computer-panel/pages?bot=orion', 'GET'],
      ['/api/computer-panel/pages', 'POST'],
      ['/api/computer-panel/remote?bot=orion', 'GET'],
      ['/api/computer-panel/remote', 'POST'],
      ['/api/compaction', 'GET'],
      ['/api/compaction', 'PUT'],
    ]
    for (const [pathname, method] of paths) {
      const response = await fetch(`http://127.0.0.1:${appPort}${pathname}`, { method, headers: forged })
      expect(response.status, pathname).toBe(401)
    }
    const unknown = await fetch(`http://127.0.0.1:${appPort}/api/inconnu`)
    expect(unknown.status).toBe(404)
    expect(unknown.headers.get('content-type')).toContain('application/json')
    expect(await unknown.json()).toEqual({ error: 'not_found' })
  })

  it('compaction writes: foreign origin refused, a malformed setting refused before any call to Hermes', async () => {
    const origin = `http://127.0.0.1:${appPort}`
    const headers = { cookie: `hermesbot_session=${SESSION_ID}`, 'content-type': 'application/json' }
    const body = JSON.stringify({ mode: 'manual', gauge: 0.5, profiles: ['nova'] })
    expect((await fetch(`${origin}/api/compaction`, { method: 'PUT', headers: { ...headers, origin: 'http://evil.example' }, body })).status).toBe(403)
    const none = await fetch(`${origin}/api/compaction`, { method: 'PUT', headers: { ...headers, origin }, body })
    expect(none.status).not.toBe(403)
    for (const bad of [{ mode: 'x', gauge: 0.5, profiles: ['nova'] }, { mode: 'manual', gauge: 5, profiles: ['nova'] }, { mode: 'manual', gauge: 0.5, profiles: ['../x'] }]) {
      expect((await fetch(`${origin}/api/compaction`, { method: 'PUT', headers: { ...headers, origin }, body: JSON.stringify(bad) })).status).toBe(400)
    }
  })
})
