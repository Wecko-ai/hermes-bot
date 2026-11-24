import { spawn } from 'node:child_process'
import http from 'node:http'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  defaultVideoRoots,
  parseByteRange,
  resolveVideoFile,
  serveVideoFile,
  videoRootList,
  posterRouteDecision,
  videoRouteDecision,
} from './video-stream.mjs'

const bytes = (text) => Buffer.from(text)

describe('parseByteRange', () => {
  it('serves the whole file when there is no range', () => {
    expect(parseByteRange(undefined, 5)).toEqual({ start: 0, end: 4, partial: false })
    expect(parseByteRange('', 5)).toEqual({ start: 0, end: 4, partial: false })
  })

  it('reads a closed range, an open range, and a suffix', () => {
    expect(parseByteRange('bytes=1-3', 5)).toEqual({ start: 1, end: 3, partial: true })
    expect(parseByteRange('bytes=1-', 5)).toEqual({ start: 1, end: 4, partial: true })
    expect(parseByteRange('bytes=-2', 5)).toEqual({ start: 3, end: 4, partial: true })
    expect(parseByteRange('  bytes=0-0  ', 5)).toEqual({ start: 0, end: 0, partial: true })
  })

  it('clamps a last byte past the end and ignores a range it cannot read', () => {
    expect(parseByteRange('bytes=1-99', 5)).toEqual({ start: 1, end: 4, partial: true })
    expect(parseByteRange('bytes=3-1', 5)).toEqual({ start: 0, end: 4, partial: false })
    expect(parseByteRange('bytes=0-1,2-3', 5)).toEqual({ start: 0, end: 4, partial: false })
    expect(parseByteRange('items=0-1', 5)).toEqual({ start: 0, end: 4, partial: false })
  })

  it('refuses a range that starts past the end or a suffix of an empty file', () => {
    expect(parseByteRange('bytes=5-5', 5)).toEqual({ unsatisfiable: true, size: 5 })
    expect(parseByteRange('bytes=5-', 5)).toEqual({ unsatisfiable: true, size: 5 })
    expect(parseByteRange('bytes=-1', 0)).toEqual({ unsatisfiable: true, size: 0 })
    expect(parseByteRange('bytes=-0', 5)).toEqual({ unsatisfiable: true, size: 5 })
  })
})

describe('video roots', () => {
  it('defaults to the bots’ project, media and profile folders', () => {
    expect(defaultVideoRoots('/Users/test')).toEqual([
      '/Users/test/projects',
      '/Users/test/Movies',
      '/Users/test/bots-workspace',
      '/Users/test/.hermes/images',
      '/Users/test/.hermes/cache',
      '/Users/test/.hermes/profiles',
    ])
  })

  it('reads an explicit list from the environment and drops traversal', () => {
    const roots = videoRootList(['~/renders', '/nope/../etc'], { HERMESBOT_VIDEO_ROOTS: '/srv/media' }, '/Users/test')
    expect(roots).toEqual(['/srv/media', '/Users/test/renders'])
  })
})

