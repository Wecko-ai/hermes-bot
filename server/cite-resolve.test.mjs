import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { hasParentSegment, resetCitedCache, resolveCitedFile } from './cite-resolve.mjs'
import { posterSeek, ensureVideoPoster } from './video-poster.mjs'
import { VIDEO_CONTENT_TYPES } from './video-stream.mjs'

const types = VIDEO_CONTENT_TYPES

describe('resolveCitedFile', () => {
  it('rejects a parent segment, including a percent-encoded one', async () => {
    expect(hasParentSegment('../1112.mov')).toBe(true)
    expect(hasParentSegment('/a/%2e%2e/1112.mov')).toBe(true)
    expect(await resolveCitedFile('../1112.mov', { roots: ['/tmp'], types })).toMatchObject({ ok: false, status: 400 })
    expect(await resolveCitedFile('/tmp/%2e%2e/1112.mov', { roots: ['/tmp'], types })).toMatchObject({ ok: false, status: 400 })
  })

  it('resolves a relative path under a root and a unique basename', async () => {
    resetCitedCache()
    const root = mkdtempSync(path.join(os.tmpdir(), 'hermesbot-cite-'))
    const clip = path.join(root, 'capcut', '1112.mov')
    mkdirSync(path.dirname(clip), { recursive: true })
    writeFileSync(clip, 'clip')
    const twin = path.join(root, 'elsewhere', '1112.mov')
    mkdirSync(path.dirname(twin), { recursive: true })
    writeFileSync(twin, 'twin')
    const relative = await resolveCitedFile('capcut/1112.mov', { roots: [root], types, search: async () => [] })
    expect(relative.ok).toBe(true)
    expect(relative.file).toBe(await realpath(clip))

    resetCitedCache()
    const named = await resolveCitedFile('1112.mov', { roots: [root], types, search: async () => [clip] })
    expect(named.file).toBe(await realpath(clip))

    resetCitedCache()
    const ambiguous = await resolveCitedFile('1112.mov', {
      roots: [root],
      types,
      search: async () => [clip, twin],
    })
    expect(ambiguous).toMatchObject({ ok: false, status: 404 })
  })

  it('prefers the session workspace over a search', async () => {
    resetCitedCache()
    const root = mkdtempSync(path.join(os.tmpdir(), 'hermesbot-cite-ws-'))
    const workspace = path.join(root, 'work')
    mkdirSync(workspace, { recursive: true })
    const local = path.join(workspace, '1112.mov')
    writeFileSync(local, 'local')
    let searched = false
    const opened = await resolveCitedFile('1112.mov', {
      roots: [root],
      workspaces: [workspace],
      types,
      search: async () => { searched = true; return [] },
    })
    expect(opened.file).toBe(await realpath(local))
    expect(searched).toBe(false)
  })
})

describe('poster frame', () => {
  it('seeks to one second, or ten percent of a short clip', () => {
    expect(posterSeek(28 * 60)).toBe(1)
    expect(posterSeek(4)).toBeCloseTo(0.4)
    expect(posterSeek(0)).toBe(1)
  })
})

// Optional real-file check: HERMESBOT_REAL_CLIP=/abs/path/to/clip.mov npx vitest run server/cite-resolve.test.mjs
const realClip = process.env.HERMESBOT_REAL_CLIP || ''

describe('a real cited clip on this Mac', () => {
  it('resolves the basename and builds a cached poster', async () => {
    let info
    if (!realClip) return
    try {
      info = await stat(realClip)
    } catch {
      return
    }
    resetCitedCache()
    const opened = await resolveCitedFile(path.basename(realClip), {
      roots: [path.dirname(realClip), path.join(os.homedir(), 'projects')],
      home: os.homedir(),
      workspaces: [path.join(os.homedir(), 'projects')],
      types,
    })
    expect(opened.ok).toBe(true)
    expect(opened.file).toBe(realClip)
    expect(opened.size).toBe(info.size)
    const cacheDir = path.join(os.tmpdir(), 'hermesbot-cited-thumbs')
    const poster = await ensureVideoPoster(opened.file, opened, { cacheDir })
    expect(poster.ok).toBe(true)
    expect(poster.duration).toBeGreaterThan(60)
    const again = await ensureVideoPoster(opened.file, opened, { cacheDir })
    expect(again.file).toBe(poster.file)
    const jpeg = await stat(poster.file)
    expect(jpeg.size).toBeGreaterThan(32)
  }, 30_000)
})
