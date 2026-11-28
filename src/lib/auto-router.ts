import type { ModelOption } from '../types'
import { getAppConfig } from './app-config'
import { isPaidOptIn, modelCost } from './free-models'
import { getSettings } from './settings'
import { isDelegateModel } from './delegate'

/** Conversation-only choice: routing runs before each send. */
export const AUTO_MODEL_SENTINEL = 'hermesbot:auto'
/** Same routing, free models only (no subscription quota): see `isStrictlyFree` on the server. */
export const AUTO_FREE_MODEL_SENTINEL = 'hermesbot:auto-free'

export type AutoMode = 'auto' | 'auto-free'

export function isAutoModel(model: string | undefined) {
  return model === AUTO_MODEL_SENTINEL || model === AUTO_FREE_MODEL_SENTINEL
}

/** The picker value when Auto is the default and this chat has no explicit model. */
export function defaultAutoPicker(
  settings: { useAutoModel?: boolean; useAutoFreeModel?: boolean } = getSettings(),
  enabled = autoRouterEnabled(),
) {
  if (!enabled) return ''
  if (settings.useAutoFreeModel) return AUTO_FREE_MODEL_SENTINEL
  if (settings.useAutoModel) return AUTO_MODEL_SENTINEL
  return ''
}

/** Picker label when reopening a chat: Auto sticks across routed gateway models.
 *  With no remembered picker and Auto as the default, the session's gateway model is not shown. */
export function pickerModelForSession(
  pickerModel: string | undefined,
  sessionModel: string | undefined,
  settings: { useAutoModel?: boolean; useAutoFreeModel?: boolean } = getSettings(),
  enabled = autoRouterEnabled(),
) {
  if (isDelegateModel(sessionModel) && !isDelegateModel(pickerModel) && !isAutoModel(pickerModel)) return sessionModel || ''
  if (isAutoModel(pickerModel)) return pickerModel
  if (pickerModel) return sessionModel || pickerModel
  return defaultAutoPicker(settings, enabled) || sessionModel || ''
}

/** After auto routing switches the gateway session, keep the Auto picker's sentinel. */
export function pickerModelAfterRoute(currentPicker: string, routedModel: string) {
  return isAutoModel(currentPicker) ? currentPicker : (routedModel || currentPicker)
}

/** The Auto mode of a send: the picker's choice first (an explicit model wins), then the Settings default. */
export function autoModeFor(model: string | undefined, settings: { useAutoModel?: boolean; useAutoFreeModel?: boolean }): AutoMode | null {
  if (model === AUTO_FREE_MODEL_SENTINEL) return 'auto-free'
  if (model === AUTO_MODEL_SENTINEL) return 'auto'
  if (model) return null
  if (settings.useAutoFreeModel) return 'auto-free'
  if (settings.useAutoModel) return 'auto'
  return null
}

export function autoRouterEnabled() {
  return getAppConfig().autoRouter?.enabled === true
}

export interface AutoRouteDecision {
  ok: boolean
  mode?: AutoMode
  category?: string
  chosen?: string
  /** Readable name from the scoring table, e.g. « GPT-5.6 Sol (Cursor) ». */
  label?: string
  provider?: string
  model?: string
  reason?: string
  candidates?: { model: string; score: number }[]
  fallbacks?: { provider: string; model: string; fullId: string; label?: string; score: number }[]
  error?: string
  tokenEstimate?: number
  /** Window of the chosen model, from the table or the gateway. */
  contextWindow?: number
  /** No model holds the conversation with room to work: compact before the turn. */
  needsCompaction?: boolean
  excludedForContext?: string[]
  triage?: AutoTriageMeta
}

export interface AutoTriageMeta {
  source: 'rules' | 'local' | 'local-shadow' | 'local-timeout' | 'local-error'
  category: string
  rulesCategory?: string | null
  localCategory?: string | null
  confidence?: number | null
  difficulty?: 'easy' | 'medium' | 'hard' | null
  latencyMs?: number | null
  skipReason?: string | null
}

