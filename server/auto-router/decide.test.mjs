import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAutoRouter } from './decide.mjs'

const roots = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('auto-router decide', () => {
  it('picks a model for coding', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-decide-'))
    roots.push(dir)
    const tablePath = path.join(dir, 'table.json')
    await fs.writeFile(tablePath, JSON.stringify({
      models: {
        'demo/fast': { quality: { coding: 0.4, quick: 0.9 }, costPerMToken: { in: 0, out: 0 }, baselineLatencyMs: 500 },
        'demo/code': { quality: { coding: 0.95, quick: 0.5 }, costPerMToken: { in: 0, out: 0 }, baselineLatencyMs: 1500 },
      },
    }))
    const router = createAutoRouter({ tablePath, logDir: dir, subscriptions: ['demo'] })
    const result = await router.decide({
      text: 'Fix the bug in server/index.mjs',
      models: [
        { provider: 'demo', model: 'fast' },
        { provider: 'demo', model: 'code' },
      ],
    })
    expect(result.ok).toBe(true)
    expect(result.chosen).toBe('demo/code')
  })

  it('auto-free keeps only free models, decided on the server', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-decide-'))
    roots.push(dir)
    const tablePath = path.join(dir, 'table.json')
    await fs.writeFile(tablePath, JSON.stringify({
      models: {
        'cursor/cursor/claude-opus-5-5': { quality: { coding: 0.99 }, costPerMToken: { in: 0, out: 0 } },
        'kimi-coding/k3.1-pro': { quality: { coding: 0.98 }, costPerMToken: { in: 0, out: 0 } },
        'nvidia/z-ai/glm-5.3': { quality: { coding: 0.8 }, costPerMToken: { in: 0, out: 0 } },
        'omlx/qwen-local': { quality: { coding: 0.6 }, costPerMToken: { in: 0, out: 0 } },
      },
    }))
    const router = createAutoRouter({ tablePath, logDir: dir, subscriptions: ['kimi-coding', 'cursor'] })
    const models = [
      { provider: 'cursor', model: 'cursor/claude-opus-5-5', free: true },
      { provider: 'kimi-coding', model: 'k3.1-pro', free: true },
      { provider: 'opencode-go', model: 'beam-free', free: true },
      { provider: 'gemini', model: 'gemini-3.8-flash', free: true },
      { provider: 'openrouter', model: 'anthropic/claude-opus-5.5' },
      { provider: 'openrouter', model: 'z-ai/glm-5.2:free' },
      { provider: 'nvidia', model: 'z-ai/glm-5.3' },
      { provider: 'omlx', model: 'qwen-local' },
    ]
    const result = await router.decide({ text: 'Fix the bug in server/index.mjs', models, mode: 'auto-free' })
    expect(result.ok).toBe(true)
    expect(result.mode).toBe('auto-free')
    expect(result.chosen).toBe('nvidia/z-ai/glm-5.3')
    const allowed = new Set(['nvidia/z-ai/glm-5.3', 'omlx/qwen-local', 'openrouter/z-ai/glm-5.2:free'])
    for (const row of result.candidates) expect(allowed.has(row.model)).toBe(true)
    for (const row of result.fallbacks) expect(allowed.has(row.fullId)).toBe(true)
    const plain = await router.decide({ text: 'Fix the bug in server/index.mjs', models })
    expect(plain.mode).toBe('auto')
    expect(plain.chosen).toBe('cursor/cursor/claude-opus-5-5')
    const none = await router.decide({ text: 'hi', models: models.slice(0, 2), mode: 'auto-free' })
    expect(none).toMatchObject({ ok: false, error: 'no_free_candidates' })
  })
})
