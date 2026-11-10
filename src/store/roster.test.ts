import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../types'
import { DONE_VISIBLE_MS, patchBot, publishedWork, resetRosterStore, useRosterStore } from './roster'

const bot = (slug: string, changes: Partial<Bot> = {}): Bot => ({
  slug, name: slug, role: '', section: '', sectionId: '', model: '', status: 'idle', preview: '', timestamp: null, unread: 0, hidden: false, ...changes,
})
const status = (slug: string) => useRosterStore.getState().bots.find((item) => item.slug === slug)?.status

describe('roster', () => {
  beforeEach(() => { vi.useFakeTimers(); resetRosterStore() })
  afterEach(() => vi.useRealTimers())

  it('patchBot ne change que le bot visé', () => {
    const list = [bot('a'), bot('b')]
    const next = patchBot(list, 'a', { unread: 3 })
    expect(next[0].unread).toBe(3)
    expect(next[1]).toBe(list[1])
  })

  it('setBots et setSelected acceptent une valeur ou une fonction', () => {
    const { setBots, setSelected } = useRosterStore.getState()
    setBots([bot('a')])
    setBots((current) => [...current, bot('b')])
    setSelected('a')
    setSelected((current) => current || 'b')
    expect(useRosterStore.getState().bots.map((item) => item.slug)).toEqual(['a', 'b'])
    expect(useRosterStore.getState().selected).toBe('a')
  })

  it('« Terminé » dure 5 s, puis le bot revient au repos', () => {
    const { setBots, markDone } = useRosterStore.getState()
    setBots([bot('a', { status: 'working' })])
    markDone('a')
    expect(status('a')).toBe('done')
    vi.advanceTimersByTime(DONE_VISIBLE_MS - 1)
    expect(status('a')).toBe('done')
    vi.advanceTimersByTime(1)
    expect(status('a')).toBe('idle')
  })

  it('un worker actif garde le bot au travail, sans minuterie', () => {
    const { setBots, markDone } = useRosterStore.getState()
    setBots([bot('a', { status: 'idle', workerActive: true })])
    markDone('a')
    expect(status('a')).toBe('working')
    vi.advanceTimersByTime(DONE_VISIBLE_MS * 2)
    expect(status('a')).toBe('working')
  })

  it('un nouveau tour annule la minuterie « Terminé » en attente', () => {
    const { setBots, markDone, clearDoneTimer, updateBot } = useRosterStore.getState()
    setBots([bot('a')])
    markDone('a')
    clearDoneTimer('a')
    updateBot('a', { status: 'working' })
    vi.advanceTimersByTime(DONE_VISIBLE_MS * 2)
    expect(status('a')).toBe('working')
  })

  it('publie les résumés seulement quand ils changent', () => {
    const { applyWork, publishWork } = useRosterStore.getState()
    publishWork()
    const empty = useRosterStore.getState().workSummaries
    publishWork()
    expect(useRosterStore.getState().workSummaries).toBe(empty)
    applyWork('a', { type: 'message.start' })
    publishWork()
    const published = useRosterStore.getState().workSummaries
    expect(Object.keys(published)).toEqual(['a'])
    publishWork()
    expect(useRosterStore.getState().workSummaries).toBe(published)
    expect(publishedWork(published, { ...published })).toBe(published)
  })

  it('retient le dernier numéro d’événement lu par bot', () => {
    const { getWorkSeq, setWorkSeq } = useRosterStore.getState()
    expect(getWorkSeq('a')).toBe(0)
    setWorkSeq('a', 42)
    expect(getWorkSeq('a')).toBe(42)
  })
})
