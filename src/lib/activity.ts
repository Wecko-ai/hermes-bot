import type { Bot } from '../types'
import { locale } from '../i18n'

/** Latest known activity, in milliseconds: Bot Chat, another session or a background task. */
function activityTime(bot: Bot) {
  return Math.max(Date.parse(bot.timestamp ?? '') || 0, bot.lastActivity ?? 0)
}

export function latestActivity(bot: Bot) {
  const time = activityTime(bot)
  return time ? new Date(time).toISOString() : null
}

const isBusy = (bot: Bot) => bot.status === 'working' || bot.status === 'thinking'

/** Merges a re-read roster without losing local state: unread counts, turns started here, end animation. */
export function mergeRoster(current: Bot[], fresh: Bot[], selected: string, isRunning: (slug: string) => boolean): Bot[] {
  const previous = new Map(current.map((bot) => [bot.slug, bot]))
  return fresh.map((bot) => {
    const old = previous.get(bot.slug)
    if (!old) return bot
    const newer = (bot.timestamp ? Date.parse(bot.timestamp) : 0) > (old.timestamp ? Date.parse(old.timestamp) : 0)
    const keepLocal = old.status === 'done' || isRunning(bot.slug)
    const status = bot.status === 'idle' && keepLocal ? old.status : bot.status
    const timestamp = newer ? bot.timestamp : old.timestamp
    const seenAt = old.seenAt ?? old.timestamp
    // The date moves at every step of the work: a single unread, once activity has settled.
    const settled = (timestamp ? Date.parse(timestamp) : 0) > (seenAt ? Date.parse(seenAt) : 0)
      && !newer && status !== 'working' && status !== 'thinking'
    const isOpen = bot.slug === selected
    return {
      ...bot,
      status,
      preview: bot.preview || old.preview,
      timestamp,
      seenAt: settled || isOpen ? timestamp : seenAt,
      unread: old.unread + (settled && bot.preview && !isOpen ? 1 : 0),
    }
  })
}

/** Most recent first. A working bot is active now, even if its date hasn’t moved yet. */
export function compareBotActivity(a: Bot, b: Bot) {
  return Number(isBusy(b)) - Number(isBusy(a)) || activityTime(b) - activityTime(a) || a.name.localeCompare(b.name, locale())
}
