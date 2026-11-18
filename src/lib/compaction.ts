import type { SessionUsage } from '../types'
import { parseUsage } from './hermes'

/**
 * Context compaction setting. `auto`: Hermes decides with each profile's own settings. `manual`: the user's
 * gauge (a share of the model's window) is the limit; Hermes keeps only a safety net near the window's end,
 * and the app warns at 90 % of the gauge and blocks sending at 100 %.
 */
export type CompactionMode = 'auto' | 'manual'

export const GAUGE_MIN = 0.1
export const GAUGE_MAX = 1
export const GAUGE_STEP = 0.05
/** The warning shows from this share of the user's limit. */
export const WARN_RATIO = 0.9

export const clampGauge = (value: number) => {
  if (!Number.isFinite(value)) return GAUGE_MAX
  return Math.round(Math.min(GAUGE_MAX, Math.max(GAUGE_MIN, value)) * 100) / 100
}

export const limitTokens = (contextMax: number, gauge: number) => Math.round(contextMax * clampGauge(gauge))

export type GuardLevel = 'off' | 'ok' | 'warn' | 'full'

export interface Guard {
  level: GuardLevel
  /** Tokens in the context, and the user's limit in tokens (0 when unknown). */
  used: number
  limit: number
  /** `used` as a share of `limit`, in percent, rounded. */
  percent: number
}

const OFF: Guard = { level: 'off', used: 0, limit: 0, percent: 0 }

/** Where the open chat stands against the user's gauge. Auto mode, or no numbers yet: nothing to guard. */
export function evaluateGuard(mode: CompactionMode, gauge: number, usage: Pick<SessionUsage, 'contextUsed' | 'contextMax'> | null): Guard {
  if (mode !== 'manual' || !usage || !usage.contextMax || usage.contextMax <= 0) return OFF
  const limit = limitTokens(usage.contextMax, gauge)
  if (limit <= 0) return OFF
  const ratio = usage.contextUsed / limit
  const level: GuardLevel = ratio >= 1 ? 'full' : ratio >= WARN_RATIO ? 'warn' : 'ok'
  return { level, used: usage.contextUsed, limit, percent: Math.round(ratio * 100) }
}

/** "Later" on the warning: hidden for this conversation until its next compaction (the count moves) or until the limit. */
export interface Snooze {
  chat: string
  compressions: number
}

export const snoozeFor = (chat: string, compressions: number | undefined): Snooze => ({ chat, compressions: compressions ?? 0 })

/** The warning is shown at 90 % unless snoozed; the blocking panel at 100 % is never snoozed. */
export function showsWarning(guard: Guard, snooze: Snooze | null, chat: string, compressions: number | undefined) {
  if (guard.level !== 'warn') return false
  return !(snooze && snooze.chat === chat && snooze.compressions === (compressions ?? 0))
}

export const blocksSending = (guard: Guard) => guard.level === 'full'

/** Tokens named in Hermes's live notice ("Preflight compression: ~61,760 tokens >= 60,000 threshold…"). */
export function compactingTokens(text: unknown): number | null {
  if (typeof text !== 'string') return null
  const match = /~\s*([\d][\d,._\s]*)\s*tok/i.exec(text)
  if (!match) return null
  const value = Number(match[1].replace(/[^\d]/g, ''))
  return Number.isFinite(value) && value > 0 ? value : null
}

export interface CompactResult {
  status: 'compressed' | 'aborted' | 'busy' | 'failed'
  before: number
  after: number
  usage: SessionUsage | null
  message?: string
}

/** The answer of `session.compress`, read defensively: the numbers are Hermes's own estimates. */
export function parseCompressResult(value: unknown): CompactResult {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const number = (field: unknown) => (typeof field === 'number' && Number.isFinite(field) ? field : 0)
  if (row.compressed === false || row.lock_held === true) {
    return { status: 'failed', before: 0, after: 0, usage: null, message: typeof row.message === 'string' ? row.message : undefined }
  }
  const before = number(row.before_tokens)
  const after = number(row.after_tokens)
  const usage = parseUsage(row.usage)
  // The estimate after the cut is the best number there is until the next turn reports the real one.
  const merged = usage && after > 0 && !usage.contextUsed ? { ...usage, contextUsed: after } : usage
  return { status: row.status === 'aborted' ? 'aborted' : 'compressed', before, after, usage: merged }
}

// ── Gateway side: the server's /api/compaction route, which writes the two compression keys of each profile ──

export interface CompressionValues { threshold: number | null; threshold_tokens: number | null }

export interface CompactionSettingsCopy { mode: CompactionMode; gauge: number }

export interface SaveResult { ok: boolean; applied: string[]; failed: string[]; error?: string }

const ROUTE = '/api/compaction'

export const settingsFromBody = (value: unknown): CompactionSettingsCopy | null => {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : null
  if (!row) return null
  return { mode: row.mode === 'manual' ? 'manual' : 'auto', gauge: clampGauge(typeof row.gauge === 'number' ? row.gauge : GAUGE_MAX) }
}

/** What each of these bots has saved (null: not set, Hermes's default applies), and the shared setting. */
export async function readCompaction(profiles: string[]): Promise<{ exists: boolean; settings: CompactionSettingsCopy; profiles: Record<string, CompressionValues> } | null> {
  try {
    const response = await fetch(`${ROUTE}?${new URLSearchParams({ profiles: profiles.join(',') })}`, { credentials: 'same-origin', cache: 'no-store' })
    if (!response.ok) return null
    const body = await response.json() as { exists?: boolean; settings?: unknown; profiles?: Record<string, CompressionValues> }
    return { exists: body.exists === true, settings: settingsFromBody(body.settings) ?? { mode: 'auto', gauge: GAUGE_MAX }, profiles: body.profiles ?? {} }
  } catch {
    return null
  }
}

/** Saves the setting and applies it to every bot. Only the Save button of Settings calls this. */
export async function saveCompaction(mode: CompactionMode, gauge: number, profiles: string[]): Promise<SaveResult> {
  try {
    const response = await fetch(ROUTE, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, gauge: clampGauge(gauge), profiles }),
    })
    const body = await response.json().catch(() => ({})) as { applied?: string[]; failed?: string[]; error?: string }
    return { ok: response.ok, applied: body.applied ?? [], failed: body.failed ?? (response.ok ? [] : profiles), error: body.error }
  } catch {
    return { ok: false, applied: [], failed: profiles, error: 'network' }
  }
}

/** The point where Hermes compacts this bot on its own, in tokens of a `contextMax` window (null: unknown). */
export function autoCompactionPoint(values: CompressionValues | undefined, contextMax: number): number | null {
  if (!values || !contextMax) return null
  const ratio = values.threshold ?? 0.5
  // Windows under 512k are floored at 0.75 unless the profile sets more (Hermes's own rule).
  const effective = contextMax < 512_000 ? Math.max(ratio, 0.75) : ratio
  const byRatio = Math.round(contextMax * effective)
  return values.threshold_tokens ? Math.min(byRatio, values.threshold_tokens, contextMax) : byRatio
}
