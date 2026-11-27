import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAutoRouter } from './decide.mjs'
import {
  classifyUpstreamError, createProviderQuotaStore, exhaustionFromSignal, isQuotaSignal, isTransientFallbackSignal, limitSpec, modelQuotaId, publicError, quotaProviderId,
} from './provider-quota.mjs'

const roots = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function temp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-quota-'))
  roots.push(dir)
  return dir
}

function pick(provider, model, extra = {}) {
  return {
    table: extra.table || {},
    provider,
    model,
    fullId: extra.fullId || `${provider}/${model}`,
    mode: extra.mode || 'auto',
    label: extra.label || provider,
    reason: extra.reason || 'test',
    tokensIn: extra.tokensIn ?? 0,
    tokensOut: extra.tokensOut ?? 0,
    fallbackFrom: extra.fallbackFrom ?? null,
  }
}

describe('provider quota contract', () => {
  it('canonicalizes provider ids', () => {
    expect(quotaProviderId('openrouter', 'nvidia/nemotron:free')).toBe('openrouter-free')
    expect(quotaProviderId('kimi-coding', 'k3.1-pro')).toBe('kimi')
    expect(quotaProviderId('moonshot', 'kimi')).toBe('kimi')
    expect(quotaProviderId('workers-ai', '@cf/meta/llama')).toBe('cloudflare')
    expect(quotaProviderId('omlx', 'qwen')).toBe('local')
    expect(quotaProviderId('custom:ollama', 'qwen')).toBe('local')
    expect(quotaProviderId('opencode', 'go')).toBe('opencode-go')
    expect(quotaProviderId('custom:cursor', 'gpt')).toBe('custom-cursor')
    expect(publicError('weekly limit sk-supersecretkey bearer abc.def')).toBe('weekly limit [redacted] bearer [redacted]')
  })

  it('counts every provider, caps recent picks, and rolls windows', async () => {
    const dir = await temp()
    let now = new Date('2026-11-23T12:00:00.000Z')
    const store = createProviderQuotaStore(dir, { now: () => now, host: 'host-a' })
    const rows = [
      ['nvidia', 'small'],
      ['cursor', 'gpt'],
      ['gemini', 'flash'],
      ['omlx', 'qwen'],
      ['opencode-go', 'go'],
      ['kimi-coding', 'k3.1-pro'],
    ]
    for (const [provider, model] of rows) {
      expect(await store.reserve(pick(provider, model))).toBe(true)
      now = new Date(now.getTime() + 1000)
    }
    for (let n = 0; n < 50; n += 1) {
      expect(await store.reserve(pick('cursor', `gpt-${n}`, { fullId: `cursor/gpt-${n}` }))).toBe(true)
      now = new Date(now.getTime() + 1000)
    }
    const file = JSON.parse(await fs.readFile(store.file, 'utf8'))
    expect(file.version).toBe(1)
    expect(file.host).toBe('host-a')
    expect(file.updatedAt).toMatch(/Z$/)
    expect(file.providers.nvidia).toMatchObject({ unit: 'requests', limit: 40, window: 'minute', dayLimit: 10000, used: 1 })
    expect(file.providers.cursor.requestsTotal).toBe(51)
    expect(file.providers.cursor.limit).toBeNull()
    expect(file.providers.cursor.window).toBe('none')
    expect(file.providers.gemini.used).toBe(1)
    expect(file.providers.local).toMatchObject({ used: 1, limit: null, window: 'none' })
    expect(file.providers['opencode-go'].used).toBe(1)
    expect(file.providers.kimi).toMatchObject({
      window: 'week',
      limit: null,
      used: 1,
      windowStart: '2026-11-23T00:00:00.000Z',
      resetAt: '2026-11-30T00:00:00.000Z',
    })
    expect(file.recentPicks).toHaveLength(50)
    expect(file.recentPicks[0].model).toBe('cursor/gpt-49')
    expect(file.recentPicks[0].provider).toBe('cursor')
    expect(Date.parse(file.recentPicks[0].at)).toBeGreaterThan(Date.parse(file.recentPicks[1].at))

    now = new Date('2026-11-24T12:00:00.000Z')
    expect(await store.reserve(pick('kimi-coding', 'k3.1-pro'))).toBe(true)
    now = new Date('2026-11-30T00:00:00.000Z')
    expect(await store.reserve(pick('kimi-coding', 'k3.1-pro'))).toBe(true)
    const kimi = JSON.parse(await fs.readFile(store.file, 'utf8')).providers.kimi
    expect(kimi.used).toBe(1)
    expect(kimi.requestsTotal).toBe(3)
    expect(kimi.windowStart).toBe('2026-11-30T00:00:00.000Z')
  })

  it('resets daily and minute windows and skips a provider at the cap', async () => {
    const dir = await temp()
    let now = new Date('2026-11-23T23:30:00.000Z')
    const store = createProviderQuotaStore(dir, { now: () => now, host: 'host-a' })
    expect(await store.reserve(pick('sambanova', 'gemma'))).toBe(true)
    now = new Date('2026-11-24T00:00:01.000Z')
    const rolled = await store.snapshot()
    expect(store.blocked(rolled, {}, { provider: 'sambanova', model: 'gemma' }, 0)).toBe(false)
    expect(await store.reserve(pick('sambanova', 'gemma'))).toBe(true)
    const samba = JSON.parse(await fs.readFile(store.file, 'utf8')).providers.sambanova
    expect(samba).toMatchObject({ used: 1, limit: 20, window: 'day-utc', windowStart: '2026-11-24T00:00:00.000Z' })

    now = new Date('2026-11-23T03:54:10.000Z')
    const rate = createProviderQuotaStore(await temp(), { now: () => now, host: 'host-a' })
    for (let n = 0; n < 40; n += 1) expect(await rate.reserve(pick('nvidia', 'small'))).toBe(true)
    expect(await rate.reserve(pick('nvidia', 'small'))).toBe(false)
    now = new Date('2026-11-23T03:55:10.000Z')
    expect(await rate.reserve(pick('nvidia', 'small'))).toBe(true)

    const dayDir = await temp()
    const day = createProviderQuotaStore(dayDir, { now: () => now, host: 'host-a' })
    const table = { models: { 'nvidia/small': { dailyQuota: { requests: 2 } } } }
    expect(limitSpec(table, { provider: 'nvidia', model: 'small' }).dayLimit).toBe(2)
    expect(await day.reserve(pick('nvidia', 'small', { table }))).toBe(true)
    expect(await day.reserve(pick('nvidia', 'small', { table }))).toBe(true)
    expect(await day.reserve(pick('nvidia', 'small', { table }))).toBe(false)
  })

  it('marks 429 and 402, including a Kimi weekly limit with no reset time', async () => {
    const dir = await temp()
    let now = new Date('2026-11-23T12:00:00.000Z')
    const store = createProviderQuotaStore(dir, { now: () => now, host: 'host-a' })
    await store.noteErrors({
      table: {},
      errors: [{
        provider: 'kimi-coding',
        model: 'k3.1-pro',
        status: 429,
        message: 'weekly (7-day) usage limit sk-supersecretkey',
      }],
    })
    const kimi = JSON.parse(await fs.readFile(store.file, 'utf8')).providers.kimi
    expect(kimi).toMatchObject({
      window: 'week',
      limit: null,
      used: 0,
      lastStatus: 429,
      exhaustedUntil: '2026-11-30T00:00:00.000Z',
      resetAt: '2026-11-30T00:00:00.000Z',
    })
    expect(kimi.lastError).toContain('weekly (7-day) usage limit')
    expect(kimi.lastError).not.toContain('sk-')
    const view = await store.snapshot()
    expect(store.blocked(view, {}, { provider: 'kimi-coding', model: 'k3.1-pro' }, 0)).toBe(true)
    now = new Date('2026-11-24T12:00:01.000Z')
    expect(store.blocked(await store.snapshot(), {}, { provider: 'kimi-coding', model: 'k3.1-pro' }, 0)).toBe(true)
    now = new Date('2026-11-30T00:00:01.000Z')
    expect(store.blocked(await store.snapshot(), {}, { provider: 'kimi-coding', model: 'k3.1-pro' }, 0)).toBe(false)
    now = new Date('2026-11-23T12:00:00.000Z')
    const fiveHour = exhaustionFromSignal({
      status: 429,
      message: "You've reached your 5-hour usage limit",
      spec: limitSpec({}, { provider: 'kimi-coding', model: 'kimi-for-coding' }),
      now,
    })
    expect(fiveHour.exhaustedUntil).toBe('2026-11-23T17:00:00.000Z')

    const resetAt = new Date('2026-11-23T18:00:00.000Z')
    const signal = exhaustionFromSignal({
      status: 429,
      message: 'rate limit',
      headers: { 'Retry-After': '30', 'x-ratelimit-reset': String(Math.floor(resetAt.getTime() / 1000)) },
      spec: limitSpec({}, { provider: 'nvidia', model: 'small' }),
      now,
    })
    expect(signal.exhaustedUntil).toBe(new Date(now.getTime() + 30000).toISOString())
    const fromHeader = exhaustionFromSignal({
      status: 429,
      message: 'rate limit',
      headers: { 'x-ratelimit-reset': String(Math.floor(resetAt.getTime() / 1000)) },
      spec: limitSpec({}, { provider: 'cursor', model: 'gpt' }),
      now,
    })
    expect(fromHeader.exhaustedUntil).toBe(resetAt.toISOString())

    now = new Date('2026-11-24T12:00:01.000Z')
    await store.noteErrors({
      table: {},
      errors: [{ provider: 'openrouter', model: 'nvidia/nemotron:free', status: 402, message: 'quota exceeded' }],
    })
    const free = JSON.parse(await fs.readFile(store.file, 'utf8')).providers['openrouter-free']
    expect(free.lastStatus).toBe(402)
    expect(free.lastError).toBe('quota exceeded')
    expect(Date.parse(free.exhaustedUntil)).toBe(Date.parse('2026-11-25T00:00:00.000Z'))
  })

  it('migrates daily-quota.json, merges concurrent writers, and reads the pro file', async () => {
    const dir = await temp()
    const now = new Date('2026-11-23T12:00:00.000Z')
    await fs.writeFile(path.join(dir, 'daily-quota.json'), JSON.stringify({
      v: 1,
      days: {
        sambanova: { utcDay: '2026-11-23', requests: 4, tokens: 0, neurons: 0 },
        cloudflare: { utcDay: '2026-11-23', requests: 0, tokens: 0, neurons: 80 },
        'openrouter-free': { utcDay: '2026-11-22', requests: 9, tokens: 0, neurons: 0 },
      },
    }))
    const store = createProviderQuotaStore(dir, { now: () => now, host: 'host-a' })
    const migrated = JSON.parse(await fs.readFile((await store.snapshot()).local && store.file, 'utf8'))
    expect(migrated.providers.sambanova).toMatchObject({ used: 4, limit: 20, unit: 'requests', requestsTotal: 4 })
    expect(migrated.providers.cloudflare).toMatchObject({ used: 80, unit: 'neurons', limit: 10000 })
    expect(migrated.providers['openrouter-free']).toBeUndefined()
    expect(migrated.recentPicks).toEqual([])

    await store.reserve(pick('cursor', 'gpt'))
    const raw = JSON.parse(await fs.readFile(store.file, 'utf8'))
    raw.providers.cursor.used = 7
    raw.providers.cursor.requestsTotal = 7
    await fs.writeFile(store.file, JSON.stringify(raw))
    expect(await store.reserve(pick('cursor', 'gpt'))).toBe(true)
    expect(JSON.parse(await fs.readFile(store.file, 'utf8')).providers.cursor.used).toBe(8)

    await fs.writeFile(store.proFile, JSON.stringify({
      version: 1,
      updatedAt: now.toISOString(),
      host: 'pro',
      providers: {
        gemini: {
          unit: 'requests', used: 0, limit: null, window: 'none',
          windowStart: now.toISOString(), resetAt: null,
          exhaustedUntil: '2026-11-23T13:00:00.000Z',
          lastStatus: 429, lastError: 'rate limit', lastUsedAt: null, requestsTotal: 3,
        },
      },
      recentPicks: [],
    }))
    const view = await store.snapshot()
    expect(store.blocked(view, {}, { provider: 'gemini', model: 'flash' }, 0)).toBe(true)
    expect(await store.reserve(pick('gemini', 'flash'))).toBe(false)
    expect(JSON.parse(await fs.readFile(store.file, 'utf8')).providers.gemini).toBeUndefined()
  })

  it('keeps the NVIDIA day counter when another writer omits it', async () => {
    const dir = await temp()
    const now = new Date('2026-11-23T03:54:10.000Z')
    const store = createProviderQuotaStore(dir, { now: () => now, host: 'host-a' })
    expect(await store.reserve(pick('nvidia', 'small'))).toBe(true)
    const raw = JSON.parse(await fs.readFile(store.file, 'utf8'))
    raw.providers.nvidia.used = 3
    delete raw.providers.nvidia.dayUsed
    delete raw.providers.nvidia.dayLimit
    delete raw.providers.nvidia.dayStart
    await fs.writeFile(store.file, JSON.stringify(raw))
    expect(await store.reserve(pick('nvidia', 'small'))).toBe(true)
    const nvidia = JSON.parse(await fs.readFile(store.file, 'utf8')).providers.nvidia
    expect(nvidia.used).toBe(4)
    expect(nvidia.dayUsed).toBe(2)
    expect(nvidia.dayLimit).toBe(10000)
  })

  it('does not count a completion that Auto already reserved, and can skip the pick log', async () => {
    const dir = await temp()
    const now = new Date('2026-11-23T12:00:00.000Z')
    const store = createProviderQuotaStore(dir, { now: () => now, host: 'host-a' })
    expect(await store.reserve(pick('kimi-coding', 'kimi-for-coding'))).toBe(true)
    const startedAt = new Date(now.getTime() + 500).toISOString()
    expect(await store.recordUse({
      ...pick('kimi-coding', 'kimi-for-coding'),
      startedAt,
      pick: false,
    })).toBe('reserved')
    const kimi = JSON.parse(await fs.readFile(store.file, 'utf8')).providers.kimi
    expect(kimi.used).toBe(1)
    expect(kimi.requestsTotal).toBe(1)

    const other = createProviderQuotaStore(await temp(), { now: () => now, host: 'host-a' })
    expect(await other.recordUse({ ...pick('cursor', 'gpt'), pick: false, tokensIn: 12, tokensOut: 3 })).toBe(true)
    const file = JSON.parse(await fs.readFile(other.file, 'utf8'))
    expect(file.providers.cursor.used).toBe(1)
    expect(file.recentPicks).toEqual([])
  })

  it('uses 50 OpenRouter free requests when the table says there are no credits', () => {
    const bare = limitSpec({}, { provider: 'openrouter', model: 'x:free' })
    expect(bare).toMatchObject({ id: 'openrouter-free', limit: 1000, window: 'day-utc' })
    const noCredits = limitSpec({ openrouterCredits: false }, { provider: 'openrouter', model: 'x:free' })
    expect(noCredits.limit).toBe(50)
    const explicit = limitSpec({
      openrouterCredits: false,
      models: { 'openrouter/x:free': { dailyQuota: { requests: 1000, scope: 'openrouter-free' } } },
    }, { provider: 'openrouter', model: 'x:free', fullModel: 'openrouter/x:free' })
    expect(explicit.limit).toBe(1000)
  })
})

