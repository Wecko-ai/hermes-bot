import type { BackgroundWork, Bot, BotStatus } from '../types'
import { HermesRpcError, type ActiveChat, type HermesClient } from './hermes'
import { parseSubagentList, type SubagentSnapshot } from './subagents'
import { i18n } from '../i18n'

type Json = Record<string, unknown>
const asObject = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {})
const count = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0)

/** A turn, a question or an approval wins: “standing by” is only for a bot with no turn. */
const TURN_STATUSES = new Set<BotStatus>(['working', 'thinking', 'waiting', 'blocked'])

export const hasBackground = (work: BackgroundWork | undefined): work is BackgroundWork =>
  Boolean(work && (work.subagents > 0 || work.processes > 0))

/** What the roster, the avatar and the chat header show: the turn first, then the work left running. */
export function effectiveStatus(bot: Pick<Bot, 'status' | 'background'>): BotStatus {
  if (TURN_STATUSES.has(bot.status)) return bot.status
  if (hasBackground(bot.background)) return 'standby'
  return bot.status === 'standby' ? 'idle' : bot.status
}

/**
 * The larger count, field by field. The roster read covers every conversation of the profile; the open chat’s
 * reads and events are fresher for that one conversation.
 */
export function mergeBackground(a: BackgroundWork | undefined, b: BackgroundWork | undefined): BackgroundWork | undefined {
  if (!a) return b
  if (!b) return a
  return { subagents: Math.max(a.subagents, b.subagents), processes: Math.max(a.processes, b.processes) }
}

export const sameBackground = (a: BackgroundWork | undefined, b: BackgroundWork | undefined) =>
  (a?.subagents ?? 0) === (b?.subagents ?? 0) && (a?.processes ?? 0) === (b?.processes ?? 0)

/** “2 subagents · 1 background process”: the hover text of a bot standing by. */
export function backgroundSummary(work: BackgroundWork | undefined) {
  if (!hasBackground(work)) return ''
  return [
    work.subagents ? i18n.t('background.subagents', { count: work.subagents }) : '',
    work.processes ? i18n.t('background.processes', { count: work.processes }) : '',
  ].filter(Boolean).join(' · ')
}

// A gateway that does not know a method answers -32601 (`unknown_method`): it is not asked again on this socket.
// A new socket may reach an updated gateway, so the list starts over with each connection.
const unsupported = new WeakMap<object, { generation: number | undefined; methods: Set<string> }>()

function methodsRefused(client: HermesClient) {
  let entry = unsupported.get(client)
  if (!entry || entry.generation !== client.generation) {
    entry = { generation: client.generation, methods: new Set() }
    unsupported.set(client, entry)
  }
  return entry.methods
}

function remember(client: HermesClient, method: string, error: unknown) {
  if (error instanceof HermesRpcError && (error.code === -32601 || error.data.reason === 'unknown_method')) methodsRefused(client).add(method)
}

export interface BackgroundRead {
  counts: Map<string, BackgroundWork>
  /** Profiles that answered: for the others, the last known counts stand. */
  answered: Set<string>
}

/**
 * Subagents and background processes still running, profile by profile. `subagent.roster` needs no attached
 * session and answers per stored conversation of the profile; the gateway only counts top-level children and
 * processes that have not exited. One cheap read per profile: the gateway answers at once when nothing runs.
 */
export async function loadBackgroundWork(client: HermesClient, profiles: string[]): Promise<BackgroundRead> {
  const counts = new Map<string, BackgroundWork>()
  const answered = new Set<string>()
  if (methodsRefused(client).has('subagent.roster')) return { counts, answered }
  await Promise.all(profiles.map(async (profile) => {
    try {
      const result = asObject(await client.request('subagent.roster', { profile }, 10_000))
      const total: BackgroundWork = { subagents: 0, processes: 0 }
      for (const value of Array.isArray(result.sessions) ? result.sessions : []) {
        const row = asObject(value)
        total.subagents += count(row.subagents)
        total.processes += count(row.background)
      }
      counts.set(profile, total)
      answered.add(profile)
    } catch (error) {
      // Older gateway, profile not served or outage: the roster keeps what it knew.
      remember(client, 'subagent.roster', error)
    }
  }))
  return { counts, answered }
}

/** `process.list` rows still running. A row without a status is running (the gateway’s default). */
export function runningProcesses(result: unknown) {
  const rows = asObject(result).processes
  if (!Array.isArray(rows)) return 0
  return rows.filter((row) => {
    const status = asObject(row).status
    return status === undefined || status === 'running'
  }).length
}

export interface ChatBackground {
  /** Background processes of this conversation still running; `undefined` when the read failed. */
  processes?: number
  /** Live children of this conversation; `undefined` when the read failed. */
  subagents?: SubagentSnapshot[]
}

/**
 * The open conversation’s own work. Both reads need the live session `session.resume` attached: a session the
 * gateway does not hold answers `not_found`. The gateway refuses any parameter other than these two.
 */
export async function loadChatBackground(client: HermesClient, chat: Pick<ActiveChat, 'profile' | 'sessionId'>): Promise<ChatBackground> {
  const params = { profile: chat.profile, session_id: chat.sessionId }
  const read = async <T,>(method: string, parse: (value: unknown) => T): Promise<T | undefined> => {
    if (methodsRefused(client).has(method)) return undefined
    try {
      return parse(await client.request(method, params, 10_000))
    } catch (error) {
      remember(client, method, error)
      return undefined
    }
  }
  const [processes, subagents] = await Promise.all([read('process.list', runningProcesses), read('subagent.list', parseSubagentList)])
  return { processes, subagents }
}

export interface SubagentTail {
  /** `false` while the child has no live transcript yet, or once it is gone. */
  available: boolean
  text: string
  truncated: boolean
}

/** The last 16 KB of a child’s live transcript, read on demand. Read only: nothing is sent to the child. */
export async function loadSubagentTail(client: HermesClient, chat: Pick<ActiveChat, 'profile' | 'sessionId'>, subagentId: string): Promise<SubagentTail> {
  const result = asObject(await client.request('subagent.tail', { profile: chat.profile, session_id: chat.sessionId, subagent_id: subagentId }, 10_000))
  return {
    available: result.available === true,
    text: typeof result.text === 'string' ? result.text : '',
    truncated: result.truncated === true,
  }
}
