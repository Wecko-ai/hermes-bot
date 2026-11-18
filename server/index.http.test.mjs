import { spawn } from 'node:child_process'
import http from 'node:http'
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
  let ollama
  let generateAborted = false
  let generateSeen = false
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hermesbot-http-'))

  beforeAll(async () => {
    ollama = http.createServer((request, response) => {
      if (request.url === '/api/tags') {
        response.end(JSON.stringify({ models: [{ name: 'model:7b' }] }))
        return
      }
      if (request.url === '/api/generate') {
        generateSeen = true
        request.on('aborted', () => { generateAborted = true })
        request.on('close', () => { if (!response.writableEnded) generateAborted = true })
        response.writeHead(200, { 'content-type': 'application/json' })
        return
      }
      response.statusCode = 404
      response.end('{}')
    })
    const ollamaPort = await listen(ollama)
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
        TMPDIR: os.tmpdir(),
        NODE_ENV: 'production',
        PORT: String(appPort),
        HERMESBOT_NO_PRIVATE: '1',
        HERMESBOT_CONFIG: path.join(dir, 'missing.json'),
        HERMES_ORIGIN: 'http://127.0.0.1:9',
        OLLAMA_ORIGIN: `http://127.0.0.1:${ollamaPort}`,
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
    if (ollama) await new Promise((resolve) => ollama.close(resolve))
    rmSync(dir, { recursive: true, force: true })
  })

  it('rejects a forged hermes cookie on local chat and the browser turn', async () => {
    const forged = { cookie: 'hermes_x=1', origin: `http://127.0.0.1:${appPort}` }
    const paths = [
      ['/api/local-chat/models', 'GET'],
      ['/api/local-chat/status', 'GET'],
      ['/api/local-chat', 'POST'],
      ['/api/local-chat/load', 'POST'],
      ['/api/model-probe', 'POST'],
      ['/api/local-chat/unload', 'POST'],
      ['/api/browser-turn', 'GET'],
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

  it('aborts an in-flight load when the client disconnects and refuses a second load', async () => {
    const origin = `http://127.0.0.1:${appPort}`
    const headers = {
      origin,
      cookie: `hermesbot_session=${SESSION_ID}`,
      'content-type': 'application/json',
    }
    const body = JSON.stringify({ model: 'model:7b' })
    const caller = new AbortController()
    const first = fetch(`${origin}/api/local-chat/load`, { method: 'POST', headers, body, signal: caller.signal })
    const deadline = Date.now() + 4000
    while (!generateSeen && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
    expect(generateSeen).toBe(true)
    const second = await fetch(`${origin}/api/local-chat/load`, { method: 'POST', headers, body })
    expect(second.status).toBe(409)
    caller.abort()
    await first.catch(() => {})
    const abortDeadline = Date.now() + 2000
    while (!generateAborted && Date.now() < abortDeadline) await new Promise((resolve) => setTimeout(resolve, 20))
    expect(generateAborted).toBe(true)
  })
})
