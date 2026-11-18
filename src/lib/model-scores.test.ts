import { describe, expect, it } from 'vitest'
import type { ModelOption } from '../types'
import { buildScoreIndex, parseScores, recommendations, scoreModels, EMPTY_SCORES, type ScoredModel } from './model-scores'

const aa = (slug: string, intelligence: number, extra: Partial<ScoredModel> = {}): ScoredModel => ({ slug, name: slug, creator: 'Lab', intelligence, ...extra })
const option = (model: string, provider = 'p'): ModelOption => ({ provider, model, providerName: provider })

describe('buildScoreIndex', () => {
  const index = buildScoreIndex([
    aa('gemini-3-5-flash', 40), aa('gemini-3-5-pro', 50), aa('gpt-6-1-sol', 60), aa('gpt-6-1-sol-pro', 65),
    aa('claude-opus-5-5', 70), aa('claude-opus-5-5-thinking', 74), aa('gemini-3-1-pro-preview', 45),
    aa('qwen3-8-27b', 30), aa('kimi-k3-1-pro', 55), aa('gpt-oss-20b', 20),
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
    aa('a', 80, { coding: 90, agentic: 85, outputSpeed: 40, priceBlended: 10 }),
    aa('b', 70, { coding: 70, agentic: 60, outputSpeed: 200, priceBlended: 0.5 }),
    aa('c', 60, { coding: 60, agentic: 50, outputSpeed: 150, priceBlended: 0.4 }),
    aa('d', 30, { coding: 20, agentic: 10, outputSpeed: 300, priceBlended: 0.1 }),
    aa('e', 20, { coding: 10, agentic: 5, outputSpeed: 50, priceBlended: 0.1 }),
    aa('f', 10, { coding: 5, agentic: 1, outputSpeed: 90, priceBlended: 3 }),
    aa('g', 45, { coding: 15, agentic: 8, outputSpeed: 10, priceBlended: 0.3 }),
  ]
  const chips = recommendations(population)
  it('gives the best fifth of each index, at most two chips', () => {
    expect(chips(population[0])).toEqual(['agentic', 'coding'])
  })
  it('requires speed and a floor of quality for fast and cheap', () => {
    expect(chips(population[6])).toEqual(['cheap'])
    expect(chips(population[3])).toEqual(['fast'])
    expect(chips(population[5])).toEqual([])
    expect(chips(population[4])).toEqual([])
  })
  it('ranks nothing from fewer than five scored models', () => {
    expect(recommendations(population.slice(0, 3))(population[0])).toEqual([])
  })
  it('falls back to reasoning and engineering when the API has no coding or agentic index', () => {
    const free = [10, 20, 30, 40, 50, 60].map((n, i) => aa(`m${i}`, n, { engineering: n }))
    expect(recommendations(free)(free[5])).toEqual(['engineering', 'reasoning'])
  })
})

describe('scoreModels and parseScores', () => {
  it('keys by provider and model and ignores unmatched models', () => {
    const state = { ...EMPTY_SCORES, models: [aa('gemini-3-5-flash', 40)] }
    const map = scoreModels([option('gemini-3.5-flash', 'gemini'), option('mystery-1')], state)
    expect(map.get('gemini:gemini-3.5-flash')?.score.intelligence).toBe(40)
    expect(map.size).toBe(1)
  })
  it('drops malformed entries', () => {
    const state = parseScores({ models: [{ slug: 'a', name: 'A', intelligence: 5, coding: 'x' }, { slug: 'b' }, 7], keyMissing: true })
    expect(state.models).toEqual([{ slug: 'a', name: 'A', creator: '', intelligence: 5 }])
    expect(state.keyMissing).toBe(true)
  })
})
