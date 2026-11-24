import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { run } from './cli-quota.mjs'

const roots = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function temp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-quota-'))
  roots.push(dir)
  return dir
}

function capture() {
  const out = []
  const err = []
  return {
    out,
    err,
    stdout: { write(chunk) { out.push(String(chunk)) } },
    stderr: { write(chunk) { err.push(String(chunk)) } },
  }
}

describe('cli-quota', () => {
  it('counts a completion without a routing pick, and ignores a non-quota error', async () => {
    const dir = await temp()
    const io = capture()
    const code = await run([
      'use', '--dir', dir, '--provider', 'cursor', '--model', 'gpt-5.6-sol',
      '--tokens-in', '20', '--tokens-out', '4',
    ], io)
    expect(code).toBe(0)
    expect(JSON.parse(io.out.join(''))).toMatchObject({ ok: true, recorded: true })
    const file = JSON.parse(await fs.readFile(path.join(dir, 'provider-quota.json'), 'utf8'))
    expect(file.providers.cursor.used).toBe(1)
    expect(file.recentPicks).toEqual([])

    const ignored = capture()
    const again = await run([
      'error', '--dir', dir, '--provider', 'cursor', '--model', 'gpt-5.6-sol',
      '--status', '500', '--message', 'internal error',
    ], ignored)
    expect(again).toBe(0)
    expect(JSON.parse(ignored.out.join('')).recorded).toBe(false)
    expect(JSON.parse(await fs.readFile(path.join(dir, 'provider-quota.json'), 'utf8')).providers.cursor.exhaustedUntil).toBeNull()
  })

  it('marks Kimi exhausted until the weekly reset and redacts the error', async () => {
    const dir = await temp()
    const io = capture()
    const code = await run([
      'error', '--dir', dir, '--provider', 'kimi-coding', '--model', 'kimi-for-coding',
      '--status', '429',
      '--message', 'weekly (7-day) usage limit sk-supersecretkey',
    ], io)
    expect(code).toBe(0)
    expect(JSON.parse(io.out.join('')).recorded).toBe(true)
    const kimi = JSON.parse(await fs.readFile(path.join(dir, 'provider-quota.json'), 'utf8')).providers.kimi
    expect(kimi.window).toBe('week')
    expect(kimi.lastStatus).toBe(429)
    expect(kimi.exhaustedUntil).toBe(kimi.resetAt)
    expect(Date.parse(kimi.exhaustedUntil)).toBeGreaterThan(Date.now())
    expect(kimi.lastError).toContain('weekly (7-day) usage limit')
    expect(kimi.lastError).not.toContain('sk-')
    expect(io.err.join('')).not.toContain('sk-')
  })

  it('honours Retry-After over the weekly window', async () => {
    const dir = await temp()
    const io = capture()
    const before = Date.now()
    const code = await run([
      'error', '--dir', dir, '--provider', 'kimi-coding', '--model', 'kimi-for-coding',
      '--status', '429', '--message', 'weekly (7-day) usage limit', '--retry-after', '30',
    ], io)
    expect(code).toBe(0)
    const kimi = JSON.parse(await fs.readFile(path.join(dir, 'provider-quota.json'), 'utf8')).providers.kimi
    const until = Date.parse(kimi.exhaustedUntil)
    expect(until).toBeGreaterThan(before + 20000)
    expect(until).toBeLessThan(before + 40000)
  })

  it('marks one cursor model for 6 hours on a proxy resource-limit error', async () => {
    const dir = await temp()
    const io = capture()
    const before = Date.now()
    const code = await run([
      'error', '--dir', dir, '--provider', 'custom', '--model', 'cursor/claude-opus-5-5',
      '--status', '400', '--message', 'resource limit exceeded',
    ], io)
    expect(code).toBe(0)
    expect(JSON.parse(io.out.join('')).recorded).toBe(true)
    const file = JSON.parse(await fs.readFile(path.join(dir, 'provider-quota.json'), 'utf8'))
    expect(file.providers.custom).toBeUndefined()
    const model = file.providers.cursor.models['claude-opus-5-5']
    expect(model.lastStatus).toBe(400)
    expect(model.lastError).toMatch(/resource limit exceeded/i)
    const until = Date.parse(model.exhaustedUntil)
    expect(until).toBeGreaterThan(before + 5 * 60 * 60 * 1000)
    expect(until).toBeLessThan(before + 7 * 60 * 60 * 1000)
    expect(file.providers.cursor.exhaustedUntil).toBeNull()
  })
})
