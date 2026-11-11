import type { BackgroundWork } from '../types'
import { i18n } from '../i18n'

type Json = Record<string, unknown>
const asObject = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {})
const text = (value: unknown) => (typeof value === 'string' ? value : '')
const integer = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined)

/**
 * Lifecycle of a delegated child, as the gateway names it (`SubagentStatus`). `ended`: no longer listed by
 * `subagent.list` while no `subagent.complete` reached this window, so its outcome is unknown here.
 */
export type SubagentState = 'queued' | 'running' | 'completed' | 'failed' | 'error' | 'timeout' | 'interrupted' | 'ended'

const WIRE_STATES = new Set<SubagentState>(['queued', 'running', 'completed', 'failed', 'error', 'timeout', 'interrupted'])
const FINISHED = new Set<SubagentState>(['completed', 'failed', 'error', 'timeout', 'interrupted', 'ended'])

const wireState = (value: unknown) => (WIRE_STATES.has(value as SubagentState) ? value as SubagentState : undefined)

export interface SubagentOutput {
  tool: string
  preview: string
  isError: boolean
}

/** One child of the open conversation, as the panel shows it. Kept in memory only. */
export interface SubagentRow {
  id: string
  goal: string
  status: SubagentState
  /** Milliseconds. */
  startedAt?: number
  /** Given by the gateway when the child finishes. */
  durationSeconds?: number
  /** Last time this window heard from the child, in milliseconds. */
  updatedAt: number
  /** Name of the last tool called. Never its arguments: a command can hold a secret. */
  lastTool?: string
  toolCount?: number
  /** Final result (500 characters at most, redacted by the gateway). */
  summary?: string
  model?: string
  depth: number
  taskIndex: number
  taskCount: number
  /** Last tool results, given with the end (`output_tail`). */
  outputTail?: SubagentOutput[]
}

export const isSubagentActive = (row: SubagentRow) => !FINISHED.has(row.status)

/** Snapshot row of `subagent.list` (`SubagentSnapshot`): only children still registered, so still alive. */
export interface SubagentSnapshot {
  id: string
  goal?: string
  status?: SubagentState
  startedAt?: number
  toolCount?: number
  lastTool?: string
  model?: string
  depth?: number
}

export function parseSubagentList(result: unknown): SubagentSnapshot[] {
  const rows = asObject(result).subagents
  if (!Array.isArray(rows)) return []
  return rows.map(asObject).filter((row) => text(row.subagent_id)).map((row) => ({
    id: text(row.subagent_id),
    goal: text(row.goal) || undefined,
    status: wireState(row.status),
    // Seconds since the epoch on the wire.
    startedAt: typeof row.started_at === 'number' && row.started_at > 0 ? row.started_at * 1000 : undefined,
    toolCount: integer(row.tool_count),
    lastTool: text(row.last_tool) || undefined,
    model: text(row.model) || undefined,
    depth: integer(row.depth),
  }))
}

/** At most this many rows per conversation: the oldest finished children go first. */
const MAX_ROWS = 30
/** A child announced by an event may not be registered yet when `subagent.list` answers. */
const LIST_GRACE_MS = 10_000

function capped(rows: SubagentRow[]) {
  if (rows.length <= MAX_ROWS) return rows
  const drop = new Set(rows.filter((row) => !isSubagentActive(row)).sort((a, b) => a.updatedAt - b.updatedAt).slice(0, rows.length - MAX_ROWS).map((row) => row.id))
  return rows.filter((row) => !drop.has(row.id))
}

/** Older emitters leave `subagent_id` out: the task position in its delegation stands in for it. */
function rowId(payload: Json) {
  return text(payload.subagent_id) || `${text(payload.delegation_id) || 'delegation'}:${integer(payload.task_index) ?? 0}`
}

function outputTail(value: unknown): SubagentOutput[] | undefined {
  if (!Array.isArray(value)) return undefined
  const rows = value.map(asObject).filter((row) => text(row.tool)).map((row) => ({ tool: text(row.tool), preview: text(row.preview), isError: row.is_error === true }))
  return rows.length ? rows : undefined
}

/**
 * Folds one `subagent.*` event (`SubagentEventPayload`) into the conversation’s rows. `subagent.thinking` only
 * says the child is alive: its reasoning is not shown here. `subagent.progress` repeats the tool names already
 * given one by one.
 */
