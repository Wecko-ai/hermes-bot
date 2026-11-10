import { i18n } from '../i18n'

/**
 * Composer work modes. BRAIN and PLAN go out in `api_text`: the bot reads the instruction for this
 * turn only, and the history keeps the user’s text. Hermes has no per-turn read-only mode on
 * a Bot Chat: this is an instruction given to the model, not a lock on its tools.
 */
export type ChatMode = 'brain' | 'plan' | 'exec'

export const CHAT_MODES: { id: ChatMode; label: string; title: string }[] = [
  // Getters: the text follows the interface language at read time.
  { id: 'brain', get label() { return i18n.t('modes.brain.label') }, get title() { return i18n.t('modes.brain.title') } },
  { id: 'plan', get label() { return i18n.t('modes.plan.label') }, get title() { return i18n.t('modes.plan.title') } },
  { id: 'exec', get label() { return i18n.t('modes.exec.label') }, get title() { return i18n.t('modes.exec.title') } },
]

const NO_ACTION = 'You may read and research. Do not change files, run anything with side effects, send messages, or start the work.'

const INSTRUCTIONS: Partial<Record<ChatMode, string>> = {
  brain: `[HermesBot mode: BRAIN. For this turn only, think with the user. Explore the problem, challenge assumptions, compare real options with their trade-offs, and recommend the best one. ${NO_ACTION} End with your recommendation and the open questions that matter.]`,
  plan: `[HermesBot mode: PLAN. For this turn only, help the user build a plan before anything is executed. ${NO_ACTION} Give ordered steps, what each step touches, the risks, and how the result will be verified. Ask the questions that block the plan, then wait for the user's go.]`,
}

/** The text the model reads, or `undefined` in EXEC: the turn then stays a normal message. */
export function modeApiText(text: string, mode: ChatMode) {
  const instruction = INSTRUCTIONS[mode]
  return instruction ? `${text}\n\n${instruction}` : undefined
}

export function modePlaceholder(mode: ChatMode, botName: string) {
  return i18n.t(`modes.placeholder.${mode}`, { name: botName })
}

const STORAGE_KEY = 'hermesbot-modes'
const isMode = (value: unknown): value is ChatMode => CHAT_MODES.some((mode) => mode.id === value)

/** Each bot’s mode. An unknown value falls back to EXEC, the normal behavior. */
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
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(modes)) } catch { /* storage unavailable */ }
}
