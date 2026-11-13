/**
 * The first turn of a bot created in this app: it introduces itself and asks the user for its role.
 *
 * The history keeps one short sentence on the user's side (`text`): other apps show it as the user's message,
 * this one keeps it out of the thread and the roster (Activity only). The model reads the real instruction in
 * `api_text`, for this turn only. Text sent to the model stays in English.
 *
 * No imports: `hermes.ts` reads the matcher from here.
 */

/** At most 60 characters: Hermes cuts a session preview there. */
export const BOT_KICKOFF_TEXT = 'New bot: introduce yourself and ask me what your role is.'

/** A message of the history that is the kickoff sentence. */
export const isKickoffMessage = (content: string) => content.trim() === BOT_KICKOFF_TEXT

/** A session preview that is the kickoff sentence, whole or cut by Hermes (`…` or `...`). */
export function isKickoffPreview(preview: string) {
  const text = preview.trim()
  if (text === BOT_KICKOFF_TEXT) return true
  const cut = /(?:\.\.\.|…)$/.exec(text)
  return Boolean(cut) && text.length > 12 && BOT_KICKOFF_TEXT.startsWith(text.slice(0, -cut![0].length).trimEnd())
}

/** Free text the user typed, quoted on one line for the model. */
const quoted = (value: string) => JSON.stringify(value.replace(/\s+/g, ' ').trim())

export interface KickoffBot {
  /** Display name. */
  title: string
  /** Hermes profile name. */
  slug: string
  /** Interface language: the bot greets the user in it. */
  language: 'en' | 'fr'
}

/** What the model reads for the first turn: the sentence, then the instruction. */
export function kickoffApiText({ title, slug, language }: KickoffBot) {
  const tongue = language === 'fr' ? 'French' : 'English'
  return `${BOT_KICKOFF_TEXT}\n\n[HermesBot onboarding: the user just created you in HermesBot. Your name is ${quoted(title)} and your Hermes profile is ${quoted(slug)}. This is your first conversation with them. Greet the user in two or three sentences, in ${tongue}, and ask what role they want you to have: what you should take care of for them. When they answer, confirm in a few lines what you understood, then record that role durably with the means your runtime gives you (your memory, and your profile instructions in SOUL.md), so you still know it in later conversations. Do nothing else until your role is known.]`
}

/**
 * The SOUL.md a bot created here is born with: who it is, as Hermes Desktop writes it, and a role still to set.
 * The kickoff instruction only lives in its first turn; this section keeps the next step in front of the bot.
 */
export function newBotSoul({ title, slug }: Pick<KickoffBot, 'title' | 'slug'>) {
  const name = title.replace(/\s+/g, ' ').trim() || slug
  return [
    `# ${name}`,
    '',
    `You are ${name}, a persistent named agent (profile \`${slug}\`) on this machine.`,
    'You keep your own memory, skills, and conversation history across sessions.',
    '',
    '## Role',
    '',
    'Not set yet: the user will tell you what your role is. When they do, confirm in a few lines what you understood, then record it durably: save it to your memory, and replace this section of your SOUL.md with your role.',
  ].join('\n')
}
