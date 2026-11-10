/**
 * Envoi d’un message pendant qu’un bot travaille (demande de l’utilisateur du 2026-11-10) :
 * - `wait` (défaut) : rien ne part. Le message reste en brouillon ; l’utilisateur le finit après avoir vu le résultat.
 * - `queue` : `prompt.submit` avec `queued` ; Hermes le lance quand le tour en cours est fini.
 * - `priority` : la même file, avec une consigne de reprise dans `api_text`, puis `session.interrupt` du tour
 *   en cours. Le bot lit ce message tout de suite, puis reprend la tâche interrompue.
 * Hors travail, un message part normalement.
 */
export type DeliveryMode = 'wait' | 'queue' | 'priority'

export const DELIVERY_MODES: { id: DeliveryMode; label: string; title: string }[] = [
  { id: 'wait', label: 'Attendre', title: 'Le message reste en brouillon jusqu’à la fin du tour' },
  { id: 'queue', label: 'File', title: 'Le message part tout seul quand le bot a fini sa tâche' },
  { id: 'priority', label: 'Prio', title: 'Le bot s’interrompt, lit ce message, puis reprend sa tâche' },
]

const PRIORITY_NOTE = '[HermesBot priority: the user stopped your current task to send this message. Handle it first. Then resume the interrupted task from where it stopped, unless this message changes or cancels it.]'

/** Ce que lit le modèle pour un message prioritaire : le texte du mode s’il y en a un, puis la consigne de reprise. */
export function priorityApiText(text: string, modeText?: string) {
  return `${modeText ?? text}\n\n${PRIORITY_NOTE}`
}

export function deliveryPlaceholder(delivery: DeliveryMode, botName: string) {
  if (delivery === 'queue') return `Message pour ${botName}, envoyé à la fin de son tour`
  if (delivery === 'priority') return `Message prioritaire : ${botName} s’interrompt pour le lire`
  return `Écrire à ${botName} : le message attend la fin de son tour`
}

const DRAFTS_KEY = 'hermesbot-drafts'
const MAX_DRAFT = 50_000

function readDrafts(): Record<string, string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(DRAFTS_KEY) || '{}')
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {}
    return Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  } catch {
    return {}
  }
}

/** Brouillon texte d’un bot, gardé quand l’app se ferme ou qu’on change de chat. Les fichiers ne sont pas gardés. */
export function loadDraft(slug: string) {
  return readDrafts()[slug] ?? ''
}

export function saveDraft(slug: string, text: string) {
  const drafts = readDrafts()
  if ((drafts[slug] ?? '') === text) return
  if (text.trim()) drafts[slug] = text.slice(0, MAX_DRAFT)
  else delete drafts[slug]
  try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts)) } catch { /* storage indisponible : le brouillon reste en mémoire */ }
}
