import { describe, expect, it } from 'vitest'
import type { Bot } from '../types'
import { botSections, PINNED_GROUP_KEY, rosterGroups } from './roster-groups'
import { compareSections } from './app-config'

const bot = (slug: string, section: string, sectionId: string, minutesAgo: number): Bot => ({
  slug, name: slug, role: '', section, sectionId, model: 'm', status: 'idle', preview: '',
  timestamp: new Date(Date.now() - minutesAgo * 60_000).toISOString(), unread: 0, hidden: false,
})

const order = compareSections([], ['Non classés', 'Local'])
const bots = [
  bot('orion', 'Build', 'sec-build', 30),
  bot('iris', 'Build', 'sec-build', 5),
  bot('nova', 'Home', 'sec-home', 1),
  bot('vega', 'Non classés', 'unassigned', 10),
  bot('local:ollama', 'Local', 'local', 60),
]
const shape = (groups: ReturnType<typeof rosterGroups>) => groups.map((group) => [group.key, group.bots.map((item) => item.slug).join()])

describe('groupes de la barre latérale', () => {
  it('sans épingle : une section par groupe, non classés et local à la fin', () => {
    expect(shape(rosterGroups(bots, { pinned: [], activitySort: false, compareSections: order }))).toEqual([
      ['Build', 'orion,iris'], ['Home', 'nova'], ['Non classés', 'vega'], ['Local', 'local:ollama'],
    ])
  })

  it('met les bots épinglés en tête, dans l’ordre d’épinglage, sans les répéter dessous', () => {
    const groups = rosterGroups(bots, { pinned: ['nova', 'orion'], activitySort: false, compareSections: order })
    expect(shape(groups)).toEqual([
      [PINNED_GROUP_KEY, 'nova,orion'], ['Build', 'iris'], ['Non classés', 'vega'], ['Local', 'local:ollama'],
    ])
    expect(groups[0].pinned).toBe(true)
  })

  it('garde le groupe épinglé en tête aussi dans le classement par activité', () => {
    expect(shape(rosterGroups(bots, { pinned: ['orion'], activitySort: true, compareSections: order }))).toEqual([
      [PINNED_GROUP_KEY, 'orion'], ['activity', 'nova,iris,vega,local:ollama'],
    ])
  })

  it('ignore une épingle sur un bot absent ou filtré, et les doublons', () => {
    expect(shape(rosterGroups(bots.slice(0, 2), { pinned: ['gone', 'iris', 'iris'], activitySort: true, compareSections: order }))).toEqual([
      [PINNED_GROUP_KEY, 'iris'], ['activity', 'orion'],
    ])
    expect(rosterGroups([], { pinned: ['iris'], activitySort: true, compareSections: order })).toEqual([])
  })

  it('propose les sections du roster, sans non classés ni local, une fois chacune', () => {
    expect(botSections(bots, order)).toEqual([{ id: 'sec-build', name: 'Build' }, { id: 'sec-home', name: 'Home' }])
  })
})
