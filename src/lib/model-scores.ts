import { useSyncExternalStore } from 'react'
import type { ModelOption } from '../types'
import { modelMatchKey, modelQualifiers } from './model-names'

/** One model of the LLM Stats list, as the local server serves it (`/api/model-scores`). */
export interface ScoredModel {
  slug: string
  name: string
  creator: string
  /** LLM Stats general conservative rating. */
  intelligence: number
  /** LLM Stats coding, code or frontend_development category score. */
  coding?: number
  /** LLM Stats agents or tool_calling category score. */
  agentic?: number
}

export interface ScoreQuota {
  limit: number | null
  remaining: number | null
  used: number | null
}

export interface ScoresState {
  models: ScoredModel[]
  updatedAt: string
  /** The server has no LLM Stats key. Cached or snapshot data can still be shown. */
  keyMissing: boolean
  configured: boolean
  keySource: 'env' | 'command' | 'keychain' | 'none'
  quota: ScoreQuota | null
  /** Short code of the last failed refresh, when the list shown is stale. */
  error: string
  loaded: boolean
}

export const EMPTY_SCORES: ScoresState = { models: [], updatedAt: '', keyMissing: false, configured: false, keySource: 'none', quota: null, error: '', loaded: false }

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

export function parseScores(value: unknown): ScoresState {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const models: ScoredModel[] = []
  for (const item of Array.isArray(raw.models) ? raw.models : []) {
    const entry = item && typeof item === 'object' ? item as Record<string, unknown> : {}
    const intelligence = num(entry.intelligence)
    if (typeof entry.slug !== 'string' || typeof entry.name !== 'string' || intelligence === undefined) continue
    const model: ScoredModel = { slug: entry.slug, name: entry.name, creator: typeof entry.creator === 'string' ? entry.creator : '', intelligence }
    for (const key of ['coding', 'agentic'] as const) {
      const found = num(entry[key])
      if (found !== undefined) model[key] = found
    }
    models.push(model)
  }
  const keySource = raw.keySource === 'keychain' || raw.keySource === 'command' || raw.keySource === 'env' ? raw.keySource : 'none'
  const rawQuota = raw.quota && typeof raw.quota === 'object' ? raw.quota as Record<string, unknown> : null
  const quota = rawQuota ? {
    limit: num(rawQuota.limit) ?? null,
    remaining: num(rawQuota.remaining) ?? null,
    used: num(rawQuota.used) ?? null,
  } : null
  return {
    models,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    keyMissing: raw.keyMissing === true,
    configured: raw.configured === true,
    keySource,
    quota,
    error: typeof raw.error === 'string' ? raw.error : '',
    loaded: true,
  }
}

// ---------------------------------------------------------------- matching

// Gateway ids whose spelling differs from the LLM Stats slug in a way the name parser cannot bridge.
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

export type Recommendation = 'agentic' | 'coding' | 'reasoning'

/**
 * "Top" means the best fifth of the scored models of the list (at least 5 scored models are needed).
 * A model gets at most MAX_CHIPS, in this order: agentic, coding, reasoning (the top fifth of the general score).
 * No speed or price recommendation is inferred: LLM Stats does not supply those fields here.
 */
export const RECOMMENDATION_RULES = { topShare: 0.2, minScored: 5, maxChips: 2 } as const

export const RECOMMENDATION_ORDER: Recommendation[] = ['agentic', 'coding', 'reasoning']

type Field = 'agentic' | 'coding' | 'intelligence'

function threshold(values: number[], share: number) {
  if (values.length < RECOMMENDATION_RULES.minScored) return Infinity
  const sorted = [...values].sort((a, b) => b - a)
  return sorted[Math.max(0, Math.ceil(sorted.length * share) - 1)]
}

/** Chips for each scored model of `population` (distinct entries of the list that match a listed model). */
export function recommendations(population: readonly ScoredModel[]): (model: ScoredModel) => Recommendation[] {
  const rules = RECOMMENDATION_RULES
  const cut = (field: Field, share: number = rules.topShare) => threshold(population.map((model) => model[field]).filter((value): value is number => value !== undefined), share)
  const cuts = { agentic: cut('agentic'), coding: cut('coding'), intelligence: cut('intelligence') }
  return (model) => {
    const chips: Recommendation[] = []
    if (model.agentic !== undefined && model.agentic >= cuts.agentic) chips.push('agentic')
    if (model.coding !== undefined && model.coding >= cuts.coding) chips.push('coding')
    if (model.intelligence >= cuts.intelligence) chips.push('reasoning')
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

export function useScores() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, getScores)
}

/** For tests. */
export function resetScores() {
  current = EMPTY_SCORES
  loading = null
  listeners.forEach((listener) => listener())
}
