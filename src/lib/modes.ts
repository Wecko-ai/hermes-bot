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

/**
 * Caveman mode (Settings > Conversations): the bot answers in 1 to 3 short lines.
 * Like a work mode, it is an instruction read with the turn: the bot's profile is never changed.
 * It only covers what the bot says in the chat. What it writes elsewhere keeps its normal style.
 * A loose "few words" was not enough: bots kept writing full status reports. The note gives a
 * length, says it overrides the usual format, and shows an example.
 */
const CAVEMAN_NOTE = '[HermesBot style: caveman. For this turn only, the user switched on caveman mode in the app: it overrides your usual reply length and format. Reply in 1 to 3 short lines, under about 50 words: the result first, then only what the user must decide or do. Fragments are fine. No greeting, filler, recap, list of what you checked, headings or bullet lists (unless the user asked for steps or a list), and no closing offer. Example: "Video v2 started, 4 fixes in. Waiting for the render." Keep numbers, names, paths, commands and negations exact, in the user\'s language. Only your chat replies change: your work, files, code, emails, posts and messages to others stay normal. Use full sentences for warnings and irreversible actions.]'

/** What the model reads with caveman mode on: the mode text if there is one, then the style note. */
export function cavemanApiText(text: string, modeText: string | undefined, enabled: boolean) {
  return enabled ? `${modeText ?? text}\n\n${CAVEMAN_NOTE}` : modeText
}

/**
 * Voice mode: the user talks to the bot and hears the reply read aloud. Like caveman, a note read with
 * the turn, never written into the bot's profile, and only for messages spoken in the voice overlay.
 * It replaces the caveman note (both shape the length; the voice one also forbids what cannot be spoken).
 */
const VOICE_NOTE = '[HermesBot voice mode. For this turn only, the user is talking to you by voice in the app, and your reply will be read aloud by a speech synthesizer. Reply like a spoken conversation: 1 to 4 short sentences, under about 60 words, in the user\'s language. No markdown, headings, lists, tables, code, links or emoji in this reply: say it in plain words. If the answer needs something long (code, a document, a list, a link), do it as usual in a file or a message and say in one sentence what you did and where it is. Ask at most one short question at a time. Only your chat reply changes: your work, files, code, emails, posts and messages to others stay normal. Use full sentences for warnings and irreversible actions.]'
const VOICE_CUT_NOTE = '[The user cut your previous spoken reply short: they did not hear the end of it.]'

/** What the model reads for a spoken message: the mode text if there is one, then the voice note. */
export function voiceApiText(text: string, modeText: string | undefined, cutShort = false) {
  return `${modeText ?? text}\n\n${VOICE_NOTE}${cutShort ? `\n${VOICE_CUT_NOTE}` : ''}`
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