describe('resolveVideoFile', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'hermesbot-video-'))
  const root = path.join(home, 'projects')
  const outside = path.join(home, 'outside')
  mkdirSync(root, { recursive: true })
  mkdirSync(outside, { recursive: true })
  const clip = path.join(root, 'renders', 'clip.mp4')
  mkdirSync(path.dirname(clip), { recursive: true })
  writeFileSync(clip, 'hello-video')
  writeFileSync(path.join(outside, 'secret.mp4'), 'secret')
  writeFileSync(path.join(root, 'notes.txt'), 'notes')
  symlinkSync(path.join(outside, 'secret.mp4'), path.join(root, 'escape.mp4'))
  symlinkSync(outside, path.join(root, 'linked-dir'))
  symlinkSync(path.join(root, 'notes.txt'), path.join(root, 'notes.mp4'))
  mkdirSync(path.join(root, 'dir.mp4'))

  const open = (file) => resolveVideoFile(file, [root], { home })

  it('opens a render inside the allowlist', async () => {
    const opened = await open(clip)
    expect(opened.ok).toBe(true)
    expect(opened.size).toBe(bytes('hello-video').length)
    expect(opened.contentType).toBe('video/mp4')
  })

  it('refuses traversal, a file outside the allowlist, and a symlink that leaves it', async () => {
    expect(await open(`${root}/../outside/secret.mp4`)).toMatchObject({ status: 400, error: 'invalid_path' })
    expect(await open(path.join(root, '..', 'outside', 'secret.mp4'))).toMatchObject({ status: 403, error: 'media_forbidden' })
    expect(await open(path.join(outside, 'secret.mp4'))).toMatchObject({ status: 403, error: 'media_forbidden' })
    expect(await open(path.join(root, 'escape.mp4'))).toMatchObject({ status: 403, error: 'media_forbidden' })
    expect(await open(path.join(root, 'linked-dir', 'secret.mp4'))).toMatchObject({ status: 403, error: 'media_forbidden' })
    expect(await open('relatif/clip.mp4')).toMatchObject({ status: 400 })
    expect(await open(`${root}/`)).toMatchObject({ status: 400 })
  })

  it('refuses a directory and a link whose real type is not a video', async () => {
    expect(await open(path.join(root, 'dir.mp4'))).toMatchObject({ status: 403, error: 'media_forbidden' })
    expect(await open(path.join(root, 'notes.mp4'))).toMatchObject({ status: 415, error: 'unsupported_media' })
  })

  it('reports a missing allowlisted file as absent, so a remote desktop can relay it', async () => {
    expect(await open(path.join(root, 'renders', 'missing.mp4'))).toMatchObject({ status: 404, error: 'media_not_found' })
  })
})

describe('posterRouteDecision', () => {
  it('serves a local frame and asks the gateway when the file is not on this machine', () => {
    expect(posterRouteDecision({ authed: false, opened: { ok: false, status: 404 } })).toMatchObject({ action: 'deny', status: 401 })
    expect(posterRouteDecision({ authed: true, opened: { ok: true } })).toEqual({ action: 'serve' })
    expect(posterRouteDecision({ authed: true, opened: { ok: false, status: 404, error: 'media_not_found' } })).toEqual({ action: 'relay' })
    expect(posterRouteDecision({ authed: true, opened: { ok: false, status: 403, error: 'media_forbidden' } })).toMatchObject({ action: 'deny', status: 403 })
    expect(posterRouteDecision({ authed: true, opened: { ok: false, status: 400, error: 'invalid_path' } })).toMatchObject({ action: 'deny', status: 400 })
  })
})

describe('videoRouteDecision', () => {
  it('requires a session, serves a local file, relays a missing one, and denies the rest', () => {
    expect(videoRouteDecision({ authed: false, opened: { ok: true } })).toMatchObject({ action: 'deny', status: 401 })
    expect(videoRouteDecision({ authed: true, opened: { ok: true } })).toEqual({ action: 'serve' })
    expect(videoRouteDecision({ authed: true, opened: { ok: false, status: 404, error: 'media_not_found' } })).toEqual({ action: 'relay' })
    expect(videoRouteDecision({ authed: true, opened: { ok: false, status: 403, error: 'media_forbidden' } })).toMatchObject({ action: 'deny', status: 403 })
  })
})

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

