import type { ModelOption } from '../types'
import { HermesRpcError, type HermesClient } from './hermes'

/** Delegate (formerly « Oyakata », formerly « Chef Qwen »): a chef model that only plans and reviews, and a local
 *  worker model (Inkling 2 Mini on Splash today, any local model in ~/.hermes/chef-worker.json) that does the
 *  tool work (plugin chef-worker).
 *
 *  Since 25/11 it is a per-chat TOGGLE in the right panel, not a model: when it is on, the model picked for the
 *  chat (Kimi, Grok, Auto's pick...) is the chef. The plugin keeps the switch (RPC `plugin.chef-worker.oyakata.*`,
 *  aliases `plugin.chef-worker.delegate.*`). The sentinel model id below is no longer offered: it stays recognized
 *  for crons, profile defaults and the chats that had picked it (migrated on open: toggle on + the bot's default model).
 *  `hermesbot:chef-qwen` stays an alias. */
export const OYAKATA_MODEL_SENTINEL = 'hermesbot:oyakata'
/** Legacy ids of the same mode (« Chef Qwen »), still accepted everywhere. */
export const OYAKATA_LEGACY_IDS = ['hermesbot:chef-qwen', 'hermesbot/chef-qwen'] as const
/** The chef the gateway uses for this mode (shown next to « Delegate » until a turn names another). */
export const OYAKATA_DEFAULT_CHEF = 'cursor/grok-4.7'

const OYAKATA_IDS = new Set<string>([OYAKATA_MODEL_SENTINEL, 'hermesbot/oyakata', ...OYAKATA_LEGACY_IDS])

export function isOyakataModel(model: string | undefined | null) {
  return OYAKATA_IDS.has((model || '').trim().toLowerCase())
}

export const OYAKATA_GET_METHOD = 'plugin.chef-worker.oyakata.get'
export const OYAKATA_SET_METHOD = 'plugin.chef-worker.oyakata.set'

export interface OyakataState {
  /** The bot's gateway serves the toggle (plugin chef-worker 0.3+ enabled on the profile). */
  available: boolean
  enabled: boolean
  /** « Inkling 2 Mini Splash »: the worker named in chef-worker.json. */
  workerLabel: string
  /** Chef used when the chat's model cannot be one (Composer, Gemini, the worker itself). */
  defaultChef: string
}

export const OYAKATA_UNAVAILABLE: OyakataState = { available: false, enabled: false, workerLabel: '', defaultChef: OYAKATA_DEFAULT_CHEF }

const asObject = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {})
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

export function parseOyakataState(value: unknown): OyakataState {
  const data = asObject(value)
  const worker = asObject(data.worker)
  return {
    available: true,
    enabled: data.enabled === true,
    workerLabel: text(worker.label) || text(worker.model),
    defaultChef: text(data.default_chef) || OYAKATA_DEFAULT_CHEF,
  }
}

function unavailable(error: unknown) {
  return error instanceof HermesRpcError && (error.code === -32601 || error.code === 4000
    || error.data.reason === 'unknown_method' || error.data.reason === 'not_found')
}

type Target = { profile: string; sessionId: string }

/** The toggle of one conversation. A gateway or profile without the plugin answers `OYAKATA_UNAVAILABLE`. */
export async function loadOyakata(client: HermesClient, target: Target): Promise<OyakataState> {
  try {
    return parseOyakataState(await client.request(OYAKATA_GET_METHOD, { profile: target.profile, session_id: target.sessionId }, 15_000))
  } catch (error) {
    if (unavailable(error)) return OYAKATA_UNAVAILABLE
    throw error
  }
}

export async function setOyakata(client: HermesClient, target: Target, enabled: boolean): Promise<OyakataState> {
  return parseOyakataState(await client.request(OYAKATA_SET_METHOD, { profile: target.profile, session_id: target.sessionId, enabled }, 15_000))
}

/** The model a chat that had picked the old Delegate / Oyakata « model » goes back to: the bot's own default. */
export function oyakataMigrationTarget(bot: { model: string; provider?: string }): ModelOption | null {
  const model = (bot.model || '').trim()
  if (!model || isOyakataModel(model)) return null
  return { model, provider: (bot.provider || '').trim(), providerName: '' }
}

/** « Delegate · Grok 4.7 · Cursor »: the mode, then the chef model that answers (or the default chef). */
export function oyakataChip(label: string, chefModelLabel: string) {
  return chefModelLabel ? `${label} · ${chefModelLabel}` : label
}
