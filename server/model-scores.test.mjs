import { describe, expect, it, vi } from 'vitest'
import { compactModel, compactModels, createModelScores, SCORES_TTL_MS } from './model-scores.mjs'

const entry = (slug, intelligence, extra = {}) => ({
  slug, name: slug.toUpperCase(), model_creator: { name: 'Lab' },
  evaluations: { artificial_analysis_intelligence_index: intelligence },
  pricing: { price_1m_input_tokens: 1, price_1m_output_tokens: 5 },
  performance: { median_output_tokens_per_second: 80.123 },
  ...extra,
})
const page = (data, has_more = false) => ({ ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ data, pagination: { has_more } }) })
const memoryKeys = (initial = '') => {
  let key = initial
  return { load: () => key, save: (value) => { key = value }, clear: () => { key = '' } }
}
const KEY = 'test-key-test-key'

describe('compactModel', () => {
  it('keeps the used fields and computes the 3:1 blended price', () => {
    expect(compactModel(entry('gemini-3-5-flash', 41.234))).toEqual({
      slug: 'gemini-3-5-flash', name: 'GEMINI-3-5-FLASH', creator: 'Lab', intelligence: 41.23, outputSpeed: 80.12, priceBlended: 2,
    })
  })
  it('rejects entries without a score, a name or a safe slug', () => {
    expect(compactModel({ slug: 'x', name: 'X', evaluations: {} })).toBeNull()
    expect(compactModel(entry('a b', 10))).toBeNull()
    expect(compactModel(null)).toBeNull()
    expect(compactModels([entry('a', 1), entry('a', 2), 'x'])).toHaveLength(1)
  })
})

describe('createModelScores', () => {
  it('reports a missing key without calling the API', async () => {
    const fetchImpl = vi.fn()
    const scores = createModelScores({ keyStore: memoryKeys(), env: {}, fetchImpl })
    expect(await scores.get()).toMatchObject({ keyMissing: true, models: [], configured: false })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('fetches with the key header, follows pages and caches for 24 h', async () => {
    let time = 1_000
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(page([entry('a', 10)], true))
      .mockResolvedValueOnce(page([entry('b', 20)]))
    const scores = createModelScores({ keyStore: memoryKeys(KEY), env: {}, fetchImpl, now: () => time })
    const result = await scores.get()
    expect(result.models.map((model) => model.slug)).toEqual(['a', 'b'])
    expect(result.source).toBe('Artificial Analysis')
    expect(fetchImpl.mock.calls[0][1].headers['x-api-key']).toBe(KEY)
    expect(JSON.stringify(result)).not.toContain(KEY)
    await scores.get()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    time += SCORES_TTL_MS + 1
    fetchImpl.mockResolvedValueOnce(page([entry('c', 30)]))
    expect((await scores.get()).models.map((model) => model.slug)).toEqual(['c'])
  })

  it('serves the stale list when the API fails, with a short error and no retry storm', async () => {
    let time = 0
    const fetchImpl = vi.fn().mockResolvedValueOnce(page([entry('a', 10)]))
    const scores = createModelScores({ keyStore: memoryKeys(KEY), env: {}, fetchImpl, now: () => time })
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

  it('maps 401 to invalid_key and falls back to the older endpoint on 404', async () => {
    const denied = createModelScores({ keyStore: memoryKeys(KEY), env: {}, fetchImpl: vi.fn().mockResolvedValue({ ok: false, status: 401, headers: new Headers() }) })
    expect((await denied.get()).error).toBe('invalid_key')
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404, headers: new Headers() })
      .mockResolvedValueOnce(page([entry('old', 5)]))
    const legacy = createModelScores({ keyStore: memoryKeys(KEY), env: {}, fetchImpl })
    expect((await legacy.get()).models[0].slug).toBe('old')
    expect(fetchImpl.mock.calls[1][0]).toContain('/api/v2/data/llms/models')
  })

  it('stores the key only where an encrypted store exists', async () => {
    const plain = createModelScores({ keyStore: null, env: {} })
    expect(plain.setKey(KEY)).toBe('storage_unavailable')
    expect(plain.status()).toEqual({ configured: false, keySource: 'none', canStore: false })
    const withEnv = createModelScores({ keyStore: null, env: { ARTIFICIAL_ANALYSIS_API_KEY: KEY }, fetchImpl: vi.fn().mockResolvedValue(page([entry('a', 1)])) })
    expect(withEnv.status()).toMatchObject({ configured: true, keySource: 'env' })
    const store = memoryKeys()
    const scores = createModelScores({ keyStore: store, env: {} })
    expect(scores.setKey('no')).toBe('invalid_key')
    expect(scores.setKey(KEY)).toBe('')
    expect(scores.status()).toEqual({ configured: true, keySource: 'stored', canStore: true })
    expect(scores.removeKey()).toBe('')
    expect(scores.status().configured).toBe(false)
  })
})