export interface AutoRouteLogEntry {
  mode?: AutoMode
  bot: string
  sessionId: string
  category: string
  chosen: string
  reason: string
  candidates: { model: string; score: number }[]
  fallbacks: { model: string; error: string }[]
  tokensIn?: number | null
  tokensOut?: number | null
  costUsd?: number | null
  latencyMs?: number | null
  outcome: 'ok' | 'error' | 'cancelled'
  triage?: AutoTriageMeta
  triageSource?: AutoTriageMeta['source']
  triageLatencyMs?: number | null
  rulesCategory?: string | null
  difficulty?: AutoTriageMeta['difficulty']
  confidence?: number | null
  /** Provider that actually failed. Not written to the routing log. */
  quotaErrors?: QuotaErrorHint[]
}

export interface QuotaErrorHint {
  provider: string
  model?: string
  status?: number | null
  message?: string
}

/** Names the model that failed, so a fallback is not charged with that error. */
export function quotaErrorHint(fullId: string, message: string): QuotaErrorHint {
  const slash = fullId.indexOf('/')
  const provider = slash > 0 ? fullId.slice(0, slash) : fullId
  const status = /\b402\b/.test(message)
    ? 402
    : /\b410\b|end of life|no longer available/i.test(message)
      ? 410
      : /\b429\b|rate limit|quota|usage limit|resource limit/i.test(message)
        ? 429
        : null
  return { provider, model: fullId, status, message: message.slice(0, 240) }
}

export interface AutoRouteBadge {
  mode?: AutoMode
  category: string
  chosen: string
  label?: string
  reason: string
  /** Auto could not choose; the turn stayed on the session's current model. */
  fellBack?: boolean
}

export const AUTO_PICKER_OPTION: ModelOption = {
  model: AUTO_MODEL_SENTINEL,
  provider: 'hermesbot',
  providerName: 'HermesBot',
}

export const AUTO_FREE_PICKER_OPTION: ModelOption = {
  model: AUTO_FREE_MODEL_SENTINEL,
  provider: 'hermesbot',
  providerName: 'HermesBot',
}

export async function decideAutoRoute(input: {
  bot: string
  sessionId: string
  text: string
  imageCount: number
  contextUsed?: number
  contextMax?: number
  /** Model the session runs on now: its window is the gateway's `contextMax`. */
  currentModel?: string
  models: ModelOption[]
  analyticsProfiles?: string[]
  mode?: AutoMode
}): Promise<AutoRouteDecision> {
  const subscriptions = getAppConfig().ui.subscriptionProviders
  const zeroSpend = getSettings().freeMode
  // Paid opt-in models are a deliberate choice: Auto never gets them as a candidate.
  const models = input.models.filter((option) => !isPaidOptIn(option)).map((option) => ({
    provider: option.provider,
    model: option.model,
    free: modelCost(option, subscriptions) !== 'paid',
  }))
  const response = await fetch('/api/auto-router/decide', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: input.mode ?? 'auto',
      bot: input.bot,
      sessionId: input.sessionId,
      text: input.text,
      imageCount: input.imageCount,
      contextUsed: input.contextUsed ?? 0,
      contextMax: input.contextMax ?? 0,
      currentModel: input.currentModel ?? '',
      models,
      zeroSpend,
      subscriptionProviders: subscriptions,
      analyticsProfiles: input.analyticsProfiles ?? [],
    }),
  })
  return response.json() as Promise<AutoRouteDecision>
}

export async function appendAutoRouteLog(entry: AutoRouteLogEntry) {
  await fetch('/api/auto-router/log', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...entry, ts: new Date().toISOString() }),
  })
}

export interface AutoRoutingLogResponse {
  entries: AutoRouteLogEntry[]
  summary: {
    total: number
    fallbacks: number
    costUsd: number
    byModel: { model: string; count: number; errors: number }[]
  }
}

export async function loadAutoRoutingLog(days = 7): Promise<AutoRoutingLogResponse> {
  const response = await fetch(`/api/auto-router/log?days=${days}`, { credentials: 'same-origin' })
  if (!response.ok) throw new Error('auto_router_log_unavailable')
  return response.json() as Promise<AutoRoutingLogResponse>
}
/** Table label of the fallback Auto switches to, so the turn's label stays readable. */
export function fallbackLabel(decision: Pick<AutoRouteDecision, 'fallbacks'> | undefined, next: { provider: string; model: string }) {
  return decision?.fallbacks?.find((row) => row.provider === next.provider && row.model === next.model)?.label
}
