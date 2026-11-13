import type { Bot } from '../types'
import type { BotSection } from './bot-manage'
import { compareBotActivity } from './activity'

/** Sort keys from the roster data, never shown as is: only their label follows the language. */
export const UNASSIGNED_SECTION_NAME = 'Non classés'
export const UNASSIGNED_SECTION_ID = 'unassigned'
export const LOCAL_SECTION_NAME = 'Local'
/** Key of the pinned group: cannot collide with a section name, which is free text. */
export const PINNED_GROUP_KEY = '\u0000pinned'

export interface RosterGroup {
  /** Stable key: the section name, `PINNED_GROUP_KEY`, or `activity` for the single list. */
  key: string
  /** Section name for a section, empty for the pinned group and the activity list. */
  section: string
  pinned: boolean
  bots: Bot[]
}

interface RosterGroupOptions {
  /** Pinned slugs, in the order they were pinned. */
  pinned: readonly string[]
  activitySort: boolean
  /** Order of two section names (configuration first, unsorted and local last). */
  compareSections: (a: string, b: string) => number
}

/**
 * The sidebar's groups. Pinned bots come first, in the order they were pinned, in both sorts, and are not
 * repeated below. Then one list by activity, or one group per section.
 */
export function rosterGroups(visible: Bot[], { pinned, activitySort, compareSections }: RosterGroupOptions): RosterGroup[] {
  const bySlug = new Map(visible.map((bot) => [bot.slug, bot]))
  const pinnedBots = [...new Set(pinned)].flatMap((slug) => bySlug.get(slug) ?? [])
  const pinnedSlugs = new Set(pinnedBots.map((bot) => bot.slug))
  const rest = visible.filter((bot) => !pinnedSlugs.has(bot.slug))
  const groups: RosterGroup[] = pinnedBots.length ? [{ key: PINNED_GROUP_KEY, section: '', pinned: true, bots: pinnedBots }] : []
  if (activitySort) {
    if (rest.length) groups.push({ key: 'activity', section: '', pinned: false, bots: [...rest].sort(compareBotActivity) })
    return groups
  }
  const sections = new Map<string, Bot[]>()
  rest.forEach((bot) => sections.set(bot.section, [...(sections.get(bot.section) || []), bot]))
  return [...groups, ...[...sections.entries()].sort(([a], [b]) => compareSections(a, b)).map(([section, bots]) => ({ key: section, section, pinned: false, bots }))]
}

/** The sections a bot can be moved to: those of the roster, in sidebar order, without unsorted and local. */
export function botSections(bots: Bot[], compareSections: (a: string, b: string) => number): BotSection[] {
  const sections = new Map<string, string>()
  for (const bot of bots) {
    if (bot.sectionId === UNASSIGNED_SECTION_ID || bot.section === UNASSIGNED_SECTION_NAME || bot.section === LOCAL_SECTION_NAME || !bot.sectionId || sections.has(bot.sectionId)) continue
    sections.set(bot.sectionId, bot.section)
  }
  return [...sections.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => compareSections(a.name, b.name) || a.name.localeCompare(b.name))
}
