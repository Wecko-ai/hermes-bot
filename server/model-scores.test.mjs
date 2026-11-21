import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { compactModel, compactModels, createModelScores, mergeModels, SCORES_TTL_MS } from './model-scores.mjs'

const entry = (slug, intelligence, categories = {}) => ({
  model_id: slug,
  model_name: slug.toUpperCase(),
  organization: 'Lab',
  conservative_rating: intelligence,
  rank: 1,
  open_weight: false,
  categories,
})
const response = (models, quota = { limit: 250, remaining: 249, used: 1 }) => ({
  ok: true,
  status: 200,
  headers: new Headers({
    'x-quota-limit': String(quota.limit),
    'x-quota-remaining': String(quota.remaining),
    'x-quota-used': String(quota.used),
  }),
  text: async () => JSON.stringify({ models, ranked_at: '2026-11-21T00:00:00Z' }),
})
const KEY = 'test-key-test-key'

describe('compactModel', () => {
  it('uses conservative_rating and maps only the supported category scores', () => {
    expect(compactModel(entry('gemini-3.5-flash', 41.234, {
      code: { score: 36.789 }, agents: { score: 33.333 }, reasoning: { score: 99 },
    }))).toEqual({
      slug: 'gemini-3.5-flash', name: 'GEMINI-3.5-FLASH', creator: 'Lab', intelligence: 41.23, coding: 36.79, agentic: 33.33,
    })
  })

  it('accepts coding/agentic aliases and the two local snapshot shapes', () => {
    expect(compactModel({ id: 'top-model', name: 'Top', org: 'Lab', score: 50 })).toMatchObject({ slug: 'top-model', intelligence: 50 })
    expect(compactModel({ slug: 'detail-model', name: 'Detail', score: 40, categories: {
      coding: { score: 30 }, frontend_development: { score: 31 }, tool_calling: { score: 20 },
    } })).toMatchObject({ coding: 30, agentic: 20 })
  })

  it('rejects entries without a score, a name or a safe slug', () => {
    expect(compactModel({ model_id: 'x', model_name: 'X' })).toBeNull()
    expect(compactModel(entry('a b', 10))).toBeNull()
    expect(compactModel(null)).toBeNull()
    expect(compactModels([entry('a', 1), entry('a', 2), 'x'])).toHaveLength(1)
  })

  it('merges fresh general scores over a snapshot without losing its categories', () => {
    const merged = mergeModels(
      [{ slug: 'a', name: 'Old', score: 10, categories: { code: { score: 8 }, agents: { score: 7 } } }, { slug: 'b', name: 'B', score: 5 }],
      [entry('a', 20)],
    )
    expect(merged).toEqual([
      { slug: 'a', name: 'A', creator: 'Lab', intelligence: 20, coding: 8, agentic: 7 },
      { slug: 'b', name: 'B', creator: '', intelligence: 5 },
    ])
  })
})

