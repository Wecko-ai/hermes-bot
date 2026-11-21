import { describe, expect, it } from 'vitest'
import type { ModelOption } from '../types'
import { buildScoreIndex, parseScores, recommendations, scoreModels, EMPTY_SCORES, type ScoredModel } from './model-scores'

const scored = (slug: string, intelligence: number, extra: Partial<ScoredModel> = {}): ScoredModel => ({ slug, name: slug, creator: 'Lab', intelligence, ...extra })
const option = (model: string, provider = 'p'): ModelOption => ({ provider, model, providerName: provider })

describe('buildScoreIndex', () => {
  const index = buildScoreIndex([
    scored('gemini-3-5-flash', 40), scored('gemini-3-5-pro', 50), scored('gpt-6-1-sol', 60), scored('gpt-6-1-sol-pro', 65),
    scored('claude-opus-5-5', 70), scored('claude-opus-5-5-thinking', 74), scored('gemini-3-1-pro-preview', 45),
    scored('qwen3-8-27b', 30), scored('kimi-k3-1-pro', 55), scored('gpt-oss-20b', 20),
  ])
  it('matches spellings of the same model', () => {
    expect(index.find('gemini-3.5-flash')?.slug).toBe('gemini-3-5-flash')
    expect(index.find('google/gemini-3.5-flash-20260101')?.slug).toBe('gemini-3-5-flash')
    expect(index.find('gpt-6.1-sol')?.slug).toBe('gpt-6-1-sol')
    expect(index.find('cursor/gpt-6.1-sol')?.slug).toBe('gpt-6-1-sol')
    expect(index.find('claude-opus-5-5')?.slug).toBe('claude-opus-5-5')
    expect(index.find('qwen3.8:27b')?.slug).toBe('qwen3-8-27b')
    expect(index.find('gpt-oss:20b')?.slug).toBe('gpt-oss-20b')
  })
  it('never takes the neighbouring tier, a variant or an unversioned id', () => {
    expect(index.find('gemini-3.5-flash-lite')).toBeUndefined()
    expect(index.find('gpt-6.1-terra')).toBeUndefined()
    expect(index.find('gemini-3.1-pro')).toBeUndefined()
    expect(index.find('gemini-pro-latest')).toBeUndefined()
    expect(index.find('claude-opus-5-5:thinking')?.slug).toBe('claude-opus-5-5-thinking')
    expect(index.find('gemini-3.1-pro-preview')?.slug).toBe('gemini-3-1-pro-preview')
  })
  it('uses the alias table', () => {
    expect(index.find('k3.1-pro')?.slug).toBe('kimi-k3-1-pro')
  })
})

describe('recommendations', () => {
  const population = [
    scored('a', 80, { coding: 90, agentic: 85 }),
    scored('b', 70, { coding: 70, agentic: 60 }),
    scored('c', 60, { coding: 60, agentic: 50 }),
    scored('d', 30, { coding: 20, agentic: 10 }),
    scored('e', 20, { coding: 10, agentic: 5 }),
    scored('f', 10, { coding: 5, agentic: 1 }),
    scored('g', 45, { coding: 15, agentic: 8 }),
  ]
  const chips = recommendations(population)
  it('gives the best fifth of each available score, at most two chips', () => {
    expect(chips(population[0])).toEqual(['agentic', 'coding'])
    expect(chips(population[2])).toEqual([])
  })
  it('ranks nothing from fewer than five scored models', () => {
    expect(recommendations(population.slice(0, 3))(population[0])).toEqual([])
  })
  it('falls back to reasoning when no coding or agentic category is available', () => {
    const general = [10, 20, 30, 40, 50, 60].map((n, i) => scored(`m${i}`, n))
    expect(recommendations(general)(general[5])).toEqual(['reasoning'])
  })
})

describe('scoreModels and parseScores', () => {
  it('keys by provider and model and ignores unmatched models', () => {
    const state = { ...EMPTY_SCORES, models: [scored('gemini-3-5-flash', 40)] }
    const map = scoreModels([option('gemini-3.5-flash', 'gemini'), option('mystery-1')], state)
    expect(map.get('gemini:gemini-3.5-flash')?.score.intelligence).toBe(40)
    expect(map.size).toBe(1)
  })
  it('drops malformed entries and retired provider-specific fields', () => {
    const state = parseScores({
      models: [{ slug: 'a', name: 'A', intelligence: 5, coding: 'x', outputSpeed: 200, priceBlended: 1 }, { slug: 'b' }, 7],
      keyMissing: true,
      keySource: 'keychain',
      quota: { limit: 250, remaining: 200, used: 50 },
    })
    expect(state.models).toEqual([{ slug: 'a', name: 'A', creator: '', intelligence: 5 }])
    expect(state.keyMissing).toBe(true)
    expect(state.keySource).toBe('keychain')
    expect(state.quota).toEqual({ limit: 250, remaining: 200, used: 50 })
    expect(parseScores({ keySource: 'command' }).keySource).toBe('command')
  })
})
