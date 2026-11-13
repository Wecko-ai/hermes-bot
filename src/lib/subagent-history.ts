import type { ChatMessage, DelegationTask } from '../types'
import { isSubagentActive, type SubagentRow, type SubagentState } from './subagents'
import { parseProcessEnd, type AgentProcess, type AgentRun } from './agent-process'

type Json = Record<string, unknown>
const asObject = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {})
const text = (value: unknown) => (typeof value === 'string' ? value : '')

/**
 * One child the bot delegated in the open conversation. It joins what the history keeps (the `delegate_task`
 * call with the whole prompt, then the gateway's completion message with the full result) and what this window
 * saw live (`subagent.*` events, `subagent.list`). A coding agent the bot started from its terminal
 * (`claude -p`…) is one too: its call, the gateway's end of process, and its `process.list` row.
 */
export interface SubagentEntry {
  id: string
  goal: string
  /** Background the bot gave with the goal: the rest of the prompt. Only the history has it. */
  context?: string
  status: SubagentState
  /** Stopped at its iteration cap: the work may be incomplete. */
  truncated?: boolean
  /** Milliseconds. */
  startedAt?: number
  /** Milliseconds: when its end reached the history or this window. */
  finishedAt?: number
  durationSeconds?: number
  apiCalls?: number
  model?: string
  /** Final answer of the child, whole when it comes from the history (Markdown). */
  result?: string
  error?: string
  taskIndex: number
  taskCount: number
  /** Live row of this window: transcript tail, last tool, tool count. */
  live?: SubagentRow
  /** Coding agent started from the terminal: tool, folder, prompt file, log file. */
  run?: AgentRun & { background?: boolean }
  /** Its background process as `process.list` gives it: live output, exit code. */
  process?: AgentProcess
  exitCode?: number
}

export const isEntryActive = (entry: SubagentEntry) => entry.status === 'queued' || entry.status === 'running'

// ── The call: `delegate_task` arguments ──────────────────────────────────────────────────────────────────────

function parseArguments(value: unknown): Json {
  if (typeof value !== 'string') return asObject(value)
  try { return asObject(JSON.parse(value)) } catch { return {} }
}

/** Tasks of a `delegate_task` spawn: the `tasks` list, or the older single `goal`. Control actions spawn nothing. */
export function delegationTasks(args: unknown): DelegationTask[] {
  const call = parseArguments(args)
  const action = text(call.action)
  if (action && action !== 'spawn') return []
  const tasks = Array.isArray(call.tasks) ? call.tasks.map(asObject) : text(call.goal) ? [call] : []
  return tasks.filter((task) => text(task.goal).trim()).map((task) => {
    const context = text(task.context).trim()
    return { goal: text(task.goal).trim(), ...(context ? { context } : {}) }
  })
}

// ── The end: the gateway's completion message ────────────────────────────────────────────────────────────────

export interface DelegationResult {
  goal: string
  context?: string
  taskIndex: number
  taskCount: number
  status: SubagentState
  truncated: boolean
  apiCalls?: number
  durationSeconds?: number
  model?: string
  result?: string
  error?: string
  /** Early warning for one failed child of a fan-out still running: the batch result comes later. */
  early?: boolean
}

