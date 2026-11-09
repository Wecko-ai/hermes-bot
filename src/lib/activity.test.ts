import { describe, expect, it } from 'vitest'
import type { Bot } from '../types'
import { compareBotActivity, latestActivity, mergeRoster } from './activity'

const bot = (slug: string, status: Bot['status'], unread = 0): Bot => ({
  slug, name: slug, role: '', section: '', sectionId: '', model: '', status,
  preview: '', timestamp: '2025-01-06T12:00:00Z', unread, hidden: false,
})

describe('relecture du roster', () => {
  const at = (slug: string, timestamp: string, status: Bot['status'] = 'idle', preview = 'Texte'): Bot => ({ ...bot(slug, status), timestamp, preview })

  it('compte un non-lu quand un autre bot a parlé et s’est arrêté, pas sur le bot ouvert ni sur un silence', () => {
    const old = [at('a', '2025-01-06T12:00:00Z'), at('b', '2025-01-06T12:00:00Z'), at('c', '2025-01-06T12:00:00Z')]
    const fresh = [at('a', '2025-01-06T12:05:00Z'), at('b', '2025-01-06T12:05:00Z'), at('c', '2025-01-06T12:05:00Z', 'idle', '')]
    const moving = mergeRoster(old, fresh, 'b', () => false)
    expect(moving.map((item) => item.unread)).toEqual([0, 0, 0])
    expect(mergeRoster(moving, fresh, 'b', () => false).map((item) => item.unread)).toEqual([1, 0, 0])
  })

  it('ne compte rien pendant le travail, puis un seul non-lu à la fin', () => {
    let bots = [at('a', '2025-01-06T12:00:00Z')]
    for (const minute of ['05', '10', '15']) {
      bots = mergeRoster(bots, [at('a', `2025-01-06T12:${minute}:00Z`, 'working')], '', () => false)
      expect(bots[0].unread).toBe(0)
    }
    const end = [at('a', '2025-01-06T12:15:00Z')]
    bots = mergeRoster(bots, end, '', () => false)
    expect(bots[0].unread).toBe(1)
    expect(mergeRoster(bots, end, '', () => false)[0].unread).toBe(1)
  })

  it('ne compte pas une date qui bouge encore, même sans statut de travail', () => {
    let bots = [at('a', '2025-01-06T12:00:00Z')]
    for (const minute of ['05', '10']) {
      bots = mergeRoster(bots, [at('a', `2025-01-06T12:${minute}:00Z`)], '', () => false)
      expect(bots[0].unread).toBe(0)
    }
  })

  it('garde un tour lancé ici, et suit le travail vu par la gateway', () => {
    const old = [at('ici', '2025-01-06T12:00:00Z', 'working'), at('fini', '2025-01-06T12:00:00Z', 'working')]
    const fresh = [at('ici', '2025-01-06T12:00:00Z'), at('fini', '2025-01-06T12:00:00Z')]
    expect(mergeRoster(old, fresh, '', (slug) => slug === 'ici').map((item) => item.status)).toEqual(['working', 'idle'])
    expect(mergeRoster([at('r', '2025-01-06T12:00:00Z')], [at('r', '2025-01-06T12:00:00Z', 'working')], '', () => false)[0].status).toBe('working')
  })
})

describe('tri par activité', () => {
  const dated = (slug: string, timestamp: string | null, unread = 0): Bot => ({ ...bot(slug, 'idle', unread), timestamp })

  it('met la date la plus récente en premier, même face à un ancien non-lu', () => {
    const bots = [dated('vieux', '2025-01-06T09:00:00Z', 3), dated('jamais', null), dated('recent', '2025-01-06T12:00:00Z')]
    expect(bots.sort(compareBotActivity).map((item) => item.slug)).toEqual(['recent', 'vieux', 'jamais'])
  })

  it('place un bot au travail en tête, quelle que soit sa date', () => {
    const bots = [dated('recent', '2025-01-06T12:00:00Z'), { ...dated('travail', '2024-12-30T12:00:00Z'), status: 'working' as const }]
    expect(bots.sort(compareBotActivity).map((item) => item.slug)).toEqual(['travail', 'recent'])
  })

  it('compte une tâche de fond comme activité', () => {
    const worker = { ...dated('worker', '2025-01-06T09:00:00Z'), lastActivity: Date.parse('2025-01-06T13:00:00Z') }
    const bots = [dated('chat', '2025-01-06T12:00:00Z'), worker]
    expect(bots.sort(compareBotActivity).map((item) => item.slug)).toEqual(['worker', 'chat'])
    expect(latestActivity(worker)).toBe('2025-01-06T13:00:00.000Z')
  })

  it('survit à une date illisible et à une absence de date', () => {
    expect(latestActivity(dated('illisible', 'pas une date'))).toBeNull()
    expect(latestActivity(dated('jamais', null))).toBeNull()
  })
})
