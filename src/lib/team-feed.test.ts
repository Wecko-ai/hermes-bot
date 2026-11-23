import { describe, expect, it } from 'vitest'
import { exchangesFromMessages, teamFeedFromCaches } from './team-feed'

describe('team-feed', () => {
  it('collects agent rows from loaded chats', () => {
    const rows = exchangesFromMessages('iris', [
      { id: '1', role: 'system', content: 'done', createdAt: '2026-01-01T00:00:00.000Z', agent: { kind: 'message', from: 'nova', to: 'iris', text: 'Ping' } },
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ from: 'nova', to: 'iris' })
  })

  it('merges caches newest first without duplicates', () => {
    const feed = teamFeedFromCaches({
      nova: [{ id: 'a', role: 'system', content: 'x', createdAt: '2026-01-02T00:00:00.000Z', agent: { kind: 'message', from: 'nova', to: 'iris', text: 'Hi' } }],
      iris: [{ id: 'b', role: 'system', content: 'y', createdAt: '2026-01-03T00:00:00.000Z', agent: { kind: 'reply', from: 'iris', to: 'nova', text: 'Yo' } }],
    }, [
      { slug: 'nova', name: 'Nova', role: '', section: '', sectionId: '', model: '', status: 'idle', preview: '', timestamp: null, unread: 0, hidden: false },
      { slug: 'iris', name: 'Iris', role: '', section: '', sectionId: '', model: '', status: 'idle', preview: '', timestamp: null, unread: 0, hidden: false },
    ])
    expect(feed[0].from).toBe('iris')
    expect(feed).toHaveLength(2)
  })
})