const BATCH = '[ASYNC DELEGATION BATCH COMPLETE'
const SINGLE = '[ASYNC DELEGATION COMPLETE'
const FAILED = /^\[ASYNC DELEGATION TASK FAILED — [^,\]]+, task (\d+)\/(\d+)\]/
// `--- ✓ TASK 1/2: goal  (status=completed, api_calls=12, 64.2s, TRUNCATED: …) ---`
const TASK_HEADER = /^--- [✓⚠✗] TASK (\d+)\/(\d+)(?:: ([\s\S]*?))?  \(status=([A-Za-z_]+)(?:, api_calls=(\d+))?(?:, ([\d.]+)s)?(, TRUNCATED[^)]*)?\) ---$/gm
const MODEL = /^Role: \S+(?:\s+Model: (\S+))?/m
const TRUNCATED_NOTE = /^\[TRUNCATED — subagent hit its iteration cap[^\]]*\]\s*/
const TRAILER = /^(?:Full live transcript \(complete tool\/assistant trace\):|Live transcript:|Handed off to you:|Child left \d+ background process|Child's process ).*$/gm

/** Gateway status to the panel's. Unknown ones end without a verdict. */
function resultStatus(value: string): SubagentState {
  switch (value) {
    case 'completed': case 'success': return 'completed'
    case 'failed': case 'rejected': return 'failed'
    case 'error': return 'error'
    case 'timeout': return 'timeout'
    case 'interrupted': case 'cancelled': return 'interrupted'
    default: return 'ended'
  }
}

const seconds = (value: string | undefined) => {
  const number = value === undefined ? Number.NaN : Number(value)
  return Number.isFinite(number) && number >= 0 ? number : undefined
}
const count = (value: string | undefined) => {
  const number = value === undefined ? Number.NaN : Number(value)
  return Number.isInteger(number) && number >= 0 ? number : undefined
}

/** The answer under a task header: the summary without the gateway's notes, or the error. */
function taskBody(body: string): Pick<DelegationResult, 'result' | 'error'> {
  const clean = body.replace(TRAILER, '').trim()
  const missing = /^\(no summary — status=[A-Za-z_]+(?::\s*([\s\S]*))?\)$/.exec(clean)
  if (missing) return missing[1] ? { error: missing[1].trim() } : {}
  const partial = /^\(([A-Za-z_]+): ([\s\S]*?)\)\nPartial output:\n([\s\S]*)$/.exec(clean) ?? /^()()Partial output:\n([\s\S]*)$/.exec(clean)
  if (partial) return { result: partial[3].trim(), ...(partial[2] ? { error: partial[2].trim() } : {}) }
  const result = clean.replace(TRUNCATED_NOTE, '').trim()
  return result ? { result } : {}
}

/** Results carried by one completion message of the gateway (`display_kind: async_delegation_complete`). */
export function parseDelegationCompletion(content: string): DelegationResult[] {
  const message = content.trim()
  const model = MODEL.exec(message)?.[1]
  if (message.startsWith(BATCH)) {
    const headers = [...message.matchAll(TASK_HEADER)]
    return headers.map((header, index) => {
      const start = (header.index ?? 0) + header[0].length
      const end = headers[index + 1]?.index ?? message.length
      return {
        goal: (header[3] ?? '').trim(),
        taskIndex: Number(header[1]) - 1,
        taskCount: Number(header[2]),
        status: resultStatus(header[4]),
        truncated: Boolean(header[7]),
        apiCalls: count(header[5]),
        durationSeconds: seconds(header[6]),
        ...(model ? { model } : {}),
        ...taskBody(message.slice(start, end)),
      }
    })
  }
  if (message.startsWith(SINGLE)) {
    const goal = /^Original goal: ([\s\S]*?)\n(?:Context you provided: |Toolsets: |Role: )/m.exec(message)?.[1]?.trim() ?? ''
    const context = /^Context you provided: ([\s\S]*?)\n(?:Toolsets: |Role: )/m.exec(message)?.[1]?.trim()
    const status = /^Status: ([A-Za-z_]+)(?:\s+API calls: (\d+))?\s+Duration: ([\d.]+|\?)s/m.exec(message)
    const at = message.indexOf('\n--- RESULT ---\n')
    const body = at < 0 ? '' : message.slice(at + '\n--- RESULT ---\n'.length)
    const state = resultStatus(status?.[1] ?? '')
    let outcome: Pick<DelegationResult, 'result' | 'error'>
    if (state === 'completed') outcome = taskBody(body)
    else {
      const [reason, partial] = body.split(/\nPartial output:\n/)
      outcome = { error: reason.replace(TRAILER, '').trim() || undefined, ...(partial?.trim() ? { result: partial.trim() } : {}) }
    }
    return [{
      goal,
      ...(context ? { context } : {}),
      taskIndex: 0,
      taskCount: 1,
      status: state,
      truncated: /\[TRUNCATED: hit max_iterations/.test(message),
      apiCalls: count(status?.[2]),
      durationSeconds: seconds(status?.[3]),
      ...(model ? { model } : {}),
      ...outcome,
    }]
  }
  const failed = FAILED.exec(message)
  if (failed) {
    const status = /^Status: ([A-Za-z_]+)\s+Duration: ([\d.]+|\?)s/m.exec(message)
    const error = /^Error: (.*)$/m.exec(message)?.[1]?.trim()
    return [{
      goal: /^Task: (.*)$/m.exec(message)?.[1]?.trim() ?? '',
      taskIndex: Number(failed[1]) - 1,
      taskCount: Number(failed[2]),
      status: resultStatus(status?.[1] ?? 'failed'),
      truncated: false,
      durationSeconds: seconds(status?.[2]),
      ...(error ? { error } : {}),
      early: true,
    }]
  }
  return []
}

// ── Joining them ─────────────────────────────────────────────────────────────────────────────────────────────

const flat = (value: string) => value.replace(/\s+/g, ' ').trim().replace(/(?:…|\.\.\.)$/, '').trim()

/** The same task: equal goals, or one cut short by the gateway (a long goal) at the start of the other. */
export function sameGoal(a: string, b: string) {
  const left = flat(a)
  const right = flat(b)
  if (!left || !right) return false
  if (left === right) return true
  const [short, long] = left.length < right.length ? [left, right] : [right, left]
  return short.length >= 40 && long.startsWith(short)
}

const time = (value: string | null) => {
  const parsed = value ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

/** At most this many entries per conversation, the most recent ones. */
const MAX_ENTRIES = 60

/**
 * Every child of the conversation, most recent first. A dispatch with neither an end in the history nor a live
 * row has `ended`: it may still run elsewhere, or its end was folded away by a compaction.
 */
export function subagentHistory(messages: ChatMessage[], live: SubagentRow[], processes: AgentProcess[] = []): SubagentEntry[] {
  type Built = SubagentEntry & { done?: boolean; early?: boolean; processId?: string; order: number }
  const entries: Built[] = []
  let order = 0
  const add = (entry: Omit<Built, 'order'>) => { entries.push({ ...entry, order: order++ }) }

  for (const message of messages) {
    if (message.agentRun) {
      const at = time(message.createdAt)
      // In the foreground, the call's row is written once the agent is done; its exit code is not kept.
      const background = message.agentRun.background
      add({ id: `${message.id}:run`, goal: message.agentRun.prompt ?? '', run: message.agentRun, status: 'ended', startedAt: at, finishedAt: background ? undefined : at, taskIndex: 0, taskCount: 1, done: !background })
      continue
    }
    if (message.role === 'user' && message.content.startsWith('[IMPORTANT: Background process')) {
      const end = parseProcessEnd(message.content)
      if (!end?.run) continue
      const at = time(message.createdAt)
      const outcome = { status: end.status, exitCode: end.exitCode, finishedAt: at, result: end.output, processId: end.processId, done: true }
      const target = entries.find((entry) => entry.run && !entry.done && entry.run.key === end.key)
      if (target) Object.assign(target, outcome)
      else add({ id: `${message.id}:end`, goal: end.run.prompt ?? '', run: end.run, taskIndex: 0, taskCount: 1, ...outcome })
      continue
    }
    if (message.delegation?.length) {
      const at = time(message.createdAt)
      message.delegation.forEach((task, index) => add({
        id: `${message.id}:${index}`,
        goal: task.goal,
        ...(task.context ? { context: task.context } : {}),
        status: 'ended',
        startedAt: at,
        taskIndex: index,
        taskCount: message.delegation!.length,
      }))
      continue
    }
    if (message.role !== 'user' || !message.content.startsWith('[ASYNC DELEGATION')) continue
    const at = time(message.createdAt)
    parseDelegationCompletion(message.content).forEach((result, index) => {
      // The oldest dispatch of this goal still waiting; an early failure notice gives way to the batch result.
      const target = entries.find((entry) => !entry.run && (!entry.done || (entry.early && !result.early)) && sameGoal(entry.goal, result.goal))
      const outcome = {
        status: result.status,
        truncated: result.truncated || undefined,
        finishedAt: at,
        durationSeconds: result.durationSeconds,
        apiCalls: result.apiCalls,
        model: result.model,
        result: result.result,
        error: result.error,
        done: true,
        early: result.early,
      }
      if (target) {
        Object.assign(target, outcome, { context: target.context ?? result.context, model: result.model ?? target.model })
        return
      }
      add({
        id: `${message.id}:result-${index}`,
        goal: result.goal,
        ...(result.context ? { context: result.context } : {}),
        startedAt: at !== undefined && result.durationSeconds !== undefined ? at - result.durationSeconds * 1000 : at,
        taskIndex: result.taskIndex,
        taskCount: result.taskCount,
        ...outcome,
      })
    })
  }

  for (const row of live) {
    const active = isSubagentActive(row)
    // The latest dispatch of this goal not yet tied to a live row: still open, or already ended for a finished row.
    let target: (typeof entries)[number] | undefined
    for (let index = entries.length - 1; index >= 0 && !target; index -= 1) {
      const entry = entries[index]
      if (!entry.run && !entry.live && (!entry.done || !active) && sameGoal(entry.goal, row.goal)) target = entry
    }
    if (!target) {
      add({ id: `live:${row.id}`, goal: row.goal, status: row.status, taskIndex: row.taskIndex, taskCount: row.taskCount })
      target = entries[entries.length - 1]
    }
    target.live = row
    target.model ??= row.model
    target.startedAt = row.startedAt ?? target.startedAt
    if (target.done) continue
    target.status = row.status
    target.durationSeconds = row.durationSeconds
    target.result = row.summary
    target.finishedAt = active ? undefined : row.updatedAt
  }

  for (const process of processes) {
    const active = process.status === 'running' || process.status === 'queued'
    // Its own end in the history first, else the latest call of the same command not yet tied to a process.
    let target = entries.find((entry) => entry.processId === process.id)
    for (let index = entries.length - 1; index >= 0 && !target; index -= 1) {
      const entry = entries[index]
      if (entry.run && !entry.process && entry.run.key === process.run.key && (!entry.done || !active)) target = entry
    }
    if (!target) {
      add({ id: `process:${process.id}`, goal: process.run.prompt ?? '', run: { ...process.run, background: true }, status: process.status, taskIndex: 0, taskCount: 1 })
      target = entries[entries.length - 1]
    }
    target.process = process
    target.processId = process.id
    target.startedAt = process.startedAt ?? target.startedAt
    if (target.done) continue
    target.status = process.status
    target.exitCode = process.exitCode
    target.finishedAt = active ? undefined : process.finishedAt
    if (!active && process.outputTail) target.result ??= process.outputTail
  }

  for (const entry of entries) {
    if (entry.run && entry.durationSeconds === undefined && entry.startedAt !== undefined && entry.finishedAt !== undefined && entry.finishedAt > entry.startedAt) {
      entry.durationSeconds = (entry.finishedAt - entry.startedAt) / 1000
    }
  }

  return entries
    .sort((a, b) => (b.startedAt ?? b.finishedAt ?? 0) - (a.startedAt ?? a.finishedAt ?? 0) || b.order - a.order)
    .slice(0, MAX_ENTRIES)
    .map(({ done: _done, early: _early, processId: _processId, order: _order, ...entry }) => entry)
}

// ── What the panels show ─────────────────────────────────────────────────────────────────────────────────────

/** `/Users/test/projects/site/docs/SPEC.md` reads `…/docs/SPEC.md` in a title. */
const LONG_PATH = /(?:\/[\w.@+-]+){3,}(\/[\w.@+-]+\/[\w.@+-]+)/g

function shorten(value: string, max: number) {
  if (value.length <= max) return value
  const cut = value.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.(–-]+$/, '')}…`
}

/** A short title for a child: the first sentence of its goal, long paths cut down. */
export function subagentTitle(goal: string, max = 90) {
  const line = goal.replace(LONG_PATH, '…$1').replace(/\s+/g, ' ').trim()
  const sentence = /^(.{24,}?[.!?;])(?=\s|$)/.exec(line)?.[1] ?? line
  return shorten(sentence, max)
}

/** The prompt under the title, only when it says more than the title. */
export function promptPreview(goal: string) {
  const title = subagentTitle(goal)
  return title === goal.replace(/\s+/g, ' ').trim() ? '' : goal
}

/** A result in one paragraph for a collapsed card: Markdown marks and tables left out. */
export function plainPreview(markdown: string, max = 280) {
  const lines = markdown
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^(?:[-|:\s]+|---+|```.*)$/.test(line) && !line.startsWith('|'))
    .map((line) => line.replace(/^#{1,6}\s+|^[-*+]\s+|^>\s?/g, '').replace(/[*_`]+/g, ''))
  return shorten(lines.join(' · '), max)
}
