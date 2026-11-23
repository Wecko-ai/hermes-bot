import type { ModelOption, SessionUsage } from '../types'
import type { ActiveChat, HermesClient } from './hermes'
import { switchModel } from './hermes'
import { rpcReason } from './gateway-errors'
import type { AutoMode, AutoRouteBadge, AutoRouteDecision } from './auto-router'
import { decideAutoRoute } from './auto-router'

function lower(value: string) {
  return value.toLowerCase()
}

export function isRetryableProviderError(error: unknown) {
  const reason = rpcReason(error).toLowerCase()
  if (reason.includes('rate') || reason.includes('429') || reason.includes('quota') || reason.includes('provider')) return true
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  return message.includes('429') || message.includes('rate limit')
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
  return haystack.includes('429')
    || haystack.includes('rate')
    || haystack.includes('quota')
    || haystack.includes('provider')
}

export function turnFallbackError(payload: Record<string, unknown>, error?: unknown) {
  const fromPayload = errorBits(payload.error)
  if (lower(fromPayload).includes('429') || lower(fromPayload).includes('rate')) return '429'
  if (fromPayload) return `error:${fromPayload.slice(0, 48)}`
  const reason = rpcReason(error)
  if (reason.includes('429') || lower(reason).includes('rate')) return '429'
  return `error:${reason.slice(0, 48) || 'provider'}`
}

export interface RoutedTurnPlan {
  mode: AutoMode
  badge: AutoRouteBadge
  option: ModelOption
  decision: AutoRouteDecision
  fallbackQueue: ModelOption[]
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
      reason: decision.reason || 'Auto',
    },
  }
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