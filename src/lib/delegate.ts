import type { ModelOption } from '../types'
import { HermesRpcError, type HermesClient } from './hermes'

/** Delegate: a chef model that only plans and reviews, and a local
 *  worker model (Inkling 2 Mini on Splash today, any local model in ~/.hermes/chef-worker.json) that does the
 *  tool work (plugin chef-worker).
 *
 *  Since 25/11 it is a per-chat TOGGLE in the right panel, not a model: when it is on, the model picked for the
 *  chat (Kimi, Grok, Auto's pick...) is the chef. The plugin keeps the switch (RPC `plugin.chef-worker.delegate.*`). The sentinel model id below is no longer offered: it stays recognized
 *  for crons, profile defaults and the chats that had picked it (migrated on open: toggle on + the bot's default model).
 *  The former ids (see DELEGATE_LEGACY_IDS) stay aliases. */
export const DELEGATE_MODEL_SENTINEL = 'hermesbot:delegate'
/** Former ids of the same mode, still accepted everywhere (stored chats, crons, profile defaults). */
export const DELEGATE_LEGACY_IDS = ['hermesbot:oyakata', 'hermesbot/oyakata', 'hermesbot:chef-qwen', 'hermesbot/chef-qwen'] as const
/** The chef the gateway uses for this mode (shown next to « Delegate » until a turn names another). */
export const DELEGATE_DEFAULT_CHEF = 'cursor/grok-4.7'

const DELEGATE_IDS = new Set<string>([DELEGATE_MODEL_SENTINEL, 'hermesbot/delegate', ...DELEGATE_LEGACY_IDS])

export function isDelegateModel(model: string | undefined | null) {
  return DELEGATE_IDS.has((model || '').trim().toLowerCase())
}

export const DELEGATE_GET_METHOD = 'plugin.chef-worker.delegate.get'
export const DELEGATE_SET_METHOD = 'plugin.chef-worker.delegate.set'

export type DelegateSource = 'chat' | 'bot-default' | 'off' | 'local-override' | ''

export interface DelegateState {
  /** The bot's gateway serves the toggle (plugin chef-worker 0.3+ enabled on the profile). */
  available: boolean
  enabled: boolean
  /** Where the current state came from: explicit chat switch, bot default, local override or off. */
  source?: DelegateSource
  /** Why Delegate is on or off (e.g. 'explicit', 'default', 'local_model', 'chef_refused', 'not_listed', 'off'). */
  reason?: string
  /** Turn model evaluated by the plugin. */
  turnModel?: string
  /** True when the evaluated turn model already runs locally (Delegate forced off). */
  turnIsLocal?: boolean
  /** Cached worker health probe (null when not reported by an older plugin). */
  workerUp?: boolean | null
  workerError?: string
  workerContextMax?: number
  /** The worker named in chef-worker.json. */
  workerLabel: string
  /** Chef used when the chat's model cannot be one (Composer, Gemini, the worker itself). */
  defaultChef: string
}

export const DELEGATE_UNAVAILABLE: DelegateState = {
  available: false,
  enabled: false,
  source: '',
  reason: '',
  turnModel: '',
  turnIsLocal: false,
  workerUp: null,
  workerError: '',
  workerContextMax: 0,
  workerLabel: '',
  defaultChef: DELEGATE_DEFAULT_CHEF,
}

const asObject = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {})
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

export function parseDelegateState(value: unknown): DelegateState {
  const data = asObject(value)
  const worker = asObject(data.worker)
  const botDefault = asObject(data.bot_default)
  const rawSource = text(data.source)
  const source: DelegateSource = rawSource === 'chat' || rawSource === 'bot-default' || rawSource === 'off' || rawSource === 'local-override' ? rawSource : ''
  const reason = text(data.reason) || text(botDefault.reason)
  const turnIsLocal = data.turn_is_local === true || reason === 'local_model'
  return {
    available: true,
    enabled: turnIsLocal ? false : data.enabled === true,
    source,
    reason,
    turnModel: text(data.turn_model),
    turnIsLocal,
    workerUp: typeof data.worker_up === 'boolean' ? data.worker_up : null,
    workerError: text(data.worker_error),
    workerContextMax: num(worker.context_max),
    workerLabel: text(worker.label) || text(worker.model),
    defaultChef: text(data.default_chef) || DELEGATE_DEFAULT_CHEF,
  }
}

function unavailable(error: unknown) {
  return error instanceof HermesRpcError && (error.code === -32601 || error.code === 4000
    || error.data.reason === 'unknown_method' || error.data.reason === 'not_found')
}

export type DelegateTarget = { profile: string; sessionId: string; model?: string; provider?: string; baseUrl?: string }

function targetParams(target: DelegateTarget) {
  return {
    profile: target.profile,
    session_id: target.sessionId,
    ...(target.model ? { model: target.model } : {}),
    ...(target.provider ? { provider: target.provider } : {}),
    ...(target.baseUrl ? { base_url: target.baseUrl } : {}),
  }
}

/** The toggle of one conversation. A gateway or profile without the plugin answers `DELEGATE_UNAVAILABLE`. */
export async function loadDelegate(client: HermesClient, target: DelegateTarget): Promise<DelegateState> {
  try {
    return parseDelegateState(await client.request(DELEGATE_GET_METHOD, targetParams(target), 15_000))
  } catch (error) {
    if (unavailable(error)) return DELEGATE_UNAVAILABLE
    throw error
  }
}

export async function setDelegate(client: HermesClient, target: DelegateTarget, enabled: boolean): Promise<DelegateState> {
  return parseDelegateState(await client.request(DELEGATE_SET_METHOD, { ...targetParams(target), enabled }, 15_000))
}

/** The model a chat that had picked the old Delegate / Delegate « model » goes back to: the bot's own default. */
export function delegateMigrationTarget(bot: { model: string; provider?: string }): ModelOption | null {
  const model = (bot.model || '').trim()
  if (!model || isDelegateModel(model)) return null
  return { model, provider: (bot.provider || '').trim(), providerName: '' }
}

/** « Delegate · Grok 4.7 · Cursor »: the mode, then the chef model that answers (or the default chef). */
export function delegateChip(label: string, chefModelLabel: string) {
  return chefModelLabel ? `${label} · ${chefModelLabel}` : label
}
