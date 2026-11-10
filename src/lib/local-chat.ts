/**
 * Chat local isolé : un modèle Ollama local, sans outils et sans passer par Hermes.
 * Le serveur local fixe le modèle et ne transmet que les messages : le navigateur ne choisit rien d’autre.
 * L’historique reste en mémoire.
 */
import type { Bot } from '../types'

// Le deux-points rend le profil invalide pour /api/media : un `MEDIA:` inventé par le modèle ne lit aucun fichier.
export const LOCAL_CHAT_SLUG = 'local:qwen-abliterated'

export const LOCAL_CHAT_BOT: Bot = {
  slug: LOCAL_CHAT_SLUG,
  name: 'Qwen abliterated',
  role: 'Modèle local sans filtre et sans outils. Il répond seulement.',
  section: 'Local',
  sectionId: 'local',
  model: 'Qwen3.8 27B',
  status: 'idle',
  preview: 'Test local, sans outils',
  timestamp: null,
  unread: 0,
  hidden: false,
  avatar: { shape: 'hex', color: 'gray' },
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
  503: 'Ollama ne répond pas sur 127.0.0.1:11434.',
}

export async function streamLocalChat(
  messages: { role: string; content: string }[],
  onFrame: (frame: LocalChatFrame) => void,
  signal: AbortSignal,
) {
  const response = await fetch('/api/local-chat', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
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
