/**
 * Isolated local chat: a model installed in Ollama, without tools and without going through Hermes.
 * The server only accepts an installed model and only forwards messages, never a tool.
 * History stays in memory.
 */
import type { Bot } from '../types'
import { i18n } from '../i18n'

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

export interface LocalModels {
  /** `false`: Ollama is not responding. */
  available: boolean
  models: string[]
  /** Model suggested by the installation’s configuration, if any. */
  defaultModel: string
}

export async function loadLocalModels(): Promise<LocalModels> {
  try {
    const response = await fetch('/api/local-chat/models', { credentials: 'same-origin' })
    if (!response.ok) return { available: false, models: [], defaultModel: '' }
    const body = await response.json()
    const models = Array.isArray(body?.models) ? body.models.filter((model: unknown): model is string => typeof model === 'string' && model !== '') : []
    return { available: body?.available === true, models, defaultModel: typeof body?.defaultModel === 'string' ? body.defaultModel : '' }
  } catch {
    return { available: false, models: [], defaultModel: '' }
  }
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
  return text.replace(/<think>[\s\S]*?(?:<\/think>\s*|$)/g, '').trimStart()
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
