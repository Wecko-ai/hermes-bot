import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ensurePreviewImage, ensureVideoPoster, findBinary, posterSeek } from './video-poster.mjs'

describe('video poster', () => {
  it('seeks to one second, or ten percent of a short clip', () => {
    expect(posterSeek(28 * 60)).toBe(1)
    expect(posterSeek(4)).toBeCloseTo(0.4)
    expect(posterSeek(0)).toBe(1)
  })

  it('finds ffmpeg on PATH or under Homebrew', () => {
    const found = findBinary('ffmpeg', { PATH: '' })
    if (found) expect(found).toMatch(/ffmpeg$/)
    else expect(found).toBe('')
  })

  it('keeps a cached frame and does not run ffmpeg again', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hermesbot-poster-'))
    let ran = 0
    const exec = async (_bin, args) => {
      ran += 1
      if (args.includes('-show_entries')) return { code: 0, out: '1680\n' }
      writeFileSync(args.at(-1), Buffer.alloc(64, 1))
      return { code: 0, out: '' }
    }
    const first = await ensureVideoPoster('/Volumes/Renders/video/capcut/1112.mov', { size: 9, mtimeMs: 3 }, {
      cacheDir: dir,
      ffmpeg: '/opt/homebrew/bin/ffmpeg',
      ffprobe: '/opt/homebrew/bin/ffprobe',
      exec,
    })
    expect(first.ok).toBe(true)
    expect(first.duration).toBe(1680)
    expect(readFileSync(first.file).length).toBe(64)
    const again = await ensureVideoPoster('/Volumes/Renders/video/capcut/1112.mov', { size: 9, mtimeMs: 3 }, {
      cacheDir: dir,
      ffmpeg: '/opt/homebrew/bin/ffmpeg',
      ffprobe: '/opt/homebrew/bin/ffprobe',
      exec,
    })
    expect(again.file).toBe(first.file)
    expect(ran).toBe(2)
  })

  it('retries the first frame when the one-second grab fails', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hermesbot-poster-retry-'))
    const seeks = []
    const file = await ensureVideoPoster('/video/a.mov', { size: 4, mtimeMs: 8 }, {
      cacheDir: dir,
      ffmpeg: '/opt/homebrew/bin/ffmpeg',
      ffprobe: '',
      exec: async (_bin, args) => {
        const at = args[args.indexOf('-ss') + 1]
        seeks.push(at)
        if (at === '0') writeFileSync(args.at(-1), Buffer.alloc(40, 2))
        return { code: at === '0' ? 0 : 1, out: '' }
      },
    })
    expect(seeks).toEqual(['1', '0'])
    expect(file.ok).toBe(true)
  })

  it('stays playable when ffmpeg is missing', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hermesbot-poster-none-'))
    const result = await ensureVideoPoster('/video/a.mov', { size: 1, mtimeMs: 1 }, {
      cacheDir: dir,
      ffmpeg: '',
      ffprobe: '',
    })
    expect(result).toEqual({ ok: false, reason: 'no_ffmpeg' })
  })

  it('leaves a jpeg as itself and converts heic when asked', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hermesbot-still-'))
    const jpeg = path.join(dir, 'still.jpg')
    writeFileSync(jpeg, 'jpeg')
    const same = await ensurePreviewImage(jpeg, { size: 4, mtimeMs: 1, contentType: 'image/jpeg' }, { cacheDir: dir })
    expect(same).toMatchObject({ ok: true, file: jpeg, contentType: 'image/jpeg' })
    const heic = path.join(dir, 'photo.heic')
    writeFileSync(heic, 'heic')
    const converted = await ensurePreviewImage(heic, { size: 4, mtimeMs: 2, contentType: 'image/heic' }, {
      cacheDir: dir,
      sips: '/usr/bin/sips',
      ffmpeg: '',
      exec: async (_bin, args) => {
        writeFileSync(args.at(-1), Buffer.alloc(48, 3))
        return { code: 0, out: '' }
      },
    })
    expect(converted.ok).toBe(true)
    expect(converted.contentType).toBe('image/jpeg')
    expect(converted.file).not.toBe(heic)
  })
})