describe('createModelScores', () => {
  it('reports no key and no scores without calling the API or failing', async () => {
    const fetchImpl = vi.fn()
    const scores = createModelScores({ env: {}, fetchImpl, readKeychain: async () => '' })
    expect(await scores.get()).toMatchObject({ keyMissing: true, models: [], configured: false, keySource: 'none', quota: null })
    expect((await scores.get()).error).toBeUndefined()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('fetches one top-50 response with a Bearer key, reads quota and caches for 24 h', async () => {
    let time = 1_000
    const fetchImpl = vi.fn().mockResolvedValue(response([entry('a', 10)]))
    const scores = createModelScores({ env: { LLM_STATS_API_KEY: KEY }, fetchImpl, now: () => time, readKeychain: async () => '' })
    const result = await scores.get()
    expect(result.models.map((model) => model.slug)).toEqual(['a'])
    expect(result).toMatchObject({ source: 'LLM Stats', keySource: 'env', quota: { limit: 250, remaining: 249, used: 1 } })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.llm-stats.com/stats/v1/rankings?category=general&limit=50')
    expect(fetchImpl.mock.calls[0][1].headers.authorization).toBe(`Bearer ${KEY}`)
    expect(JSON.stringify(result)).not.toContain(KEY)
    await scores.get()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    time += SCORES_TTL_MS + 1
    fetchImpl.mockResolvedValueOnce(response([entry('c', 30)]))
    expect((await scores.get()).models.map((model) => model.slug)).toEqual(['c'])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('reads the keychain only when no environment key is set', async () => {
    const readKeychain = vi.fn().mockResolvedValue(`${KEY}\n`)
    const scores = createModelScores({ env: {}, fetchImpl: vi.fn().mockResolvedValue(response([entry('a', 1)])), readKeychain })
    expect((await scores.get()).keySource).toBe('keychain')
    expect(readKeychain).toHaveBeenCalledTimes(1)
    expect(await scores.status()).toEqual({ configured: true, keySource: 'keychain' })

    const envFirst = createModelScores({ env: { LLM_STATS_API_KEY: KEY }, fetchImpl: vi.fn().mockResolvedValue(response([entry('a', 1)])), readKeychain })
    expect((await envFirst.get()).keySource).toBe('env')
    expect(readKeychain).toHaveBeenCalledTimes(2)
  })

  it('executes a fake local key command before env and keychain, without returning its stdout', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'hermesbot-llm-stats-command-'))
    const script = path.join(directory, 'key.cjs')
    writeFileSync(script, `process.stdout.write(${JSON.stringify(`${KEY}\n`)})`)
    const envKey = 'env-key-env-key'
    const readKeychain = vi.fn().mockResolvedValue('')
    const fetchImpl = vi.fn().mockResolvedValue(response([entry('a', 1)]))
    const scores = createModelScores({
      env: { LLM_STATS_API_KEY: envKey }, keyCommand: [process.execPath, script], readKeychain, fetchImpl,
    })
    const result = await scores.get()
    expect(result.keySource).toBe('command')
    expect(JSON.stringify(result)).not.toContain(KEY)
    expect(JSON.stringify(result)).not.toContain(envKey)
    expect(fetchImpl.mock.calls[0][1].headers.authorization).toBe(`Bearer ${KEY}`)
    expect(readKeychain).not.toHaveBeenCalled()
    expect(await scores.status()).toEqual({ configured: true, keySource: 'command' })
  })

  it('falls back to the keychain when the command fails and rejects a relative executable', async () => {
    const readCommand = vi.fn().mockRejectedValue(new Error(`failed ${KEY}`))
    const readKeychain = vi.fn().mockResolvedValue(KEY)
    const scores = createModelScores({
      env: {}, keyCommand: ['/usr/bin/ssh', 'host'], readCommand, readKeychain,
      fetchImpl: vi.fn().mockResolvedValue(response([entry('a', 1)])),
    })
    expect((await scores.get()).keySource).toBe('keychain')

    const envFallback = createModelScores({
      env: { LLM_STATS_API_KEY: KEY }, keyCommand: ['/usr/bin/ssh', 'host'], readCommand, readKeychain,
      fetchImpl: vi.fn().mockResolvedValue(response([entry('a', 1)])),
    })
    expect((await envFallback.get()).keySource).toBe('env')

    const invalid = createModelScores({
      env: {}, keyCommand: ['relative/ssh'], readCommand, readKeychain,
      fetchImpl: vi.fn().mockResolvedValue(response([entry('a', 1)])),
    })
    expect((await invalid.get()).keySource).toBe('keychain')
    expect(readCommand).toHaveBeenCalledTimes(2)
  })

  it('uses the local snapshot offline and combines top with detailed models', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'hermesbot-llm-stats-'))
    const snapshotFile = path.join(directory, 'snapshot.json')
    writeFileSync(snapshotFile, JSON.stringify({
      generatedAt: '2026-10-29',
      top: [{ id: 'a', name: 'Fresh A', org: 'Lab', score: 15 }],
      models: [
        { slug: 'a', name: 'A', score: 10, categories: { coding: { score: 9 } } },
        { slug: 'b', name: 'B', score: 5, categories: { agents: { score: 4 } } },
      ],
    }))
    const scores = createModelScores({ env: {}, snapshotFile, fetchImpl: vi.fn(), readKeychain: async () => '' })
    expect(await scores.get()).toMatchObject({
      configured: false,
      keyMissing: true,
      updatedAt: '2026-10-29T00:00:00.000Z',
      models: [
        { slug: 'a', name: 'Fresh A', intelligence: 15, coding: 9 },
        { slug: 'b', name: 'B', intelligence: 5, agentic: 4 },
      ],
    })
  })

  it('serves stale and snapshot data when the API fails, with a short error and no retry storm', async () => {
    let time = 0
    const fetchImpl = vi.fn().mockResolvedValueOnce(response([entry('a', 10)]))
    const scores = createModelScores({ env: { LLM_STATS_API_KEY: KEY }, fetchImpl, now: () => time, readKeychain: async () => '' })
    await scores.get()
    time += SCORES_TTL_MS + 1
    fetchImpl.mockRejectedValue(new Error(`boom ${KEY}`))
    const stale = await scores.get()
    expect(stale.models).toHaveLength(1)
    expect(stale.error).toBe('upstream_failed')
    expect(JSON.stringify(stale)).not.toContain(KEY)
    const calls = fetchImpl.mock.calls.length
    await scores.get()
    expect(fetchImpl).toHaveBeenCalledTimes(calls)
  })

  it('maps 401 and 429 without exposing the key', async () => {
    const denied = createModelScores({ env: { LLM_STATS_API_KEY: KEY }, fetchImpl: vi.fn().mockResolvedValue({ ok: false, status: 401, headers: new Headers() }), readKeychain: async () => '' })
    const deniedBody = await denied.get()
    expect(deniedBody.error).toBe('invalid_key')
    expect(deniedBody.quota).toBeNull()
    expect(JSON.stringify(deniedBody)).not.toContain(KEY)
    const limited = createModelScores({ env: { LLM_STATS_API_KEY: KEY }, fetchImpl: vi.fn().mockResolvedValue({ ok: false, status: 429, headers: new Headers() }), readKeychain: async () => '' })
    expect((await limited.get()).error).toBe('rate_limited')
  })

  it('persists only sanitized model data and quota, never the key', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'hermesbot-llm-stats-cache-'))
    const cacheFile = path.join(directory, 'cache.json')
    const scores = createModelScores({ cacheFile, env: { LLM_STATS_API_KEY: KEY }, fetchImpl: vi.fn().mockResolvedValue(response([entry('a', 10)])), readKeychain: async () => '' })
    await scores.get()
    const cached = readFileSync(cacheFile, 'utf8')
    expect(cached).not.toContain(KEY)
    expect(JSON.parse(cached).models[0]).toEqual({ slug: 'a', name: 'A', creator: 'Lab', intelligence: 10 })
    const restored = createModelScores({ cacheFile, env: {}, fetchImpl: vi.fn(), readKeychain: async () => '' })
    expect((await restored.get()).models[0].slug).toBe('a')
  })
})