describe('auto-router skips exhausted providers', () => {
  it('counts an uncapped pick and skips Kimi after a weekly 429', async () => {
    const dir = await temp()
    const tablePath = path.join(dir, 'table.json')
    await fs.writeFile(tablePath, JSON.stringify({
      models: {
        'kimi-coding/k3.1-pro': { quality: { coding: 0.99 }, costPerMToken: { in: 0, out: 0 } },
        'cursor/cursor/grok': { quality: { coding: 0.5 }, costPerMToken: { in: 0, out: 0 } },
        'nvidia/small': { quality: { coding: 0.4 }, costPerMToken: { in: 0, out: 0 } },
      },
    }))
    const router = createAutoRouter({ tablePath, logDir: dir, subscriptions: [] })
    const models = [
      { provider: 'kimi-coding', model: 'k3.1-pro' },
      { provider: 'cursor', model: 'cursor/grok' },
      { provider: 'nvidia', model: 'small' },
    ]
    const first = await router.decide({ text: 'Fix the bug in server/index.mjs', models })
    expect(first.chosen).toBe('kimi-coding/k3.1-pro')
    await router.recordLoggedUsage({
      mode: 'auto',
      chosen: 'kimi-coding/k3.1-pro',
      fallbacks: [{ model: 'cursor/cursor/grok', error: '429' }],
    }, [{
      provider: 'kimi-coding',
      model: 'k3.1-pro',
      status: 429,
      message: 'weekly (7-day) usage limit',
    }])
    const file = JSON.parse(await fs.readFile(path.join(dir, 'provider-quota.json'), 'utf8'))
    expect(file.providers.kimi.lastStatus).toBe(429)
    expect(file.providers.kimi.exhaustedUntil).toBeTruthy()
    expect(file.providers.cursor.used).toBe(1)
    expect(file.providers.cursor.exhaustedUntil).toBeNull()
    const second = await router.decide({ text: 'Fix the bug in server/index.mjs', models })
    expect(second.chosen).toBe('cursor/cursor/grok')
    expect(second.reason).toMatch(/provider kimi exhausted/)
    expect(second.candidates.map((row) => row.model)).not.toContain('kimi-coding/k3.1-pro')
  })

  it('clears provider exhaustion after a successful use, and leaves other models exhausted', async () => {
    const dir = await temp()
    let now = new Date('2026-11-26T03:00:00.000Z')
    const store = createProviderQuotaStore(dir, { now: () => now, host: 'host-a' })
    await store.noteErrors({
      table: {},
      errors: [
        { provider: 'kimi-coding', model: 'kimi-for-coding', status: 429, message: 'weekly (7-day) usage limit' },
        { provider: 'kimi-coding', model: 'k3.1-pro', status: 429, message: 'resource limit exceeded' },
      ],
    })
    const before = JSON.parse(await fs.readFile(store.file, 'utf8')).providers.kimi
    expect(before.exhaustedUntil).toBe('2026-11-30T00:00:00.000Z')
    expect(before.models['k3.1-pro'].exhaustedUntil).toBeTruthy()
    const siblingUntil = before.models['k3.1-pro'].exhaustedUntil
    const view = await store.snapshot()
    expect(store.blocked(view, {}, { provider: 'kimi-coding', model: 'kimi-for-coding' }, 0)).toBe(true)

    now = new Date('2026-11-26T03:05:00.000Z')
    expect(await store.recordUse(pick('kimi-coding', 'kimi-for-coding'))).toBe(true)
    const after = JSON.parse(await fs.readFile(store.file, 'utf8')).providers.kimi
    expect(after.exhaustedUntil).toBeNull()
    expect(after.models['k3.1-pro'].exhaustedUntil).toBe(siblingUntil)
    const afterView = await store.snapshot()
    expect(store.blocked(afterView, {}, { provider: 'kimi-coding', model: 'kimi-for-coding' }, 0)).toBe(false)
    expect(store.blocked(afterView, {}, { provider: 'kimi-coding', model: 'k3.1-pro' }, 0)).toBe(true)

    const tablePath = path.join(dir, 'table.json')
    await fs.writeFile(tablePath, JSON.stringify({
      models: {
        'kimi-coding/kimi-for-coding': { quality: { coding: 0.99 }, costPerMToken: { in: 0, out: 0 } },
        'cursor/cursor/grok': { quality: { coding: 0.5 }, costPerMToken: { in: 0, out: 0 } },
      },
    }))
    const router = createAutoRouter({ tablePath, logDir: dir, subscriptions: [] })
    const models = [
      { provider: 'kimi-coding', model: 'kimi-for-coding' },
      { provider: 'cursor', model: 'cursor/grok' },
    ]
    const decision = await router.decide({ text: 'Fix the bug in server/index.mjs', models })
    expect(decision.chosen).toBe('kimi-coding/kimi-for-coding')
    expect(decision.reason).not.toMatch(/provider kimi exhausted/)
  })

  it('skips exhausted cursor models and keeps composer-2.5', async () => {
    const dir = await temp()
    let now = new Date('2026-11-23T12:00:00.000Z')
    const store = createProviderQuotaStore(dir, { now: () => now, host: 'host-a' })
    expect(isQuotaSignal(400, 'resource limit exceeded')).toBe(true)
    expect(isQuotaSignal(403, 'Plan limit reached')).toBe(true)
    expect(isQuotaSignal(500, 'insufficient credits')).toBe(true)
    expect(isQuotaSignal(500, 'internal error')).toBe(false)
    expect(isQuotaSignal(400, 'bad request')).toBe(false)
    expect(modelQuotaId('cursor/cursor/claude-opus-5-5')).toBe('claude-opus-5-5')

    const recorded = await store.noteErrors({
      table: {},
      errors: [
        { provider: 'custom', model: 'cursor/claude-opus-5-5', status: 400, message: 'Cursor rate limit exceeded: resource limit exceeded' },
        { provider: 'cursor', model: 'cursor/gpt-5.6-sol', status: 500, message: 'resource limit exceeded' },
        { provider: 'cursor', model: 'composer-2.5', status: 500, message: 'internal error' },
      ],
    })
    expect(recorded).toBe(true)
    const file = JSON.parse(await fs.readFile(store.file, 'utf8'))
    expect(file.providers.custom).toBeUndefined()
    expect(file.providers.cursor.exhaustedUntil).toBeNull()
    expect(file.providers.cursor.models['claude-opus-5-5']).toMatchObject({
      exhaustedUntil: '2026-11-23T18:00:00.000Z',
      lastStatus: 400,
    })
    expect(file.providers.cursor.models['claude-opus-5-5'].lastError).toMatch(/resource limit exceeded/i)
    expect(file.providers.cursor.models['gpt-5.6-sol'].exhaustedUntil).toBe('2026-11-23T18:00:00.000Z')
    expect(file.providers.cursor.models['composer-2.5']).toBeUndefined()
    const view = await store.snapshot()
    expect(store.blocked(view, {}, { provider: 'cursor', model: 'cursor/claude-opus-5-5' }, 0)).toBe(true)
    expect(store.blocked(view, {}, { provider: 'cursor', model: 'cursor/composer-2.5' }, 0)).toBe(false)

    now = new Date('2026-11-23T13:00:00.000Z')
    await store.noteErrors({
      table: {},
      errors: [{ provider: 'cursor', model: 'claude-opus-5-5', status: 400, message: 'resource limit exceeded' }],
    })
    const renewed = JSON.parse(await fs.readFile(store.file, 'utf8')).providers.cursor.models['claude-opus-5-5']
    expect(renewed.exhaustedUntil).toBe('2026-11-23T19:00:00.000Z')

    const raw = JSON.parse(await fs.readFile(store.file, 'utf8'))
    raw.providers.cursor.models['claude-opus-5-5'].exhaustedUntil = '2026-11-24T00:00:00.000Z'
    raw.providers.cursor.models['claude-opus-5-5'].lastErrorAt = '2026-11-23T13:30:00.000Z'
    await fs.writeFile(store.file, JSON.stringify(raw))
    now = new Date('2026-11-23T13:10:00.000Z')
    await store.noteErrors({
      table: {},
      errors: [{ provider: 'cursor', model: 'claude-opus-5-5', status: 403, message: 'resource limit exceeded' }],
    })
    expect(JSON.parse(await fs.readFile(store.file, 'utf8')).providers.cursor.models['claude-opus-5-5'].exhaustedUntil)
      .toBe('2026-11-24T00:00:00.000Z')

    expect(await store.reserve(pick('cursor', 'cursor/composer-2.5'))).toBe(true)
    const afterUse = JSON.parse(await fs.readFile(store.file, 'utf8')).providers.cursor
    expect(afterUse.used).toBe(1)
    expect(afterUse.models['claude-opus-5-5'].exhaustedUntil).toBe('2026-11-24T00:00:00.000Z')
    expect(await store.reserve(pick('cursor', 'cursor/claude-opus-5-5'))).toBe(false)

    const wide = createProviderQuotaStore(await temp(), { now: () => now, host: 'host-a' })
    await wide.noteErrors({
      table: {},
      errors: [{ provider: 'cursor', model: 'cursor/claude-opus-5-5', status: 429, message: 'rate limit' }],
    })
    const wideView = await wide.snapshot()
    expect(wide.blocked(wideView, {}, { provider: 'cursor', model: 'cursor/composer-2.5' }, 0)).toBe(true)
    expect(JSON.parse(await fs.readFile(wide.file, 'utf8')).providers.cursor.exhaustedUntil).toBe('2026-11-23T19:10:00.000Z')

    const tablePath = path.join(dir, 'table.json')
    await fs.writeFile(tablePath, JSON.stringify({
      models: {
        'cursor/cursor/claude-opus-5-5': { quality: { coding: 0.99 }, costPerMToken: { in: 0, out: 0 } },
        'cursor/cursor/composer-2.5': { quality: { coding: 0.4 }, costPerMToken: { in: 0, out: 0 } },
        'nvidia/small': { quality: { coding: 0.2 }, costPerMToken: { in: 0, out: 0 } },
      },
    }))
    const router = createAutoRouter({ tablePath, logDir: dir, subscriptions: ['cursor'] })
    const models = [
      { provider: 'cursor', model: 'cursor/claude-opus-5-5' },
      { provider: 'cursor', model: 'cursor/composer-2.5' },
      { provider: 'nvidia', model: 'small' },
    ]
    const picked = await router.decide({ text: 'Fix the bug in server/index.mjs', models })
    expect(picked.chosen).toBe('cursor/cursor/composer-2.5')
    expect(picked.candidates.map((row) => row.model)).not.toContain('cursor/cursor/claude-opus-5-5')
    expect(picked.candidates.map((row) => row.model)).toContain('cursor/cursor/composer-2.5')
  })

  it('cools down a 410 end-of-life model and an upstream rate-limited free model without blocking the provider', async () => {
    const dir = await temp()
    const now = new Date('2026-11-24T03:00:00.000Z')
    const store = createProviderQuotaStore(dir, { now: () => now, host: 'host-a' })
    expect(isQuotaSignal(410, 'Gone')).toBe(true)
    expect(isQuotaSignal(null, "The model 'z-ai/glm-5.3' has reached its end of life on 2026-10-28T08:00:00Z")).toBe(true)

    await store.noteErrors({
      table: {},
      errors: [
        {
          provider: 'nvidia',
          model: 'z-ai/glm-5.3',
          status: 410,
          message: "Error code: 410 - The model 'z-ai/glm-5.3' has reached its end of life on 2026-10-28T08:00:00Z and is no longer available.",
        },
        {
          provider: 'openrouter',
          model: 'baidu/ernie-5.5-flash-preview:free',
          status: 429,
          message: 'baidu/ernie-5.5-flash-preview:free is temporarily rate-limited upstream',
        },
      ],
    })
    const view = await store.snapshot()
    // Only the retired NVIDIA model is blocked; other NVIDIA models remain open.
    expect(store.blocked(view, {}, { provider: 'nvidia', model: 'z-ai/glm-5.3' }, 0)).toBe(true)
    expect(store.blocked(view, {}, { provider: 'nvidia', model: 'moonshotai/kimi-k3' }, 0)).toBe(false)
    // Only the rate-limited OpenRouter free model is paused (10 min), not all of openrouter-free.
    expect(store.blocked(view, {}, { provider: 'openrouter', model: 'baidu/ernie-5.5-flash-preview:free' }, 0)).toBe(true)
    expect(store.blocked(view, {}, { provider: 'openrouter', model: 'nvidia/nemotron-3-ultra:free' }, 0)).toBe(false)
    const file = JSON.parse(await fs.readFile(store.file, 'utf8'))
    expect(file.providers.nvidia.exhaustedUntil).toBeNull()
    expect(file.providers.nvidia.models['glm-5.3'].exhaustedUntil).toBe('2026-11-25T03:00:00.000Z')
    expect(file.providers['openrouter-free'].exhaustedUntil).toBeNull()
    expect(file.providers['openrouter-free'].models['ernie-5.5-flash-preview:free'].exhaustedUntil).toBe('2026-11-24T03:10:00.000Z')
  })
  for (const message of [
    'Cursor Connect error internal: Cursor blob capacity is exhausted; the blob was not stored.',
    'upstream_server_error: Cursor requested unknown Responses tool: ocx_client_tool_search',
  ]) {
    it(`is transient_fallback, never a quota signal: ${message.slice(0, 60)}...`, async () => {
      const dir = await temp()
      const now = new Date('2026-11-26T10:00:00.000Z')
      const store = createProviderQuotaStore(dir, { now: () => now, host: 'host-a' })
      expect(isQuotaSignal(502, message)).toBe(false)
      expect(isTransientFallbackSignal(502, message)).toBe(true)
      expect(classifyUpstreamError(502, message)).toBe('transient_fallback')
      const recorded = await store.noteErrors({
        table: {},
        errors: [{ provider: 'cursor', model: 'cursor/grok-4.7', status: 502, message }],
      })
      expect(recorded).toBe(false)
      const view = await store.snapshot()
      expect(store.blocked(view, {}, { provider: 'cursor', model: 'cursor/grok-4.7' }, 0)).toBe(false)
      const file = JSON.parse(await fs.readFile(store.file, 'utf8'))
      expect(file.providers?.cursor?.exhaustedUntil ?? null).toBeNull()
    })
  }

  it('blocks kimi-coding on a weekly quota limit', async () => {
    const dir = await temp()
    const now = new Date('2026-11-26T10:00:00.000Z')
    const store = createProviderQuotaStore(dir, { now: () => now, host: 'host-a' })
    const recorded = await store.noteErrors({
      table: {},
      errors: [{
        provider: 'kimi-coding',
        model: 'kimi-for-coding',
        status: 429,
        message: "exceeded_current_quota_error: You've reached your weekly (7-day) usage limit",
      }],
    })
    expect(recorded).toBe(true)
    const view = await store.snapshot()
    expect(store.blocked(view, {}, { provider: 'kimi-coding', model: 'kimi-for-coding' }, 0)).toBe(true)
  })
})
