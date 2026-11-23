import type { Bot } from '../types'
import { PINNED_GROUP_KEY, type RosterGroup } from './roster-groups'

export interface UiLayout {
  sectionOrder: string[]
  /** Per-section bot slug order (sectionId or section name key). */
  rosterOrder: Record<string, string[]>
}

const emptyLayout = (): UiLayout => ({ sectionOrder: [], rosterOrder: {} })

export function normalizeLayout(value: unknown): UiLayout {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const sectionOrder = Array.isArray(raw.sectionOrder) ? raw.sectionOrder.filter((item): item is string => typeof item === 'string' && item !== '') : []
  const rosterOrder: Record<string, string[]> = {}
  if (raw.rosterOrder && typeof raw.rosterOrder === 'object' && !Array.isArray(raw.rosterOrder)) {
    for (const [key, list] of Object.entries(raw.rosterOrder as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue
      const slugs = list.filter((item): item is string => typeof item === 'string' && item !== '')
      if (slugs.length) rosterOrder[key] = slugs
    }
  }
  return { sectionOrder, rosterOrder }
}

export function applyRosterOrder(groups: RosterGroup[], rosterOrder: Record<string, string[]>): RosterGroup[] {
  if (!Object.keys(rosterOrder).length) return groups
  return groups.map((group) => {
    if (group.pinned || group.key === PINNED_GROUP_KEY || group.key === 'activity') return group
    const order = rosterOrder[group.section] || rosterOrder[group.key]
    if (!order?.length) return group
    const rank = new Map(order.map((slug, index) => [slug, index]))
    return {
      ...group,
      bots: [...group.bots].sort((a, b) => (rank.get(a.slug) ?? 999) - (rank.get(b.slug) ?? 999) || a.name.localeCompare(b.name)),
    }
  })
}

export function layoutFromGroups(groups: RosterGroup[], sectionOrder: string[]): UiLayout {
  const rosterOrder: Record<string, string[]> = {}
  for (const group of groups) {
    if (group.pinned || group.key === 'activity' || !group.section) continue
    rosterOrder[group.section] = group.bots.map((bot) => bot.slug)
  }
  return { sectionOrder: [...sectionOrder], rosterOrder }
}

export function reorderSections(current: string[], fromIndex: number, toIndex: number) {
  const next = [...current]
  const [item] = next.splice(fromIndex, 1)
  if (!item) return current
  next.splice(toIndex, 0, item)
  return next
}

export function reorderBotsInSection(bots: Bot[], fromSlug: string, toSlug: string): string[] {
  const slugs = bots.map((bot) => bot.slug)
  const from = slugs.indexOf(fromSlug)
  const to = slugs.indexOf(toSlug)
  if (from < 0 || to < 0 || from === to) return slugs
  slugs.splice(from, 1)
  slugs.splice(to, 0, fromSlug)
  return slugs
}

export async function loadUiLayout(): Promise<UiLayout> {
  try {
    const response = await fetch('/api/ui-layout', { credentials: 'same-origin' })
    if (!response.ok) return emptyLayout()
    return normalizeLayout(await response.json())
  } catch {
    return emptyLayout()
  }
}

export async function saveUiLayout(layout: UiLayout): Promise<boolean> {
  try {
    const response = await fetch('/api/ui-layout', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(layout),
    })
    return response.ok
  } catch {
    return false
  }
}