// One JPEG frame for a cited video, cached by real path + size + mtime.
// ffmpeg is optional: without it the card stays a playable icon.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, copyFileSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const TOOL_TIMEOUT_MS = 12_000

export function findBinary(name, env = process.env) {
  const candidates = [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`]
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, name))
  }
  for (const file of candidates) {
    try {
      accessSync(file, constants.X_OK)
      return file
    } catch {
      // Next candidate.
    }
  }
  return ''
}

function run(command, args, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let child
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      finish({ code: -1, out: '', error: error?.code || 'spawn' })
      return
    }
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ code: -1, out, err, timedOut: true })
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => { if (out.length < 64_000) out += chunk })
    child.stderr?.on('data', (chunk) => { if (err.length < 64_000) err += chunk })
    child.on('error', (error) => {
      clearTimeout(timer)
      finish({ code: -1, out, err, error: error?.code || 'spawn' })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish({ code: code ?? -1, out, err })
    })
  })
}

function cacheKey(file, size, mtimeMs) {
  return createHash('sha256').update(`${file}\0${size}\0${mtimeMs}`).digest('hex')
}

function placeFile(from, to) {
  try {
    renameSync(from, to)
  } catch {
    copyFileSync(from, to)
    unlinkSync(from)
  }
}

function readMeta(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return Number.isFinite(parsed?.duration) && parsed.duration > 0 ? parsed.duration : null
  } catch {
    return null
  }
}

/** Seconds: 1s, or 10% when the clip is shorter than 10s. */
export function posterSeek(duration) {
  if (!(duration > 0)) return 1
  return Math.min(1, duration * 0.1)
}

async function probeDuration(ffprobe, file, exec) {
  if (!ffprobe) return null
  const result = await exec(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], 4000)
  const duration = Number(String(result.out || '').trim())
  return Number.isFinite(duration) && duration > 0 ? duration : null
}

async function grabFrame(ffmpeg, file, seek, dest, exec) {
  const result = await exec(ffmpeg, [
    '-y', '-ss', String(seek), '-i', file, '-frames:v', '1', '-an', '-vf', 'scale=640:-2', '-q:v', '3', dest,
  ], TOOL_TIMEOUT_MS)
  if (result.code === 0) return true
  if (seek === 0) return false
  const retry = await exec(ffmpeg, [
    '-y', '-ss', '0', '-i', file, '-frames:v', '1', '-an', '-vf', 'scale=640:-2', '-q:v', '3', dest,
  ], TOOL_TIMEOUT_MS)
  return retry.code === 0
}

/**
 * `{ ok, file, duration }` for a cached JPEG, or `{ ok: false, reason: 'no_ffmpeg' }`.
 * `file` is the source video's real path. `size` and `mtimeMs` key the cache.
 */
export async function ensureVideoPoster(file, { size, mtimeMs } = {}, {
  cacheDir,
  ffmpeg = findBinary('ffmpeg'),
  ffprobe = findBinary('ffprobe'),
  exec = run,
} = {}) {
  if (!cacheDir) return { ok: false, reason: 'no_cache' }
  let info = { size, mtimeMs }
  if (!Number.isFinite(info.size) || !Number.isFinite(info.mtimeMs)) {
    try {
      const stat = statSync(file)
      info = { size: stat.size, mtimeMs: stat.mtimeMs }
    } catch {
      return { ok: false, reason: 'missing' }
    }
  }
  const key = cacheKey(file, info.size, info.mtimeMs)
  mkdirSync(cacheDir, { recursive: true })
  const jpeg = path.join(cacheDir, `${key}.jpg`)
  const meta = path.join(cacheDir, `${key}.json`)
  try {
    const existing = statSync(jpeg)
    if (existing.isFile() && existing.size > 0) return { ok: true, file: jpeg, size: existing.size, duration: readMeta(meta) }
  } catch {
    // Generate below.
  }
  if (!ffmpeg) return { ok: false, reason: 'no_ffmpeg' }
  const duration = await probeDuration(ffprobe, file, exec)
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hermesbot-poster-'))
  const dest = path.join(dir, 'frame.jpg')
  try {
    const grabbed = await grabFrame(ffmpeg, file, posterSeek(duration), dest, exec)
    if (!grabbed) return { ok: false, reason: 'ffmpeg_failed' }
    const written = statSync(dest)
    if (!written.isFile() || written.size < 32) return { ok: false, reason: 'ffmpeg_failed' }
    placeFile(dest, jpeg)
    writeFileSync(meta, JSON.stringify({ duration: duration || null }))
    return { ok: true, file: jpeg, size: written.size, duration }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** HEIC/HEIF becomes a cached JPEG so Chromium can show it. Other images pass through. */
export async function ensurePreviewImage(file, { size, mtimeMs, contentType } = {}, {
  cacheDir,
  ffmpeg = findBinary('ffmpeg'),
  sips = findBinary('sips') || (process.platform === 'darwin' ? '/usr/bin/sips' : ''),
  exec = run,
} = {}) {
  const extension = path.extname(file).slice(1).toLowerCase()
  if (extension !== 'heic' && extension !== 'heif') return { ok: true, file, size, contentType }
  if (!cacheDir) return { ok: false, reason: 'no_cache' }
  let info = { size, mtimeMs }
  if (!Number.isFinite(info.size) || !Number.isFinite(info.mtimeMs)) {
    try {
      const stat = statSync(file)
      info = { size: stat.size, mtimeMs: stat.mtimeMs }
    } catch {
      return { ok: false, reason: 'missing' }
    }
  }
  const jpeg = path.join(cacheDir, `${cacheKey(file, info.size, info.mtimeMs)}-still.jpg`)
  mkdirSync(cacheDir, { recursive: true })
  try {
    const existing = statSync(jpeg)
    if (existing.isFile() && existing.size > 0) return { ok: true, file: jpeg, size: existing.size, contentType: 'image/jpeg' }
  } catch {
    // Convert below.
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hermesbot-still-'))
  const dest = path.join(dir, 'still.jpg')
  try {
    let wrote = false
    if (sips) {
      const result = await exec(sips, ['-s', 'format', 'jpeg', '-s', 'formatOptions', '70', '--resampleWidth', '1600', file, '--out', dest], TOOL_TIMEOUT_MS)
      wrote = result.code === 0
    }
    if (!wrote && ffmpeg) {
      const result = await exec(ffmpeg, ['-y', '-i', file, '-frames:v', '1', '-vf', 'scale=1600:-2', '-q:v', '3', dest], TOOL_TIMEOUT_MS)
      wrote = result.code === 0
    }
    if (!wrote) return { ok: false, reason: 'no_converter' }
    const written = statSync(dest)
    if (!written.isFile() || written.size < 32) return { ok: false, reason: 'convert_failed' }
    placeFile(dest, jpeg)
    return { ok: true, file: jpeg, size: written.size, contentType: 'image/jpeg' }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
