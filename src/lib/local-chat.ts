/**
 * Isolated local chat: a model installed in Ollama, without tools and without going through Hermes.
 * The server only accepts an installed model and only forwards messages, never a tool.
 * History stays in memory.
 */
import type { Bot } from '../types'
import { i18n } from '../i18n'
import { isSilentMessage, withoutSilentMarkers } from './hermes'

// The colon makes the profile invalid for /api/media: a `MEDIA:` invented by the model reads no file.
export const LOCAL_CHAT_SLUG = 'local:ollama'

/** `qwen3:8b` → `qwen3 8b`, `library/llama3.2:latest` → `llama3.2`. */
export function localModelLabel(model: string) {
  const [name, tag = ''] = model.split('/').pop()!.split(':')
  return tag && tag !== 'latest' ? `${name} ${tag}` : name
}

export function localChatBot(model: string, name = ''): Bot {
  return {
    slug: LOCAL_CHAT_SLUG,
    name: name || localModelLabel(model),
    role: i18n.t('localChat.role'),
    section: 'Local',
    sectionId: 'local',
    model,
    status: 'idle',
    preview: i18n.t('localChat.preview'),
    timestamp: null,
    unread: 0,
    hidden: false,
    avatar: { shape: 'hex', color: 'gray' },
  }
}

/** What Ollama says of an installed model. Empty fields: not given. */
export interface LocalModelInfo {
  /** Size on disk, in bytes. */
  size: number
  /** `27.3B`. */
  parameters: string
  /** `Q4_K_M`. */
  quantization: string
  family: string
}

export interface LocalModels {
  /** `false`: Ollama is not responding. */
  available: boolean
  models: string[]
  details?: Record<string, LocalModelInfo>
  /** Model suggested by the installation’s configuration, if any. */
  defaultModel: string
}

const text = (value: unknown) => (typeof value === 'string' ? value : '')
const bytes = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)

export function parseLocalModels(body: unknown): LocalModels {
  const value = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const models = Array.isArray(value.models) ? value.models.filter((model: unknown): model is string => typeof model === 'string' && model !== '') : []
  const given = value.details && typeof value.details === 'object' ? value.details as Record<string, Record<string, unknown> | undefined> : {}
  const details = Object.fromEntries(models.map((model) => {
    const detail = given[model] && typeof given[model] === 'object' ? given[model] : {}
    return [model, { size: bytes(detail.size), parameters: text(detail.parameters), quantization: text(detail.quantization), family: text(detail.family) }]
  }))
  return { available: value.available === true, models, details, defaultModel: text(value.defaultModel) }
}

export async function loadLocalModels(): Promise<LocalModels> {
  try {
    const response = await fetch('/api/local-chat/models', { credentials: 'same-origin' })
    if (!response.ok) return { available: false, models: [], defaultModel: '' }
    return parseLocalModels(await response.json())
  } catch {
    return { available: false, models: [], defaultModel: '' }
  }
}

/** A model in memory (Ollama’s `/api/ps`). */
export interface LoadedLocalModel {
  model: string
  /** Memory taken, in bytes, and the part in GPU memory. */
  size: number
  vram: number
  /** ISO date at which Ollama unloads it by itself, empty if unknown. */
  expiresAt: string
  context: number
  /** Loaded with the Load button: kept 30 min after the last message. */
  kept: boolean
}

export interface LocalMemory {
  /** `false`: Ollama is not responding. */
  available: boolean
  loaded: LoadedLocalModel[]
}

export function parseLocalMemory(body: unknown): LocalMemory {
  const value = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const loaded = (Array.isArray(value.loaded) ? value.loaded : [])
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).model === 'string')
    .map((entry) => ({
      model: entry.model as string,
      size: bytes(entry.size),
      vram: bytes(entry.vram),
      expiresAt: text(entry.expiresAt),
      context: typeof entry.context === 'number' && Number.isInteger(entry.context) && entry.context > 0 ? entry.context : 0,
      kept: entry.kept === true,
    }))
  return { available: value.available === true, loaded }
}

export async function loadLocalMemory(): Promise<LocalMemory> {
  try {
    const response = await fetch('/api/local-chat/status', { credentials: 'same-origin' })
    if (!response.ok) return { available: false, loaded: [] }
    return parseLocalMemory(await response.json())
  } catch {
    return { available: false, loaded: [] }
  }
}

/** Loads the model into memory (kept 30 min after the last message) or unloads it. Throws a readable message. */
export async function setLocalModelLoaded(model: string, loaded: boolean) {
  let response: Response
  try {
    response = await fetch(loaded ? '/api/local-chat/load' : '/api/local-chat/unload', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    })
  } catch {
    throw new Error(i18n.t('localChat.ollamaDown'))
  }
  if (!response.ok) throw new Error(response.status === 401 || response.status === 404 || response.status === 503 ? failureMessage(response.status) : i18n.t(loaded ? 'localChat.loadFailed' : 'localChat.unloadFailed'))
}

/** `16810714518` → `16.8 GB`, in the interface’s language. */
export function formatBytes(value: number, language = i18n.language) {
  if (!value) return ''
  const gb = value / 1e9
  const number = new Intl.NumberFormat(language, { maximumFractionDigits: gb >= 100 ? 0 : 1 }).format(gb >= 1 ? gb : value / 1e6)
  return i18n.t(gb >= 1 ? 'localChat.gigabytes' : 'localChat.megabytes', { size: number, lng: language })
}

