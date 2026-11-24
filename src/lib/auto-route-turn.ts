import type { ModelOption, SessionUsage } from '../types'
import type { ActiveChat, HermesClient } from './hermes'
import { loadModelOptions, switchModel } from './hermes'
import { rpcReason } from './gateway-errors'
import { decideAutoRoute, fallbackLabel, quotaErrorHint, type AutoMode, type AutoRouteBadge, type AutoRouteDecision, type QuotaErrorHint } from './auto-router'

/** How long a send waits for an empty model catalog before Auto gives up and stays on the session model. */
export const AUTO_CATALOG_WAIT_MS = 5_000

function lower(value: string) {
  return value.toLowerCase()
}

function matchesRetryableProviderText(haystack: string) {
  return haystack.includes('429')
    || haystack.includes('402')
    || haystack.includes('410')
    || haystack.includes('rate')
    || haystack.includes('quota')
    || haystack.includes('provider')
    || haystack.includes('resource limit')
    || haystack.includes('usage limit')
    || haystack.includes('payment')
    || haystack.includes('budget')
    || haystack.includes('end of life')
    || haystack.includes('no longer available')
    || haystack.includes('fallback chain')
}

export function isRetryableProviderError(error: unknown) {
  const reason = rpcReason(error).toLowerCase()
  if (matchesRetryableProviderText(reason)) return true
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  return matchesRetryableProviderText(message)
}

export function providerErrorText(payload: Record<string, unknown>) {
  return [errorBits(payload.error), typeof payload.text === 'string' ? payload.text : ''].filter(Boolean).join(' ').slice(0, 300)
}

function errorBits(value: unknown) {
  if (!value || typeof value !== 'object') return ''
  const row = value as Record<string, unknown>
  return [row.code, row.type, row.message, row.reason].filter((item) => typeof item === 'string').join(' ')
}

export function isRetryableTurnComplete(payload: Record<string, unknown>) {
  const status = typeof payload.status === 'string' ? payload.status : ''
  if (status !== 'error') return false
  const haystack = lower([errorBits(payload.error), typeof payload.text === 'string' ? payload.text : ''].join(' '))
  return matchesRetryableProviderText(haystack)
}

export function turnFallbackError(payload: Record<string, unknown>, error?: unknown) {
  const fromPayload = errorBits(payload.error)
  if (lower(fromPayload).includes('429') || lower(fromPayload).includes('rate')) return '429'
  if (lower(fromPayload).includes('402')) return '402'
  if (lower(fromPayload).includes('410') || lower(fromPayload).includes('end of life')) return '410'
  if (fromPayload) return `error:${fromPayload.slice(0, 48)}`
  const reason = rpcReason(error)
  if (reason.includes('429') || lower(reason).includes('rate')) return '429'
  if (reason.includes('402')) return '402'
  if (reason.includes('410')) return '410'
  return `error:${reason.slice(0, 48) || 'provider'}`
}

export interface RoutedTurnPlan {
  mode: AutoMode
  badge: AutoRouteBadge
  option: ModelOption
  decision: AutoRouteDecision
  fallbackQueue: ModelOption[]
  /** Auto could not choose. The turn was not switched; it stays on the session model. */
  fellBack?: boolean
}

export interface AutoTurnTrack {
  plan: RoutedTurnPlan
  startedAt: number
  userMessageId: string
  fallbacks: { model: string; error: string }[]
  fallbackQueue: ModelOption[]
  prompt: string
  images: { path: string; mime: string }[]
  apiText?: string
  chat: ActiveChat
  toolsRan: boolean
  resubmitting: boolean
  quotaErrors?: QuotaErrorHint[]
}

export async function planAutoRoutedTurn(_client: HermesClient, input: {
  chat: ActiveChat
  text: string
  imageCount: number
  usage: SessionUsage | null
  modelOptions: ModelOption[]
  analyticsProfiles?: string[]
  mode?: AutoMode
}): Promise<RoutedTurnPlan> {
  const mode: AutoMode = input.mode ?? 'auto'
  const decision = await decideAutoRoute({
    bot: input.chat.profile,
    sessionId: input.chat.sessionId,
    text: input.text,
    imageCount: input.imageCount,
    contextUsed: input.usage?.contextUsed,
    contextMax: input.usage?.contextMax,
    currentModel: input.chat.model,
    models: input.modelOptions,
    analyticsProfiles: input.analyticsProfiles,
    mode,
  })
  if (!decision.ok || !decision.chosen || !decision.provider || !decision.model) {
    throw new Error(decision.error || 'auto_route_failed')
  }
  const option: ModelOption = { provider: decision.provider, model: decision.model, providerName: decision.provider }
  const fallbackQueue = (decision.fallbacks || []).slice(0, 2).map((row) => ({ provider: row.provider, model: row.model, providerName: row.provider }))
  return {
    mode,
    option,
    decision,
    fallbackQueue,
    badge: {
      mode,
      category: decision.category || 'other',
      chosen: decision.chosen,
      ...(decision.label ? { label: decision.label } : {}),
      reason: decision.reason || 'Auto',
    },
  }
}

