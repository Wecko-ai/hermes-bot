import type { Bot } from '../types'

/** Dernière activité connue, en millisecondes : Bot Chat, autre session ou tâche de fond. */
function activityTime(bot: Bot) {
  return Math.max(Date.parse(bot.timestamp ?? '') || 0, bot.lastActivity ?? 0)
}

export function latestActivity(bot: Bot) {
  const time = activityTime(bot)
  return time ? new Date(time).toISOString() : null
}

const isBusy = (bot: Bot) => bot.status === 'working' || bot.status === 'thinking'

/** Fusionne un roster relu sans perdre l’état local : non-lus, tours lancés ici, animation de fin. */
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
    // La date bouge à chaque étape du travail : un seul non-lu, une fois l’activité retombée.
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

/** Plus récent d’abord. Un bot au travail est actif maintenant, même si sa date n’a pas encore bougé. */
export function compareBotActivity(a: Bot, b: Bot) {
  return Number(isBusy(b)) - Number(isBusy(a)) || activityTime(b) - activityTime(a) || a.name.localeCompare(b.name, 'fr')
}
