import { describe, expect, it } from 'vitest'
import type { Bot } from '../types'
import { applyRosterOrder, normalizeLayout, reorderBotsInSection, reorderSections } from './sidebar-layout'
import { rosterGroups } from './roster-groups'

const bot = (slug: string, section: string): Bot => ({
  slug, name: slug, role: '', section, sectionId: section, model: '', status: 'idle', preview: '', timestamp: null, unread: 0, hidden: false,
})

describe('sidebar-layout', () => {
  it('normalizes layout from the server', () => {
    expect(normalizeLayout({ sectionOrder: ['A', 3, ''], rosterOrder: { A: ['b', 'a', ''] } })).toEqual({
      sectionOrder: ['A'],
      rosterOrder: { A: ['b', 'a'] },
    })
  })

  it('applies stored slug order inside a section', () => {
    const groups = rosterGroups([bot('a', 'Team'), bot('b', 'Team')], { pinned: [], activitySort: false, compareSections: (x, y) => x.localeCompare(y) })
    const ordered = applyRosterOrder(groups, { Team: ['b', 'a'] })
    expect(ordered[0]?.bots.map((item) => item.slug)).toEqual(['b', 'a'])
  })

  it('reorders sections and bots', () => {
    expect(reorderSections(['A', 'B', 'C'], 0, 2)).toEqual(['B', 'C', 'A'])
    expect(reorderBotsInSection([bot('a', 'S'), bot('b', 'S'), bot('c', 'S')], 'c', 'a')).toEqual(['c', 'a', 'b'])
  })
})