function routeFailureReason(error: unknown) {
  const text = error instanceof Error ? error.message : 'auto_route_failed'
  return text.replace(/\s+/g, ' ').trim().slice(0, 160) || 'auto_route_failed'
}

/** The session's current model, as a picker row when the catalog names it. */
export function sessionModelOption(chat: ActiveChat, models: ModelOption[]): ModelOption {
  const model = chat.model?.trim() || ''
  const match = models.find((option) => option.model === model)
  if (match) return match
  return { provider: '', model, providerName: '' }
}

/**
 * Auto could not pick (empty catalog, exhausted providers, router error).
 * The plan names the session model and does not switch.
 */
export function stayedOnSessionPlan(mode: AutoMode, chat: ActiveChat, models: ModelOption[], error: unknown): RoutedTurnPlan {
  const option = sessionModelOption(chat, models)
  const reason = routeFailureReason(error)
  const chosen = option.provider && option.model ? `${option.provider}/${option.model}` : (option.model || 'session')
  return {
    mode,
    option,
    decision: { ok: false, error: reason, mode },
    fallbackQueue: [],
    fellBack: true,
    badge: {
      mode,
      category: 'fallback',
      chosen,
      ...(option.providerName ? { label: option.model } : {}),
      reason,
      fellBack: true,
    },
  }
}

