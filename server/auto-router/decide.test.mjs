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

  it('keeps only Composer and Grok among Cursor candidates', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-decide-'))
    roots.push(dir)
    const tablePath = path.join(dir, 'table.json')
    await fs.writeFile(tablePath, JSON.stringify({
      models: {
        'cursor/cursor/claude-sonnet-5-5': { quality: { coding: 0.99, writing: 0.99, other: 0.99 }, costPerMToken: { in: 0, out: 0 } },
        'cursor/cursor/grok-4.7': { quality: { coding: 0.8, writing: 0.8, other: 0.8 }, costPerMToken: { in: 0, out: 0 } },
      },
    }))
    const router = createAutoRouter({ tablePath, logDir: dir, subscriptions: ['cursor'] })
    const result = await router.decide({
      text: 'Fix the bug in server/index.mjs',
      models: [
        { provider: 'cursor', model: 'cursor/claude-sonnet-5-5' },
        { provider: 'cursor', model: 'cursor/gpt-5.6-sol' },
        { provider: 'cursor', model: 'cursor/grok-4.7' },
        { provider: 'cursor', model: 'cursor/composer-2.5' },
      ],
    })
    expect(result.ok).toBe(true)
    expect(['cursor/cursor/grok-4.7', 'cursor/cursor/composer-2.5']).toContain(result.chosen)
    expect(JSON.stringify(result.candidates)).not.toMatch(/claude|gpt/)
  })

  it('free first: a quick turn goes to a good free model even under zero-spend without free flags', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-decide-'))
    roots.push(dir)
    const tablePath = path.join(dir, 'table.json')
    await fs.writeFile(tablePath, JSON.stringify({
      models: {
        'cursor/cursor/grok-4.7': { quality: { quick: 0.9, coding: 0.9 }, costPerMToken: { in: 0, out: 0 } },
        'nvidia/z-ai/glm-5.3-flash': { quality: { quick: 0.8, coding: 0.6 }, costPerMToken: { in: 0, out: 0 } },
        'nvidia/weak': { quality: { quick: 0.5 }, costPerMToken: { in: 0, out: 0 } },
        'nvidia/notools': { quality: { quick: 0.95 }, tools: false, costPerMToken: { in: 0, out: 0 } },
        'nvidia/retired': { quality: { quick: 0.99, coding: 0.99 }, disabled: true, costPerMToken: { in: 0, out: 0 } },
      },
    }))
    const router = createAutoRouter({ tablePath, logDir: dir, subscriptions: ['cursor'] })
    const models = [
      { provider: 'cursor', model: 'cursor/grok-4.7' },
      { provider: 'nvidia', model: 'z-ai/glm-5.3-flash' },
      { provider: 'nvidia', model: 'weak' },
      { provider: 'nvidia', model: 'notools' },
      { provider: 'nvidia', model: 'retired' },
    ]
    const quick = await router.decide({ text: 'salut ça va ?', zeroSpend: true, models })
    expect(quick.ok).toBe(true)
    expect(quick.chosen).toBe('nvidia/z-ai/glm-5.3-flash')
    expect(quick.reason).toMatch(/^Free first/)
    expect(quick.fallbacks[0].fullId).toBe('cursor/cursor/grok-4.7')
    const coding = await router.decide({ text: 'Fix the bug in server/index.mjs and run the tests', zeroSpend: true, models })
    expect(coding.chosen).toBe('cursor/cursor/grok-4.7')
    expect(JSON.stringify(coding.candidates)).not.toMatch(/notools|retired/)
  })

  it('picks the best free model under zero-spend when all subscriptions and Gemini are exhausted', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-decide-'))
    roots.push(dir)
    const tablePath = path.join(dir, 'table.json')
    await fs.writeFile(tablePath, JSON.stringify({
      models: {
        'kimi-coding/k3.1-pro': { quality: { coding: 0.96 }, costPerMToken: { in: 0, out: 0 } },
        'cursor/cursor/grok-4.7': { quality: { coding: 0.9 }, costPerMToken: { in: 0, out: 0 } },
        'gemini/gemini-3.8-flash': { quality: { coding: 0.85 }, costPerMToken: { in: 0.5, out: 3 } },
        'nvidia/z-ai/glm-5.3': { quality: { coding: 0.88 }, disabled: true, costPerMToken: { in: 0, out: 0 } },
        'nvidia/moonshotai/kimi-k3': { quality: { coding: 0.86 }, costPerMToken: { in: 0, out: 0 }, baselineLatencyMs: 12000 },
        'openrouter/nvidia/nemotron-3-ultra:free': { quality: { coding: 0.78 }, costPerMToken: { in: 0, out: 0 }, baselineLatencyMs: 10000 },
        'omlx/local-qwen': { quality: { coding: 0.62 }, costPerMToken: { in: 0, out: 0 }, baselineLatencyMs: 35000 },
      },
    }))
    const router = createAutoRouter({ tablePath, logDir: dir, subscriptions: ['kimi-coding', 'cursor', 'gemini'] })
    await router.recordLoggedUsage({ mode: 'auto', chosen: 'kimi-coding/k3.1-pro', fallbacks: [] }, [
      { provider: 'kimi-coding', model: 'k3.1-pro', status: 429, message: 'weekly (7-day) usage limit' },
      { provider: 'cursor', model: 'cursor/grok-4.7', status: 429, message: 'Cursor rate limit exceeded: resource limit exceeded' },
      { provider: 'gemini', model: 'gemini-3.8-flash', status: 402, message: '402 Gemini API monthly budget cap reached' },
    ])
    // Call without `free` flags (same as headless gateway CLI).
    const models = [
      { provider: 'kimi-coding', model: 'k3.1-pro' },
      { provider: 'cursor', model: 'cursor/grok-4.7' },
      { provider: 'gemini', model: 'gemini-3.8-flash' },
      { provider: 'nvidia', model: 'z-ai/glm-5.3' },
      { provider: 'nvidia', model: 'moonshotai/kimi-k3' },
      { provider: 'openrouter', model: 'nvidia/nemotron-3-ultra:free' },
      { provider: 'omlx', model: 'local-qwen' },
    ]
    const decision = await router.decide({ text: 'Fix the bug in server/index.mjs and run tests', zeroSpend: true, models })
    expect(decision.ok).toBe(true)
    expect(decision.chosen).toBe('nvidia/moonshotai/kimi-k3')
    expect(decision.fallbacks.map((row) => row.provider)).toEqual(['openrouter', 'omlx'])
    expect(JSON.stringify(decision.candidates)).not.toContain('glm-5.3')
  })

  it('auto-free keeps only free models, decided on the server', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-decide-'))
    roots.push(dir)
    const tablePath = path.join(dir, 'table.json')
    await fs.writeFile(tablePath, JSON.stringify({
      models: {
        'cursor/cursor/grok-4.7': { quality: { coding: 0.99 }, costPerMToken: { in: 0, out: 0 } },
        'kimi-coding/k3.1-pro': { quality: { coding: 0.98 }, costPerMToken: { in: 0, out: 0 } },
        'nvidia/z-ai/glm-5.3': { quality: { coding: 0.8 }, costPerMToken: { in: 0, out: 0 } },
        'omlx/qwen-local': { quality: { coding: 0.6 }, costPerMToken: { in: 0, out: 0 } },
      },
    }))
    const router = createAutoRouter({ tablePath, logDir: dir, subscriptions: ['kimi-coding', 'cursor'] })
    const models = [
      { provider: 'cursor', model: 'cursor/grok-4.7', free: true },
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
    expect(plain.chosen).toBe('cursor/cursor/grok-4.7')
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
      { provider: 'cursor', model: 'cursor/grok-4.7', free: true },
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
        'cursor/cursor/grok-4.6': { quality: { long_context: 0.95 }, contextWindow: 272_000, baselineLatencyMs: 500 },
        'cursor/cursor/composer-2.5': { quality: { long_context: 0.9 }, contextWindow: 200_000, baselineLatencyMs: 500 },
        'kimi-coding/k3.1-pro': { quality: { long_context: 0.8 }, contextWindow: 1_048_576, baselineLatencyMs: 60_000 },
      },
    }))
    const router = createAutoRouter({ tablePath, logDir: dir, subscriptions: ['cursor', 'kimi-coding'] })
    const models = [
      { provider: 'cursor', model: 'cursor/grok-4.6' },
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
  it('uses local triage for an enabled bot and falls back on timeout', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-decide-'))
    roots.push(dir)
    const tablePath = path.join(dir, 'table.json')
    await fs.writeFile(tablePath, JSON.stringify({
      models: {
        'demo/writer': { quality: { writing: 0.95, other: 0.2, coding: 0.2 }, costPerMToken: { in: 0, out: 0 }, baselineLatencyMs: 800 },
        'demo/other': { quality: { writing: 0.2, other: 0.9, coding: 0.2 }, costPerMToken: { in: 0, out: 0 }, baselineLatencyMs: 800 },
      },
    }))
    const models = [
      { provider: 'demo', model: 'writer' },
      { provider: 'demo', model: 'other' },
    ]
    const ambiguous = 'The quarterly report attachments are in the shared drive folder marked Q3 — please reconcile the ledger with finance before the board packet ships next month.'
    const router = createAutoRouter({
      tablePath,
      logDir: dir,
      subscriptions: ['demo'],
      triageConfig: { mode: 'live', enabledBots: ['orion'], confidenceThreshold: 0.7 },
      triageDeps: {
        checkAvailable: async () => ({ ok: true, reason: null, loaded: true }),
        callLocal: async () => ({ ok: true, category: 'writing', difficulty: 'medium', latencyMs: 80 }),
      },
    })
    const local = await router.decide({ text: ambiguous, bot: 'orion', models })
    expect(local.ok).toBe(true)
    expect(local.category).toBe('writing')
    expect(local.chosen).toBe('demo/writer')
    expect(local.triage.source).toBe('local')
    expect(local.triage.rulesCategory).toBe('other')
    expect(local.triage.latencyMs).toBe(80)

    const fallback = createAutoRouter({
      tablePath,
      logDir: dir,
      subscriptions: ['demo'],
      triageConfig: { mode: 'live', enabledBots: ['orion'], confidenceThreshold: 0.7 },
      triageDeps: {
        checkAvailable: async () => ({ ok: true, reason: null, loaded: true }),
        callLocal: async () => ({ ok: false, reason: 'timeout', latencyMs: 1500 }),
      },
    })
    const timedOut = await fallback.decide({ text: ambiguous, bot: 'orion', models })
    expect(timedOut.category).toBe('other')
    expect(timedOut.chosen).toBe('demo/other')
    expect(timedOut.triage.source).toBe('local-timeout')
  })
})
