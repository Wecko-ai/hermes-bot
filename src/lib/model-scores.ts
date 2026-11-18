import { useSyncExternalStore } from 'react'
import type { ModelOption } from '../types'
import { modelMatchKey, modelQualifiers } from './model-names'

/** One model of the Artificial Analysis list, as the local server serves it (`/api/model-scores`). */
export interface ScoredModel {
  slug: string
  name: string
  creator: string
  /** Artificial Analysis Intelligence Index. */
  intelligence: number
  coding?: number
  agentic?: number
  engineering?: number
  /** Median output tokens per second. */
  outputSpeed?: number
  /** USD per million tokens, 3 parts input for 1 part output. */
  priceBlended?: number
}

export interface ScoresState {
  models: ScoredModel[]
  updatedAt: string
  /** The server has no Artificial Analysis key (or none can be stored). */
  keyMissing: boolean
  configured: boolean
  canStore: boolean
  keySource: 'stored' | 'env' | 'none'
  /** Short code of the last failed refresh, when the list shown is stale. */
  error: string
  loaded: boolean
}

export const EMPTY_SCORES: ScoresState = { models: [], updatedAt: '', keyMissing: false, configured: false, canStore: false, keySource: 'none', error: '', loaded: false }

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

export function parseScores(value: unknown): ScoresState {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const models: ScoredModel[] = []
  for (const item of Array.isArray(raw.models) ? raw.models : []) {
    const entry = item && typeof item === 'object' ? item as Record<string, unknown> : {}
    const intelligence = num(entry.intelligence)
    if (typeof entry.slug !== 'string' || typeof entry.name !== 'string' || intelligence === undefined) continue
    const model: ScoredModel = { slug: entry.slug, name: entry.name, creator: typeof entry.creator === 'string' ? entry.creator : '', intelligence }
    for (const key of ['coding', 'agentic', 'engineering', 'outputSpeed', 'priceBlended'] as const) {
      const found = num(entry[key])
      if (found !== undefined) model[key] = found
    }
    models.push(model)
  }
  const keySource = raw.keySource === 'stored' || raw.keySource === 'env' ? raw.keySource : 'none'
  return {
    models,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    keyMissing: raw.keyMissing === true,
    configured: raw.configured === true,
    canStore: raw.canStore === true,
    keySource,
    error: typeof raw.error === 'string' ? raw.error : '',
    loaded: true,
  }
}

// ---------------------------------------------------------------- matching

// Gateway ids whose spelling differs from the Artificial Analysis slug in a way the name parser cannot bridge.
const ALIASES: Record<string, string> = {
  'k3.1-pro': 'kimi-k3.1-pro',
}
// Words that make a different entry of the same model ("(Reasoning)", "(Max)", a preview build).
const VARIANT_WORDS = new Set(['preview', 'exp', 'experimental', 'thinking', 'reasoning', 'non', 'nonreasoning', 'max', 'high', 'low', 'medium', 'minimal', 'xhigh', 'adaptive', 'instruct', 'chat'])

const variantsOf = (slug: string) => new Set(slug.toLowerCase().split('-').filter((word) => VARIANT_WORDS.has(word)))
const withoutVariants = (slug: string) => slug.toLowerCase().split('-').filter((word) => !VARIANT_WORDS.has(word)).join('-')
const sameSet = (left: Set<string>, right: Set<string>) => left.size === right.size && [...left].every((item) => right.has(item))

export interface ScoreIndex {
  find(modelId: string): ScoredModel | undefined
}

/**
 * Index of the list by normalised family, tier, version and size. A gateway model gets the entry of the same
 * model whose variant words (preview, reasoning, ...) are the same as its own; an id without version or size
 * matches nothing. A doubtful model shows no score rather than another model's.
 */
export function buildScoreIndex(models: readonly ScoredModel[]): ScoreIndex {
  const byKey = new Map<string, Array<{ model: ScoredModel; variants: Set<string> }>>()
  for (const model of models) {
    const key = modelMatchKey(withoutVariants(model.slug))
    if (!key) continue
    const list = byKey.get(key) ?? []
    list.push({ model, variants: variantsOf(model.slug) })
    byKey.set(key, list)
  }
  return {
    find(modelId) {
      const bare = modelId.split('/').pop() || modelId
      const id = ALIASES[bare] ?? modelId
      const key = modelMatchKey(id)
      if (!key) return undefined
      const wanted = new Set(modelQualifiers(id).filter((word) => VARIANT_WORDS.has(word)))
      return byKey.get(key)?.find((candidate) => sameSet(candidate.variants, wanted))?.model
    },
  }
}

// ---------------------------------------------------------------- recommendations

export type Recommendation = 'agentic' | 'coding' | 'engineering' | 'reasoning' | 'fast' | 'cheap'

/**
 * Thresholds, in one place. "Top" means the best fifth of the scored models of the list (at least 5 scored
 * models are needed, or nothing is ranked). A model gets at most MAX_CHIPS, in this order:
 * agentic, coding, engineering, reasoning (the same top fifth of the Intelligence Index), fast, cheap.
 * - agentic / coding / engineering: top fifth of that index among the models that have it. Agentic and coding
 *   are only in Artificial Analysis' paid tiers today, so they appear only when the API sends them.
 * - reasoning: top fifth of the Intelligence Index.
 * - fast: at least FAST_TPS output tokens per second and in the top third for speed.
 * - cheap: blended price at most CHEAP_PRICE USD per million tokens and an Intelligence Index of at least
 *   half the best one of the list: cheap and useless is not a recommendation.
 */
