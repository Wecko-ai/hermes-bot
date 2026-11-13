import type { Bot } from '../types'
import { i18n } from '../i18n'
import { BotManageError, moveBotToSection, removeBot, renameBot, setBotHidden, type BotManageClient, type BotSection } from './bot-manage'
import { UNASSIGNED_SECTION_ID, UNASSIGNED_SECTION_NAME } from './roster-groups'
import { getSettings, updateSettings, withPinned } from './settings'

/** What the bot menu asks for. Rename and delete come from their dialogs, once confirmed. */
export type BotAction =
  | { type: 'pin' }
  | { type: 'unpin' }
  | { type: 'move'; section: BotSection | null }
  | { type: 'markRead' }
  | { type: 'rename'; title: string }
  | { type: 'hide' }
  | { type: 'show' }
  | { type: 'delete' }

export interface BotActionContext {
  /** Null in the demo: the actions that write to Hermes then only change the roster on screen. */
  client: BotManageClient | null
  patchBot: (slug: string, changes: Partial<Bot>) => void
  dropBot: (slug: string) => void
  /** Re-reads the roster after a write, so the change shows as Hermes holds it. */
  refresh: () => Promise<void>
}

/** Local changes the roster shows at once, before the re-read confirms them. */
function localChanges(bot: Bot, action: BotAction): Partial<Bot> | null {
  switch (action.type) {
    case 'markRead': return { unread: 0, seenAt: bot.timestamp ?? bot.seenAt ?? null }
    case 'move': return { section: action.section?.name ?? UNASSIGNED_SECTION_NAME, sectionId: action.section?.id ?? UNASSIGNED_SECTION_ID }
    case 'rename': return { name: action.title.trim() }
    case 'hide': return { hidden: true }
    case 'show': return { hidden: false }
    default: return null
  }
}

/**
 * Runs one action. Pin and mark as read stay on this Mac; the others write the bot's card in Hermes, then
 * re-read the roster. Rejects with a `BotManageError` the caller turns into a message (`botActionError`).
 */
export async function runBotAction(bot: Bot, action: BotAction, context: BotActionContext): Promise<void> {
  if (action.type === 'pin' || action.type === 'unpin') {
    updateSettings({ pinnedBots: withPinned(getSettings().pinnedBots, bot.slug, action.type === 'pin') })
    return
  }
  const { client } = context
  if (action.type !== 'markRead' && client) {
    if (action.type === 'move') await moveBotToSection(client, bot.slug, action.section)
    else if (action.type === 'rename') await renameBot(client, bot.slug, action.title)
    else if (action.type === 'hide' || action.type === 'show') await setBotHidden(client, bot.slug, action.type === 'hide')
    else if (action.type === 'delete') await removeBot(client, bot.slug)
  }
  if (action.type === 'delete') {
    context.dropBot(bot.slug)
    if (getSettings().pinnedBots.includes(bot.slug)) updateSettings({ pinnedBots: withPinned(getSettings().pinnedBots, bot.slug, false) })
  } else {
    const changes = localChanges(bot, action)
    if (changes) context.patchBot(bot.slug, changes)
  }
  // The write landed: a failed re-read only delays what the next one shows.
  if (client && action.type !== 'markRead') await context.refresh().catch(() => undefined)
}

/** A readable message for a failed action, in the interface language. */
export function botActionError(error: unknown): string {
  if (error instanceof BotManageError) {
    return error.reason === 'refused'
      ? i18n.t('botMenu.errors.refused', { message: error.message })
      : i18n.t(`botMenu.errors.${error.reason}`)
  }
  return i18n.t('botMenu.errors.offline')
}