describe('serveVideoFile', () => {
  it('answers 200, 206, 416 and HEAD', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hermesbot-video-http-'))
    const file = path.join(dir, 'clip.mp4')
    writeFileSync(file, 'hello')
    const opened = { ok: true, file, size: 5, contentType: 'video/mp4' }
    const server = http.createServer((request, response) => serveVideoFile(request, response, opened))
    const port = await listen(server)
    try {
      const full = await fetch(`http://127.0.0.1:${port}/clip.mp4`)
      expect(full.status).toBe(200)
      expect(await full.text()).toBe('hello')
      expect(full.headers.get('accept-ranges')).toBe('bytes')
      expect(full.headers.get('content-type')).toBe('video/mp4')
      const partial = await fetch(`http://127.0.0.1:${port}/clip.mp4`, { headers: { Range: 'bytes=1-3' } })
      expect(partial.status).toBe(206)
      expect(partial.headers.get('content-range')).toBe('bytes 1-3/5')
      expect(await partial.text()).toBe('ell')
      const head = await fetch(`http://127.0.0.1:${port}/clip.mp4`, { method: 'HEAD', headers: { Range: 'bytes=0-1' } })
      expect(head.status).toBe(206)
      expect(head.headers.get('content-length')).toBe('2')
      expect(await head.text()).toBe('')
      const past = await fetch(`http://127.0.0.1:${port}/clip.mp4`, { headers: { Range: 'bytes=9-9' } })
      expect(past.status).toBe(416)
      expect(past.headers.get('content-range')).toBe('bytes */5')
    } finally {
      server.close()
    }
  })
})

describe('/api/video on the server', () => {
  it('refuses an anonymous request and streams an allowlisted file with Range', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hermesbot-video-app-'))
    const root = path.join(dir, 'projects')
    mkdirSync(path.join(root, 'renders'), { recursive: true })
    const clip = path.join(root, 'renders', 'clip.mp4')
    writeFileSync(clip, 'hello-video')
    const session = 'testsessionid0123456789abcd'
    const preload = path.join(dir, 'preload.cjs')
    writeFileSync(preload, `globalThis.__hermesBotSessionPersistence = {
  load: () => ${JSON.stringify(JSON.stringify([{ id: session, kind: 'cookie', cookies: {}, cookieHeader: '', expiresAt: Date.now() + 86_400_000 }]))},
  save: () => {},
}
`)
    const port = await new Promise((resolve, reject) => {
      const probe = http.createServer()
      probe.listen(0, '127.0.0.1', () => {
        const { port: free } = probe.address()
        probe.close(() => resolve(free))
      })
      probe.on('error', reject)
    })
    const child = spawn(process.execPath, ['--require', preload, 'server/index.mjs'], {
      cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        TMPDIR: os.tmpdir(),
        NODE_ENV: 'production',
        PORT: String(port),
        HERMESBOT_NO_PRIVATE: '1',
        HERMESBOT_CONFIG: path.join(dir, 'missing.json'),
        HERMESBOT_VIDEO_ROOTS: root,
        HERMES_ORIGIN: 'http://127.0.0.1:9',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let log = ''
    child.stdout.on('data', (chunk) => { log += chunk })
    child.stderr.on('data', (chunk) => { log += chunk })
    const deadline = Date.now() + 8000
    let ready = false
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) { ready = true; break }
      } catch { /* not up yet */ }
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    if (!ready) {
      child.kill()
      throw new Error(`server did not start: ${log}`)
    }
    try {
      const query = new URLSearchParams({ profile: 'studio', path: clip })
      const anonymous = await fetch(`http://127.0.0.1:${port}/api/video?${query}`)
      expect(anonymous.status).toBe(401)
      const outside = path.join(dir, 'secret.mp4')
      writeFileSync(outside, 'nope')
      const denied = await fetch(`http://127.0.0.1:${port}/api/video?${new URLSearchParams({ profile: 'studio', path: outside })}`, {
        headers: { Cookie: `hermesbot_session=${session}` },
      })
      expect(denied.status).toBe(403)
      const partial = await fetch(`http://127.0.0.1:${port}/api/video?${query}`, {
        headers: { Cookie: `hermesbot_session=${session}`, Range: 'bytes=0-4' },
      })
      expect(partial.status).toBe(206)
      expect(partial.headers.get('content-type')).toBe('video/mp4')
      expect(partial.headers.get('content-range')).toBe('bytes 0-4/11')
      expect(await partial.text()).toBe('hello')
      const slipped = await fetch(`http://127.0.0.1:${port}/api/video?${new URLSearchParams({ profile: 'studio', path: `${root}/../../secret.mp4` })}`, {
        headers: { Cookie: `hermesbot_session=${session}` },
      })
      expect(slipped.status).toBe(400)
    } finally {
      child.kill()
    }
  })
})
