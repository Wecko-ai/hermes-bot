import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  chargeFor, cloudflareNeurons, createDailyQuotaStore, freeTier, isQuotaExhausted, rankFreeCandidates, resolveDailyQuota,
} from './quota.mjs'

const roots = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

const table = {
  models: {
    'sambanova/gemma-4-31B-it': { costPerMToken: { in: 0, out: 0 }, dailyQuota: { requests: 20, tokens: 200000, scope: 'sambanova' } },
    'cloudflare/@cf/meta/llama-3.1-8b-instruct-fp8-fast': { dailyQuota: { neurons: 10000, reset: '00:00 UTC', scope: 'cloudflare' } },
    'cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast': { dailyQuota: { neurons: '10000', scope: 'cloudflare' } },
    'openrouter/nvidia/nemotron-3-ultra:free': { dailyQuota: { requests: 1000, scope: 'openrouter-free' } },
    'nvidia/z-ai/glm-5.3': { costPerMToken: { in: 0, out: 0 } },
    'sambanova/paid-model': { dailyQuota: { requests: 0 } },
  },
  dailyQuotas: {
    'custom-cap': { requests: 7, scope: 'custom-cap' },
  },
}

describe('daily quota parsing', () => {
  it('reads entry quotas, provider maps and built-in defaults', () => {
    expect(resolveDailyQuota(table, { provider: 'sambanova', model: 'gemma-4-31B-it' })).toMatchObject({ requests: 20, tokens: 200000, scope: 'sambanova' })
    expect(resolveDailyQuota(table, { provider: 'cloudflare', model: '@cf/meta/llama-3.1-8b-instruct-fp8-fast' })).toMatchObject({ neurons: 10000, scope: 'cloudflare' })
    expect(resolveDailyQuota(table, { provider: 'cloudflare', model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' }).neurons).toBe(10000)
    expect(resolveDailyQuota(table, { provider: 'openrouter', model: 'nvidia/nemotron-3-ultra:free' })).toMatchObject({ requests: 1000, scope: 'openrouter-free' })
    expect(resolveDailyQuota(table, { provider: 'nvidia', model: 'z-ai/glm-5.3' })).toBeNull()
    expect(resolveDailyQuota(table, { provider: 'sambanova', model: 'paid-model' })).toBeNull()
    expect(resolveDailyQuota({ models: {} }, { provider: 'sambanova', model: 'gemma-4-31B-it' })).toMatchObject({ requests: 20, scope: 'sambanova' })
    expect(resolveDailyQuota({ models: {} }, { provider: 'cloudflare', model: '@cf/meta/llama-3.1-8b-instruct-fp8-fast' })).toMatchObject({ neurons: 10000, scope: 'cloudflare' })
    expect(resolveDailyQuota({ models: {} }, { provider: 'openrouter', model: 'openrouter/free' })).toMatchObject({ requests: 1000, scope: 'openrouter-free' })
    expect(resolveDailyQuota({ models: {} }, { provider: 'omlx', model: 'qwen-local' })).toBeNull()
    expect(resolveDailyQuota({
      models: { 'sambanova/other': { quality: {} } },
      providers: { sambanova: { dailyQuota: { requests: 15, scope: 'sambanova' } } },
    }, { provider: 'sambanova', model: 'other' })).toMatchObject({ requests: 15, scope: 'sambanova' })
    expect(resolveDailyQuota({
      models: { 'custom-cap/m': {} },
      dailyQuotas: { 'custom-cap': { requests: 7 } },
    }, { provider: 'custom-cap', model: 'm' })).toMatchObject({ requests: 7, scope: 'custom-cap' })
  })

  it('estimates Cloudflare neurons from published per-million rates', () => {
    expect(cloudflareNeurons('@cf/meta/llama-3.1-8b-instruct-fp8-fast', 1_000_000, 0)).toBe(4119)
    expect(cloudflareNeurons('@cf/meta/llama-3.1-8b-instruct-fp8-fast', 0, 1_000_000)).toBe(34868)
    const typical = cloudflareNeurons('@cf/meta/llama-3.1-8b-instruct-fp8-fast', 1000, 400)
    expect(typical).toBeCloseTo(18.066, 2)
    expect(cloudflareNeurons('@cf/meta/llama-3.3-70b-instruct-fp8-fast', 1000, 400)).toBeCloseTo(108.59, 1)
    expect(cloudflareNeurons('@cf/meta/unknown', 0, 0)).toBe(80)
    const charge = chargeFor({ neurons: 10000, tokens: 0, requests: 0 }, '@cf/meta/llama-3.1-8b-instruct-fp8-fast', 1000)
    expect(charge.requests).toBe(1)
    expect(charge.neurons).toBeCloseTo(18.066, 2)
  })

  it('treats SambaNova and Cloudflare as tiny next to NVIDIA and OpenRouter', () => {
    expect(freeTier(null).tier).toBe(0)
    expect(freeTier({ requests: 1000, tokens: 0, neurons: 0 }).tier).toBe(1)
    expect(freeTier({ requests: 20, tokens: 200000, neurons: 0 }).tier).toBe(2)
    expect(freeTier({ requests: 0, tokens: 0, neurons: 10000 }).tier).toBe(2)
    const scored = [
      { provider: 'sambanova', model: 'gemma-4-31B-it', fullId: 'sambanova/gemma-4-31B-it', score: 0.99 },
      { provider: 'openrouter', model: 'nvidia/nemotron-3-ultra:free', fullId: 'openrouter/nvidia/nemotron-3-ultra:free', score: 0.95 },
      { provider: 'nvidia', model: 'z-ai/glm-5.3', fullId: 'nvidia/z-ai/glm-5.3', score: 0.4 },
      { provider: 'cloudflare', model: '@cf/meta/llama-3.1-8b-instruct-fp8-fast', fullId: 'cloudflare/@cf/meta/llama-3.1-8b-instruct-fp8-fast', score: 0.99 },
    ]
    const ranked = rankFreeCandidates(scored, (row) => resolveDailyQuota(table, row))
    expect(ranked.map((row) => row.provider)).toEqual(['nvidia', 'openrouter', 'cloudflare', 'sambanova'])
  })
})

describe('daily quota store', () => {
  it('stops at the cap and resets that scope at UTC midnight', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-'))
    roots.push(dir)
    let clock = new Date('2026-11-23T15:00:00Z')
    const store = createDailyQuotaStore(dir, { now: () => clock })
    const samba = { requests: 20, tokens: 0, neurons: 0, scope: 'sambanova' }
    const cloud = { requests: 0, tokens: 0, neurons: 100, scope: 'cloudflare' }
    for (let i = 0; i < 20; i += 1) {
      expect(await store.tryConsume('sambanova', { requests: 1, tokens: 0, neurons: 0 }, samba)).toBe(true)
    }
    expect(await store.tryConsume('sambanova', { requests: 1, tokens: 0, neurons: 0 }, samba)).toBe(false)
    expect(isQuotaExhausted(samba, (await store.snapshot()).sambanova, { requests: 1, tokens: 0, neurons: 0 })).toBe(true)
    expect(await store.tryConsume('cloudflare', { requests: 1, tokens: 0, neurons: 80 }, cloud)).toBe(true)
    expect(await store.tryConsume('cloudflare', { requests: 1, tokens: 0, neurons: 80 }, cloud)).toBe(false)
    const saved = JSON.parse(await fs.readFile(store.file, 'utf8'))
    expect(saved.days.sambanova).toMatchObject({ utcDay: '2026-11-23', requests: 20 })
    expect(saved.days.cloudflare.utcDay).toBe('2026-11-23')
    clock = new Date('2026-11-24T00:00:01Z')
    expect(await store.tryConsume('sambanova', { requests: 1, tokens: 0, neurons: 0 }, samba)).toBe(true)
    const next = await store.snapshot()
    expect(next.sambanova.requests).toBe(1)
    expect(next.cloudflare).toBeUndefined()
  })

  it('rejects a scope that is not a safe file key', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-'))
    roots.push(dir)
    const store = createDailyQuotaStore(dir)
    expect(await store.tryConsume('../etc', { requests: 1, tokens: 0, neurons: 0 }, { requests: 5, tokens: 0, neurons: 0 })).toBe(false)
  })
})
