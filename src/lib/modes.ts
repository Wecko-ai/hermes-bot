/**
 * Modes de travail du composer. BRAIN et PLAN partent dans `api_text` : le bot lit la consigne pour ce
 * tour seulement, et l’historique garde le texte de l’utilisateur. Hermes n’a pas de lecture seule par tour sur
 * un Bot Chat : c’est une consigne donnée au modèle, pas un verrou sur ses outils.
 */
export type ChatMode = 'brain' | 'plan' | 'exec'

export const CHAT_MODES: { id: ChatMode; label: string; title: string }[] = [
  { id: 'brain', label: 'BRAIN', title: 'Réfléchit avec toi et cherche les meilleures solutions, sans rien exécuter' },
  { id: 'plan', label: 'PLAN', title: 'Construit un plan avec toi avant toute exécution' },
  { id: 'exec', label: 'EXEC', title: 'Exécute la tâche' },
]

const NO_ACTION = 'You may read and research. Do not change files, run anything with side effects, send messages, or start the work.'

const INSTRUCTIONS: Partial<Record<ChatMode, string>> = {
  brain: `[HermesBot mode: BRAIN. For this turn only, think with the user. Explore the problem, challenge assumptions, compare real options with their trade-offs, and recommend the best one. ${NO_ACTION} End with your recommendation and the open questions that matter.]`,
  plan: `[HermesBot mode: PLAN. For this turn only, help the user build a plan before anything is executed. ${NO_ACTION} Give ordered steps, what each step touches, the risks, and how the result will be verified. Ask the questions that block the plan, then wait for the user's go.]`,
}

/** Le texte lu par le modèle, ou `undefined` en EXEC : le tour reste alors un message normal. */
export function modeApiText(text: string, mode: ChatMode) {
  const instruction = INSTRUCTIONS[mode]
  return instruction ? `${text}\n\n${instruction}` : undefined
}

export function modePlaceholder(mode: ChatMode, botName: string) {
  if (mode === 'brain') return `Réfléchir avec ${botName}`
  if (mode === 'plan') return `Préparer un plan avec ${botName}`
  return `Message ${botName}`
}

const STORAGE_KEY = 'hermesbot-modes'
const isMode = (value: unknown): value is ChatMode => CHAT_MODES.some((mode) => mode.id === value)

/** Le mode de chaque bot. Une valeur inconnue revient à EXEC, le comportement normal. */
export function loadModes(): Record<string, ChatMode> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    if (!saved || typeof saved !== 'object') return {}
    return Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, ChatMode] => isMode(entry[1])))
  } catch {
    return {}
  }
}

export function saveModes(modes: Record<string, ChatMode>) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(modes)) } catch { /* storage indisponible */ }
}