/** Resolves with the catalog, or with `[]` when the load fails or exceeds [waitMs]. The load itself is not cancelled. */
export async function waitForModelCatalog(load: () => Promise<ModelOption[]>, waitMs = AUTO_CATALOG_WAIT_MS): Promise<ModelOption[]> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      load().catch(() => [] as ModelOption[]),
      new Promise<ModelOption[]>((resolve) => {
        timer = setTimeout(() => resolve([]), waitMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Plan an Auto turn and switch the session onto the chosen model.
 * An empty catalog is loaded first, for at most [catalogWaitMs].
 * When Auto still cannot pick, the turn stays on the session model and the plan is marked `fellBack`.
 * The caller stamps `plan.badge` on the user message.
 * Compacts when no window can hold the conversation with room to work.
 */
export async function beginAutoRoutedTurn(input: {
  client: HermesClient
  chat: ActiveChat
  text: string
  imageCount: number
  usage: SessionUsage | null
  modelOptions: ModelOption[]
  /** Used when [modelOptions] is empty. Failures and the wait bound become a fallback, not a failed send. */
  loadModels?: () => Promise<ModelOption[]>
  catalogWaitMs?: number
  onModelsLoaded?: (models: ModelOption[]) => void
  analyticsProfiles?: string[]
  mode: AutoMode
  onPlanned?: (plan: RoutedTurnPlan) => void
  onModelApplied: (chat: ActiveChat) => void
  compactIfNeeded?: (chat: ActiveChat) => Promise<unknown>
}): Promise<{ chat: ActiveChat; plan: RoutedTurnPlan }> {
  let models = input.modelOptions
  if (models.length === 0) {
    const load = input.loadModels ?? (() => loadModelOptions(input.client, input.chat.profile, input.chat.sessionId).then((result) => result.options))
    models = await waitForModelCatalog(load, input.catalogWaitMs ?? AUTO_CATALOG_WAIT_MS)
    if (models.length) input.onModelsLoaded?.(models)
  }
  let plan: RoutedTurnPlan
  if (models.length === 0) {
    plan = stayedOnSessionPlan(input.mode, input.chat, models, new Error('catalog_unavailable'))
  } else {
    try {
      plan = await planAutoRoutedTurn(input.client, {
        chat: input.chat,
        text: input.text,
        imageCount: input.imageCount,
        usage: input.usage,
        modelOptions: models,
        analyticsProfiles: input.analyticsProfiles,
        mode: input.mode,
      })
    } catch (error) {
      plan = stayedOnSessionPlan(input.mode, input.chat, models, error)
    }
  }
  input.onPlanned?.(plan)
  const alreadyThere = Boolean(plan.option.model) && plan.option.model === input.chat.model
  if (plan.fellBack || alreadyThere) {
    if (!plan.fellBack && plan.decision.needsCompaction && input.compactIfNeeded) await input.compactIfNeeded(input.chat)
    return { chat: input.chat, plan }
  }
  try {
    const applied = await applyRoutedModel(input.client, input.chat, plan.option)
    input.onModelApplied(applied.chat)
    if (plan.decision.needsCompaction && input.compactIfNeeded) await input.compactIfNeeded(applied.chat)
    return { chat: applied.chat, plan }
  } catch (error) {
    const stayed = stayedOnSessionPlan(input.mode, input.chat, models, error)
    input.onPlanned?.(stayed)
    return { chat: input.chat, plan: stayed }
  }
}

export interface AutoTurnSubmit {
  (chat: ActiveChat, prompt: string, images: { path: string; mime: string }[], options: { apiText?: string }): Promise<ActiveChat>
}

/**
 * Submit a turn the way the composer does.
 * With a plan, keep the track (badge, quota errors, fallback queue) and resubmit
 * on a retryable provider error, up to two fallbacks. Without a plan, one submit.
 * Throws after the last attempt; the caller drops the track.
 */
export async function submitAutoTurn(input: {
  client: HermesClient
  chat: ActiveChat
  plan: RoutedTurnPlan | null
  prompt: string
  apiText?: string
  images: { path: string; mime: string }[]
  userMessageId: string
  submit: AutoTurnSubmit
  onModelApplied: (chat: ActiveChat) => void
  onBadge: (badge: AutoRouteBadge) => void
  remember: (track: AutoTurnTrack) => void
}): Promise<ActiveChat> {
  let workingChat = input.chat
  const plan = input.plan
  const fallbackQueue = [...(plan?.fallbackQueue ?? [])]
  const turnFallbacks: { model: string; error: string }[] = []
  let track: AutoTurnTrack | null = null
  if (plan) {
    track = {
      plan,
      startedAt: Date.now(),
      userMessageId: input.userMessageId,
      fallbacks: turnFallbacks,
      fallbackQueue,
      prompt: input.prompt,
      images: input.images,
      apiText: input.apiText,
      chat: workingChat,
      toolsRan: false,
      resubmitting: false,
      quotaErrors: [],
    }
    input.remember(track)
  }
  let submitted = workingChat
  for (let attempt = 0; attempt <= 2; attempt += 1) {
    try {
      submitted = await input.submit(workingChat, input.prompt, input.images, { apiText: input.apiText })
      break
    } catch (error) {
      const err = error instanceof Error ? error.message : 'error'
      if (track) track.quotaErrors = [...(track.quotaErrors ?? []), quotaErrorHint(track.plan.badge.chosen, err)]
      if (attempt >= 2 || !isRetryableProviderError(error) || fallbackQueue.length === 0) throw error
      const next = fallbackQueue.shift()!
      turnFallbacks.push({ model: `${next.provider}/${next.model}`, error: err.includes('429') ? '429' : `error:${err.slice(0, 48)}` })
      const applied = await applyRoutedModel(input.client, workingChat, next)
      workingChat = applied.chat
      input.onModelApplied(workingChat)
      if (track) {
        track.plan.badge.chosen = `${next.provider}/${next.model}`
        track.plan.badge.label = fallbackLabel(track.plan.decision, next)
        track.chat = workingChat
        input.onBadge(track.plan.badge)
      }
    }
  }
  if (track) {
    track.fallbacks = turnFallbacks
    track.chat = submitted
    track.fallbackQueue = fallbackQueue
  }
  return submitted
}

export async function applyRoutedModel(client: HermesClient, chat: ActiveChat, option: ModelOption) {
  let result = await switchModel(client, chat, option)
  if (result?.confirm_required && typeof result.confirm === 'string') {
    result = await switchModel(client, chat, option, result.confirm)
  }
  return {
    chat: {
      ...chat,
      model: option.model,
      ...(typeof result?.revision === 'number' ? { revision: result.revision } : {}),
      ...(typeof result?.execution_generation === 'number' ? { executionGeneration: result.execution_generation } : {}),
    },
    deferred: result?.deferred === true,
  }
}