export const RECOMMENDATION_RULES = { topShare: 0.2, minScored: 5, fastTps: 100, fastShare: 1 / 3, cheapPrice: 1, cheapIntelligenceShare: 0.5, maxChips: 2 } as const

export const RECOMMENDATION_ORDER: Recommendation[] = ['agentic', 'coding', 'engineering', 'reasoning', 'fast', 'cheap']

type Field = 'agentic' | 'coding' | 'engineering' | 'intelligence' | 'outputSpeed'

function threshold(values: number[], share: number) {
  if (values.length < RECOMMENDATION_RULES.minScored) return Infinity
  const sorted = [...values].sort((a, b) => b - a)
  return sorted[Math.max(0, Math.ceil(sorted.length * share) - 1)]
}

/** Chips for each scored model of `population` (distinct entries of the list that match a listed model). */
export function recommendations(population: readonly ScoredModel[]): (model: ScoredModel) => Recommendation[] {
  const rules = RECOMMENDATION_RULES
  const cut = (field: Field, share: number = rules.topShare) => threshold(population.map((model) => model[field]).filter((value): value is number => value !== undefined), share)
  const cuts = { agentic: cut('agentic'), coding: cut('coding'), engineering: cut('engineering'), intelligence: cut('intelligence'), speed: cut('outputSpeed', rules.fastShare) }
  const best = Math.max(0, ...population.map((model) => model.intelligence))
  return (model) => {
    const chips: Recommendation[] = []
    if (model.agentic !== undefined && model.agentic >= cuts.agentic) chips.push('agentic')
    if (model.coding !== undefined && model.coding >= cuts.coding) chips.push('coding')
    if (model.engineering !== undefined && model.engineering >= cuts.engineering) chips.push('engineering')
    if (model.intelligence >= cuts.intelligence) chips.push('reasoning')
    if (model.outputSpeed !== undefined && model.outputSpeed >= rules.fastTps && model.outputSpeed >= cuts.speed) chips.push('fast')
    if (model.priceBlended !== undefined && model.priceBlended <= rules.cheapPrice && model.intelligence >= best * rules.cheapIntelligenceShare) chips.push('cheap')
    return chips.slice(0, rules.maxChips)
  }
}

export interface ModelScoreInfo {
  score: ScoredModel
  chips: Recommendation[]
}

/** Score and chips of every listed model that has a match, by `provider:model` key. */
export function scoreModels(options: readonly ModelOption[], state: ScoresState): Map<string, ModelScoreInfo> {
  const result = new Map<string, ModelScoreInfo>()
  if (state.models.length === 0) return result
  const index = buildScoreIndex(state.models)
  const matched = options.map((option) => ({ option, score: index.find(option.model) }))
  const population = [...new Map(matched.filter((item) => item.score).map((item) => [item.score!.slug, item.score!])).values()]
  const chipsFor = recommendations(population)
  for (const { option, score } of matched) if (score) result.set(`${option.provider}:${option.model}`, { score, chips: chipsFor(score) })
  return result
}

// ---------------------------------------------------------------- store

let current: ScoresState = EMPTY_SCORES
let loading: Promise<ScoresState> | null = null
const listeners = new Set<() => void>()

function publish(next: ScoresState) {
  current = next
  listeners.forEach((listener) => listener())
}

export const getScores = () => current

/** Reads the list once per window (the server caches it for a day). Without a server, nothing is shown. */
export function ensureScores(force = false) {
  if (!loading || force) {
    loading = (async () => {
      try {
        const response = await fetch('/api/model-scores', { credentials: 'same-origin' })
        if (response.ok) publish(parseScores(await response.json()))
        else publish({ ...current, loaded: true })
      } catch {
        publish({ ...current, loaded: true })
      }
      return current
    })()
  }
  return loading
}

export type KeyResult = 'ok' | 'invalid' | 'unavailable' | 'failed'

/** The key goes once to the server, which stores it encrypted and never sends it back. */
export async function saveScoreKey(key: string): Promise<KeyResult> {
  try {
    const response = await fetch('/api/model-scores/key', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) })
    if (response.status === 400) return 'invalid'
    if (response.status === 501) return 'unavailable'
    if (!response.ok) return 'failed'
  } catch {
    return 'failed'
  }
  await ensureScores(true)
  return 'ok'
}

export async function removeScoreKey(): Promise<KeyResult> {
  try {
    const response = await fetch('/api/model-scores/key', { method: 'DELETE', credentials: 'same-origin' })
    if (!response.ok) return 'failed'
  } catch {
    return 'failed'
  }
  await ensureScores(true)
  return 'ok'
}

export function useScores() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, getScores)
}

/** For tests. */
export function resetScores() {
  current = EMPTY_SCORES
  loading = null
  listeners.forEach((listener) => listener())
}
