import { isSilentMessage } from './hermes'
import { cleanPreview } from './time'

type Json = Record<string, unknown>

/** Ce qu’un bot est en train de faire, assemblé sans appel de modèle depuis les événements de la gateway. */
export interface WorkSummary {
  /** Tâche en cours de sa liste, avec sa progression. */
  task?: string
  done?: number
  total?: number
  /** Dernière phrase écrite par le bot pendant le tour. */
  note?: string
  /** Outil ou action en cours. */
  step?: string
}

const MAX_LENGTH = 140
const shorten = (text: string) => (text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH - 1).trimEnd()}…` : text)
const baseName = (value: string) => value.split('/').filter(Boolean).pop() || value

const FILE_TOOLS: Record<string, string> = { read_file: 'Lit', write_file: 'Écrit', patch: 'Modifie' }
const TOOL_LABELS: Record<string, string> = {
  search_files: 'Cherche dans les fichiers',
  terminal: 'Lance une commande',
  execute_code: 'Exécute du code',
  web_extract: 'Lit une page web',
  x_search: 'Cherche sur X',
  delegate_task: 'Délègue une tâche',
  image_generate: 'Génère une image',
  video_generate: 'Génère une vidéo',
  vision_analyze: 'Analyse une image',
  video_analyze: 'Analyse une vidéo',
  skill_view: 'Consulte une compétence',
  skills_list: 'Parcourt ses compétences',
  memory: 'Met à jour sa mémoire',
  session_search: 'Cherche dans ses conversations',
  todo_list: 'Organise ses tâches',
  browser_exec: 'Utilise le navigateur',
  browser_cdp: 'Utilise le navigateur',
  computer_use: 'Utilise l’ordinateur',
  clarify: 'Pose une question',
  text_to_speech: 'Génère de l’audio',
  cronjob_manage: 'Gère ses routines',
}

/** Seuls un nom de fichier ou une recherche sont montrés : une commande peut contenir un secret. */
function toolStep(payload: Json) {
  const name = typeof payload.name === 'string' ? payload.name : ''
  if (!name) return undefined
  const detail = typeof payload.context === 'string' ? payload.context.trim() : ''
  if (FILE_TOOLS[name]) return detail ? `${FILE_TOOLS[name]} ${shorten(baseName(detail))}` : FILE_TOOLS[name]
  if (name === 'web_search') return detail ? `Cherche « ${shorten(detail)} »` : 'Cherche sur le web'
  return TOOL_LABELS[name] || name.replaceAll('_', ' ')
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

/** Fait avancer le résumé d’un bot. `undefined` : le tour est fini, il n’y a plus rien à résumer. */
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
      return typeof payload.text === 'string' && payload.text ? { ...base, step: 'Rédige sa réponse' } : current
    case 'tool.start':
      return { ...base, step: toolStep(payload) ?? base.step }
    case 'tool.complete':
      return { ...withTodos(base, payload.todos), step: undefined }
    default:
      return current
  }
}

/** La ligne courte du roster et de l’en-tête. */
export function workLine(summary: WorkSummary | undefined, fallback = '') {
  if (summary?.task) {
    const total = summary.total ?? 0
    return total ? `${Math.min((summary.done ?? 0) + 1, total)}/${total} · ${summary.task}` : summary.task
  }
  return summary?.note || summary?.step || fallback
}
