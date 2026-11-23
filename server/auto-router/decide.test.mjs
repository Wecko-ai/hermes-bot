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
        'demo/code': { label: 'Demo Code (Demo)', quality: { coding: 0.95, quick: 0.5 }, costPerMToken: { in: 0, out: 0 }, baselineLatencyMs: 1500 },
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
    expect(result.label).toBe('Demo Code (Demo)')
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

  it('ranks tiny free quotas after NVIDIA and skips a scope once its day is used up', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-decide-'))
    roots.push(dir)
    const tablePath = path.join(dir, 'table.json')
    await fs.writeFile(tablePath, JSON.stringify({
      models: {
        'nvidia/small': { quality: { coding: 0.45 }, costPerMToken: { in: 0, out: 0 }, baselineLatencyMs: 800 },
        'sambanova/gemma-4-31B-it': { quality: { coding: 0.99 }, costPerMToken: { in: 0, out: 0 }, dailyQuota: { requests: 1, scope: 'sambanova' } },
        'cloudflare/@cf/meta/llama-3.1-8b-instruct-fp8-fast': { quality: { coding: 0.99 }, costPerMToken: { in: 0, out: 0 }, dailyQuota: { neurons: 10000, scope: 'cloudflare' } },
        'openrouter/nvidia/nemotron:free': { quality: { coding: 0.99 }, costPerMToken: { in: 0, out: 0 }, dailyQuota: { requests: 1000, scope: 'openrouter-free' } },
        'sambanova/paid': { quality: { coding: 0.99 }, costPerMToken: { in: 1, out: 1 } },
      },
    }))
    const router = createAutoRouter({ tablePath, logDir: dir, subscriptions: [] })
    const models = [
      { provider: 'sambanova', model: 'gemma-4-31B-it' },
      { provider: 'sambanova', model: 'paid' },
      { provider: 'cloudflare', model: '@cf/meta/llama-3.1-8b-instruct-fp8-fast' },
      { provider: 'openrouter', model: 'nvidia/nemotron:free' },
      { provider: 'nvidia', model: 'small' },
      { provider: 'cursor', model: 'cursor/claude-opus-5-5', free: true },
    ]
    const first = await router.decide({ text: 'Fix the bug in server/index.mjs', models, mode: 'auto-free' })
    expect(first.ok).toBe(true)
    expect(first.chosen).toBe('nvidia/small')
    expect(first.reason).toContain('before')
    expect(first.candidates.map((row) => row.model)).toEqual([
      'nvidia/small',
      'openrouter/nvidia/nemotron:free',
      'cloudflare/@cf/meta/llama-3.1-8b-instruct-fp8-fast',
      'sambanova/gemma-4-31B-it',
    ])
    const withoutNvidia = models.filter((row) => row.provider !== 'nvidia')
    const second = await router.decide({ text: 'Fix the bug in server/index.mjs', models: withoutNvidia, mode: 'auto-free' })
    expect(second.chosen).toBe('openrouter/nvidia/nemotron:free')
    await router.recordLoggedUsage({
      mode: 'auto-free',
      fallbacks: [{ model: 'sambanova/gemma-4-31B-it', error: '429' }],
    })
    const blocked = await router.decide({ text: 'Fix the bug in server/index.mjs', models: [
      { provider: 'sambanova', model: 'gemma-4-31B-it' },
    ], mode: 'auto-free' })
    expect(blocked).toMatchObject({ ok: false, error: 'quota_exhausted' })
    const stillOpen = await router.decide({ text: 'Fix the bug in server/index.mjs', models: withoutNvidia, mode: 'auto-free' })
    expect(stillOpen.chosen).toBe('openrouter/nvidia/nemotron:free')
    expect(stillOpen.candidates.map((row) => row.model)).not.toContain('sambanova/gemma-4-31B-it')
  })
  it('routes a long conversation to a window it fits in, preferring large windows', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-decide-'))
    roots.push(dir)
    const tablePath = path.join(dir, 'table.json')
    await fs.writeFile(tablePath, JSON.stringify({
      models: {
        'cursor/cursor/gpt-5.6-sol': { quality: { long_context: 0.95 }, contextWindow: 272_000, baselineLatencyMs: 500 },
        'cursor/cursor/composer-2.5': { quality: { long_context: 0.9 }, contextWindow: 200_000, baselineLatencyMs: 500 },
        'kimi-coding/k3.1-pro': { quality: { long_context: 0.8 }, contextWindow: 1_048_576, baselineLatencyMs: 60_000 },
      },
    }))
    const router = createAutoRouter({ tablePath, logDir: dir, subscriptions: ['cursor', 'kimi-coding'] })
    const models = [
      { provider: 'cursor', model: 'cursor/gpt-5.6-sol' },
      { provider: 'cursor', model: 'cursor/composer-2.5' },
      { provider: 'kimi-coding', model: 'k3.1-pro' },
    ]
    const long = await router.decide({ text: 'continue', contextUsed: 188_000, contextMax: 200_000, currentModel: 'cursor/composer-2.5', models })
    expect(long.category).toBe('long_context')
    expect(long.chosen).toBe('kimi-coding/k3.1-pro')
    expect(long.needsCompaction).toBe(false)
    expect(long.excludedForContext).toEqual(['cursor/cursor/composer-2.5'])
    expect(long.contextWindow).toBe(1_048_576)
    // A long but fitting conversation: the slow large-window model is not punished for latency.
    const mid = await router.decide({ text: 'continue', contextUsed: 120_000, contextMax: 200_000, models: models.slice(0, 1).concat(models.slice(2)) })
    expect(mid.chosen).toBe('kimi-coding/k3.1-pro')
    const tooBig = await router.decide({ text: 'continue', contextUsed: 900_000, contextMax: 1_048_576, models })
    expect(tooBig.chosen).toBe('kimi-coding/k3.1-pro')
    expect(tooBig.needsCompaction).toBe(true)
  })
})