export function applySubagentEvent(rows: SubagentRow[], type: string, value: unknown, now = Date.now()): SubagentRow[] {
  if (!type.startsWith('subagent.')) return rows
  const payload = asObject(value)
  const id = rowId(payload)
  const existing = rows.find((row) => row.id === id)
  const base: SubagentRow = existing ?? {
    id,
    goal: '',
    status: 'queued',
    updatedAt: now,
    depth: 0,
    taskIndex: 0,
    taskCount: 1,
  }
  const next: SubagentRow = {
    ...base,
    goal: text(payload.goal) || base.goal,
    model: text(payload.model) || base.model,
    depth: integer(payload.depth) ?? base.depth,
    taskIndex: integer(payload.task_index) ?? base.taskIndex,
    taskCount: integer(payload.task_count) || base.taskCount,
    toolCount: integer(payload.tool_count) ?? base.toolCount,
    updatedAt: now,
  }
  // Late events never bring a finished child back to life.
  const finished = !isSubagentActive(base) && base.status !== 'ended'
  switch (type) {
    case 'subagent.spawn_requested':
      break
    case 'subagent.start':
    case 'subagent.progress':
    case 'subagent.thinking':
      if (!finished) next.status = 'running'
      next.startedAt = base.startedAt ?? now
      break
    case 'subagent.tool':
      if (!finished) next.status = 'running'
      next.startedAt = base.startedAt ?? now
      next.lastTool = text(payload.tool_name) || base.lastTool
      break
    case 'subagent.complete':
      next.status = wireState(payload.status) ?? 'ended'
      if (next.status === 'queued' || next.status === 'running') next.status = 'ended'
      next.summary = text(payload.summary) || base.summary
      next.durationSeconds = typeof payload.duration_seconds === 'number' && payload.duration_seconds >= 0 ? payload.duration_seconds : base.durationSeconds
      next.outputTail = outputTail(payload.output_tail) ?? base.outputTail
      break
    default:
      return rows
  }
  return capped(existing ? rows.map((row) => row.id === id ? next : row) : [...rows, next])
}

/**
 * Applies a `subagent.list` snapshot. A listed child is alive; a child the window still believes active but that
 * is no longer listed ended without its `subagent.complete` reaching us.
 */
export function applySubagentList(rows: SubagentRow[], snapshots: SubagentSnapshot[], now = Date.now()): SubagentRow[] {
  const listed = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]))
  const updated = rows.map((row): SubagentRow => {
    const live = listed.get(row.id)
    if (!live) return isSubagentActive(row) && now - row.updatedAt > LIST_GRACE_MS ? { ...row, status: 'ended', updatedAt: now } : row
    listed.delete(row.id)
    // A `subagent.complete` already seen wins over a list read a moment before the child left the registry.
    if (!isSubagentActive(row) && row.status !== 'ended') return row
    return {
      ...row,
      goal: live.goal || row.goal,
      status: live.status ?? 'running',
      startedAt: live.startedAt ?? row.startedAt,
      toolCount: live.toolCount ?? row.toolCount,
      lastTool: live.lastTool || row.lastTool,
      model: live.model || row.model,
      depth: live.depth ?? row.depth,
      updatedAt: now,
    }
  })
  const added = [...listed.values()].map((live): SubagentRow => ({
    id: live.id,
    goal: live.goal || '',
    status: live.status ?? 'running',
    startedAt: live.startedAt,
    toolCount: live.toolCount,
    lastTool: live.lastTool,
    model: live.model,
    depth: live.depth ?? 0,
    taskIndex: 0,
    taskCount: 1,
    updatedAt: now,
  }))
  return capped([...updated, ...added])
}

/**
 * What the open conversation still runs, for its status. Only top-level children count, like the gateway’s
 * roster: a grandchild runs inside a child that is already counted.
 */
export function chatBackground(rows: SubagentRow[] | undefined, processes: number | undefined): BackgroundWork | undefined {
  const subagents = (rows ?? []).filter((row) => isSubagentActive(row) && row.depth === 0).length
  if (!subagents && !processes) return undefined
  return { subagents, processes: processes ?? 0 }
}

/** “45 s”, “3 min 05 s”, “1 h 02 min”. */
export function formatDuration(seconds: number) {
  const total = Math.max(0, Math.round(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h) return i18n.t('subagents.duration.h', { h, m: String(m).padStart(2, '0') })
  if (m) return i18n.t('subagents.duration.m', { m, s: String(s).padStart(2, '0') })
  return i18n.t('subagents.duration.s', { s })
}

/** Elapsed time of a running child, or the duration the gateway gave at its end. */
export function subagentDuration(row: SubagentRow, now = Date.now()) {
  if (row.durationSeconds !== undefined) return row.durationSeconds
  if (row.startedAt !== undefined && isSubagentActive(row)) return (now - row.startedAt) / 1000
  return undefined
}