/** `27.3B · Q4_K_M · 16.8 GB`: what is known of the model, in one line. */
export function localModelFacts(info: LocalModelInfo | undefined) {
  if (!info) return ''
  return [info.parameters, info.quantization, formatBytes(info.size)].filter(Boolean).join(' · ')
}

/** The model chosen in settings if installed, else the configuration’s, else the first. Empty: no local chat. */
export function chooseLocalModel(local: LocalModels | null, preferred: string) {
  if (!local?.available || local.models.length === 0) return ''
  if (preferred && local.models.includes(preferred)) return preferred
  if (local.defaultModel && local.models.includes(local.defaultModel)) return local.defaultModel
  return local.models[0]
}

export interface LocalChatFrame {
  content: string
  thinking: string
  done: boolean
}

/** Splits an NDJSON stream: returns the complete frames and the partial line to keep. */
export function readLocalChatFrames(buffer: string) {
  const lines = buffer.split('\n')
  const rest = lines.pop() ?? ''
  const frames: LocalChatFrame[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const frame = JSON.parse(line)
      frames.push({
        content: typeof frame.message?.content === 'string' ? frame.message.content : '',
        thinking: typeof frame.message?.thinking === 'string' ? frame.message.thinking : '',
        done: frame.done === true,
      })
    } catch { /* unreadable line: the rest of the stream stays valid */ }
  }
  return { frames, rest }
}

/** `<think>` reasoning is not the answer, even when the model’s template leaves it in the text. */
export function visibleAnswer(text: string) {
  const stripped = text.replace(/<think>[\s\S]*?(?:<\/think>\s*|$)/g, '').trimStart()
  if (!stripped || isSilentMessage(stripped)) return ''
  return withoutSilentMarkers(stripped)
}

const failureMessage = (status: number) =>
  status === 401 ? i18n.t('localChat.sessionExpired')
    : status === 404 ? i18n.t('localChat.notInstalled')
      : status === 503 ? i18n.t('localChat.ollamaDown')
        : i18n.t('localChat.failed')

export async function streamLocalChat(
  model: string,
  messages: { role: string; content: string }[],
  onFrame: (frame: LocalChatFrame) => void,
  signal: AbortSignal,
) {
  const response = await fetch('/api/local-chat', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages }),
    signal,
  })
  if (!response.ok || !response.body) throw new Error(failureMessage(response.status))
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    const { frames, rest } = readLocalChatFrames(buffer + value)
    buffer = rest
    frames.forEach(onFrame)
  }
}

/** A saved conversation of the local chat, as listed (without its messages). */
export interface LocalConversationSummary {
  id: string
  title: string
  model: string
  createdAt: string
  updatedAt: string
  count: number
}

export interface LocalHistory {
  /** `false`: kept by the server until it stops (no encryption available). */
  persistent: boolean
  /** `false`: the saved file cannot be read now; nothing is written over it. */
  readable: boolean
  conversations: LocalConversationSummary[]
}

export interface LocalConversation {
  id: string
  model: string
  messages: { id: string; role: 'user' | 'assistant'; content: string; createdAt: string }[]
}

export function parseLocalHistory(body: unknown): LocalHistory {
  const value = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const conversations = (Array.isArray(value.conversations) ? value.conversations : [])
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).id === 'string')
    .map((entry) => ({
      id: entry.id as string,
      title: text(entry.title),
      model: text(entry.model),
      createdAt: text(entry.createdAt),
      updatedAt: text(entry.updatedAt),
      count: typeof entry.count === 'number' && Number.isInteger(entry.count) && entry.count > 0 ? entry.count : 0,
    }))
  return { persistent: value.persistent === true, readable: value.readable !== false, conversations }
}

export async function loadLocalHistory(): Promise<LocalHistory | null> {
  try {
    const response = await fetch('/api/local-chat/history', { credentials: 'same-origin' })
    return response.ok ? parseLocalHistory(await response.json()) : null
  } catch {
    return null
  }
}

export async function readLocalConversation(id: string): Promise<LocalConversation | null> {
  try {
    const response = await fetch(`/api/local-chat/history/${encodeURIComponent(id)}`, { credentials: 'same-origin' })
    if (!response.ok) return null
    const body = await response.json()
    const messages = (Array.isArray(body?.messages) ? body.messages : [])
      .filter((message: unknown): message is LocalConversation['messages'][number] => {
        const value = message as Record<string, unknown> | null
        return !!value && typeof value.id === 'string' && (value.role === 'user' || value.role === 'assistant') && typeof value.content === 'string'
      })
    return { id, model: text(body?.model), messages }
  } catch {
    return null
  }
}

/** Saves the whole conversation. Throws a readable message. */
export async function saveLocalConversation(id: string, model: string, messages: LocalConversation['messages']) {
  let response: Response
  try {
    response = await fetch(`/api/local-chat/history/${encodeURIComponent(id)}`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages }),
    })
  } catch {
    throw new Error(i18n.t('localChat.historyNotSaved'))
  }
  if (!response.ok) {
    const error = await response.json().then((body) => text(body?.error)).catch(() => '')
    throw new Error(i18n.t(error === 'history_unreadable' ? 'localChat.historyUnreadable' : error === 'history_full' || error === 'conversation_too_large' ? 'localChat.historyFull' : 'localChat.historyNotSaved'))
  }
}

export async function deleteLocalConversation(id: string) {
  const response = await fetch(`/api/local-chat/history/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin' }).catch(() => null)
  if (!response?.ok) throw new Error(i18n.t('localChat.deleteFailed'))
}

/** A new conversation ID, accepted by the server. */
export function newLocalConversationId() {
  return `local-${crypto.randomUUID()}`
}
