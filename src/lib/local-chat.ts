/**
 * Chat local isolé : un modèle installé dans Ollama, sans outils et sans passer par Hermes.
 * Le serveur n’accepte qu’un modèle installé et ne transmet que les messages, jamais d’outil.
 * L’historique reste en mémoire.
 */
import type { Bot } from '../types'

// Le deux-points rend le profil invalide pour /api/media : un `MEDIA:` inventé par le modèle ne lit aucun fichier.
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
    role: 'Modèle local, sans outils. Il répond seulement.',
    section: 'Local',
    sectionId: 'local',
    model,
    status: 'idle',
    preview: 'Ollama, sans outils',
    timestamp: null,
    unread: 0,
    hidden: false,
    avatar: { shape: 'hex', color: 'gray' },
  }
}

export interface LocalModels {
  /** `false` : Ollama ne répond pas. */
  available: boolean
  models: string[]
  /** Modèle proposé par la configuration de l’installation, s’il y en a un. */
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

/** Le choix des réglages s’il est installé, sinon celui de la configuration, sinon le premier. Vide : pas de chat local. */
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

/** Découpe un flux NDJSON : renvoie les trames complètes et le morceau de ligne à garder. */
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
    } catch { /* ligne illisible : le reste du flux reste valable */ }
  }
  return { frames, rest }
}

/** Le raisonnement `<think>` n’est pas la réponse, même quand le gabarit du modèle le laisse dans le texte. */
export function visibleAnswer(text: string) {
  return text.replace(/<think>[\s\S]*?(?:<\/think>\s*|$)/g, '').trimStart()
}

const FAILURES: Record<number, string> = {
  401: 'Session Hermes expirée : reconnecte-toi.',
  404: 'Le modèle n’est pas encore installé dans Ollama.',
  503: 'Ollama ne répond pas.',
}

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
  if (!response.ok || !response.body) throw new Error(FAILURES[response.status] ?? 'Le modèle local a échoué.')
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
