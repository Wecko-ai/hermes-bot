import { isSilentMessage } from './hermes'
import { cleanPreview } from './time'
import { i18n } from '../i18n'

type Json = Record<string, unknown>

/** What a bot is currently doing, assembled without any model call from the gateway events. */
export interface WorkSummary {
  /** Current task of its list, with its progress. */
  task?: string
  done?: number
  total?: number
  /** Last sentence written by the bot during the turn. */
  note?: string
  /** Tool or action in progress. */
  step?: string
}

const MAX_LENGTH = 140
const shorten = (text: string) => (text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH - 1).trimEnd()}…` : text)
const baseName = (value: string) => value.split('/').filter(Boolean).pop() || value

// Tool name -> catalog key for the file tools (with a file name, without one). The other tools are labelled by `work.tools.<name>`.
const FILE_TOOLS: Record<string, [string, string]> = {
  read_file: ['work.fileRead', 'work.fileReadBare'],
  write_file: ['work.fileWrite', 'work.fileWriteBare'],
  patch: ['work.filePatch', 'work.filePatchBare'],
}

/** A tool by its name only, without its arguments: “Reading”, “Searching the web”, “Running a command”. */
export function toolLabel(name: string) {
  const file = FILE_TOOLS[name]
  if (file) return i18n.t(file[1])
  if (name === 'web_search') return i18n.t('work.webSearchBare')
  const label = `work.tools.${name}`
  return i18n.exists(label) ? i18n.t(label) : name.replaceAll('_', ' ')
}

/** Only a file name or a search is shown: a command may contain a secret. */
function toolStep(payload: Json) {
  const name = typeof payload.name === 'string' ? payload.name : ''
  if (!name) return undefined
  const detail = typeof payload.context === 'string' ? payload.context.trim() : ''
  const file = FILE_TOOLS[name]
  if (file) return detail ? i18n.t(file[0], { name: shorten(baseName(detail)) }) : i18n.t(file[1])
  if (name === 'web_search') return detail ? i18n.t('work.webSearch', { query: shorten(detail) }) : i18n.t('work.webSearchBare')
  const label = `work.tools.${name}`
  return i18n.exists(label) ? i18n.t(label) : name.replaceAll('_', ' ')
}

function withTodos(current: WorkSummary, todos: unknown): WorkSummary {
  if (!Array.isArray(todos)) return current
  const items = todos.map((item) => (item && typeof item === 'object' ? item as Json : {})).filter((item) => item.status !== 'cancelled')
  const active = items.find((item) => item.status === 'in_progress') ?? items.find((item) => item.status === 'pending')
  const content = typeof active?.content === 'string' ? cleanPreview(active.content) : ''
  return {
    ...current,
    task: content ? shorten(content) : undefined,
    done: items.filter((item) => item.status === 'completed').length,
    total: items.length,
  }
}

function firstSentence(text: string) {
  const line = cleanPreview(text)
  const end = line.search(/[.!?…](\s|$)/)
  return shorten(end >= 20 ? line.slice(0, end + 1) : line)
}

/** Advances a bot’s summary. `undefined`: the turn is over, nothing left to summarize. */
export function applyWorkEvent(current: WorkSummary | undefined, event: { type?: string; payload?: Json }): WorkSummary | undefined {
  const payload = event.payload ?? {}
  const base = current ?? {}
  switch (event.type) {
    case 'message.start':
      return {}
    case 'message.complete':
      return undefined
    case 'todo.updated':
      return withTodos(base, payload.todos)
    case 'message.interim': {
      const text = typeof payload.text === 'string' ? payload.text : ''
      return text.trim() && !isSilentMessage(text) ? { ...base, note: firstSentence(text) } : current
    }
    case 'message.delta':
      return typeof payload.text === 'string' && payload.text ? { ...base, step: i18n.t('work.writing') } : current
    case 'tool.start':
      return { ...base, step: toolStep(payload) ?? base.step }
    case 'tool.complete':
      return { ...withTodos(base, payload.todos), step: undefined }
    default:
      return current
  }
}

/** The short line shown in the roster and the header. */
export function workLine(summary: WorkSummary | undefined, fallback = '') {
  if (summary?.task) {
    const total = summary.total ?? 0
    return total ? `${Math.min((summary.done ?? 0) + 1, total)}/${total} · ${summary.task}` : summary.task
  }
  return summary?.note || summary?.step || fallback
}
