import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendRoutingLog, latencyAverages, readRoutingLog, rotateOldLogs, sanitizeLogEntry, summarizeRoutingLog,
} from './log.mjs'

const tmpRoots = []

async function tempLogDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-router-log-'))
  tmpRoots.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('auto-router log', () => {
  it('never keeps prompt text in sanitize', () => {
    const entry = sanitizeLogEntry({
      bot: 'demo',
      sessionId: 's1',
      category: 'coding',
      chosen: 'example/code-strong',
      reason: 'test',
      prompt: 'secret prompt',
      text: 'hello',
      candidates: [{ model: 'example/code-strong', score: 1 }],
    })
    expect(entry).not.toHaveProperty('prompt')
    expect(entry).not.toHaveProperty('text')
    expect(entry.bot).toBe('demo')
  })

  it('appends with mode 0600 and rotates old files to archive', async () => {
    const logDir = await tempLogDir()
    const oldDay = path.join(logDir, 'routing-2020-01-01.jsonl')
    await fs.writeFile(oldDay, '{"v":1,"chosen":"x"}\n', { mode: 0o600 })
    const old = new Date('2020-01-01T12:00:00Z')
    await fs.utimes(oldDay, old, old)
    await rotateOldLogs(logDir, new Date('2020-06-01T12:00:00Z'))
    await expect(fs.stat(path.join(logDir, 'archive', 'routing-2020-01-01.jsonl'))).resolves.toBeDefined()
    await appendRoutingLog(logDir, sanitizeLogEntry({ bot: 'bot-a', sessionId: 's', category: 'quick', chosen: 'example/fast-lite', reason: 'ok', outcome: 'ok' }))
    const now = new Date()
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const stat = await fs.stat(path.join(logDir, `routing-${day}.jsonl`))
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('reads recent days and summarizes', async () => {
    const logDir = await tempLogDir()
    await appendRoutingLog(logDir, sanitizeLogEntry({
      bot: 'bot-a', sessionId: 's', category: 'coding', chosen: 'example/code-strong', reason: 'r',
      fallbacks: [{ model: 'example/fast-lite', error: '429' }], costUsd: 0.01, latencyMs: 1200, outcome: 'ok',
    }))
    const rows = await readRoutingLog(logDir, 7)
    expect(rows.length).toBeGreaterThan(0)
    const summary = summarizeRoutingLog(rows)
    expect(summary.total).toBe(1)
    expect(summary.fallbacks).toBe(1)
    expect(latencyAverages(rows).get('example/code-strong')).toBe(1200)
  })

  it('records the Auto mode, auto by default', () => {
    expect(sanitizeLogEntry({ bot: 'demo', chosen: 'a/b' }).mode).toBe('auto')
    expect(sanitizeLogEntry({ bot: 'demo', chosen: 'a/b', mode: 'auto-free' }).mode).toBe('auto-free')
    expect(sanitizeLogEntry({ bot: 'demo', chosen: 'a/b', mode: 'weird' }).mode).toBe('auto')
  })

  it('keeps triage metadata and still drops prompt text', () => {
    const entry = sanitizeLogEntry({
      bot: 'orion',
      sessionId: 's1',
      category: 'research',
      rulesCategory: 'other',
      chosen: 'example/research-strong',
      reason: 'local triage',
      prompt: 'secret prompt',
      triage: { source: 'local', latencyMs: 180, difficulty: 'hard', confidence: 0.3, rulesCategory: 'other' },
    })
    expect(entry).not.toHaveProperty('prompt')
    expect(entry.triageSource).toBe('local')
    expect(entry.triageLatencyMs).toBe(180)
    expect(entry.rulesCategory).toBe('other')
    expect(entry.difficulty).toBe('hard')
    expect(entry.confidence).toBe(0.3)
  })
})
