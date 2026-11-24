import { describe, expect, it } from 'vitest'
import { isGatewayRevision, maxRowId, minRowId, shouldTryDelta, stitchHistory, withJournalEntry, withoutJournalEntry } from './replica'

const row = (id: string, content: string) => ({ id, content })

describe('replica sync', () => {
  it('keeps the replica when nothing changed and stitches a delta in place', () => {
    const cached = [row('1', 'a'), row('2', 'b'), row('local-9', 'pending')]
    expect(stitchHistory(cached, [], 'unchanged')).toBe(cached)
    const stitched = stitchHistory(cached, [row('2', 'b2'), row('3', 'c')], 'delta')
    expect(stitched.map((item) => item.content)).toEqual(['a', 'b2', 'pending', 'c'])
    expect(stitchHistory(cached, [row('9', 'only')], 'replaced').map((item) => item.id)).toEqual(['9'])
  })

  it('reads numeric row ids and ignores local ones', () => {
    const messages = [{ id: 'local-1' }, { id: '4' }, { id: '12' }]
    expect(maxRowId(messages)).toBe(12)
    expect(minRowId(messages)).toBe(4)
    expect(isGatewayRevision('v1|abc|1|1|0')).toBe(true)
    expect(isGatewayRevision('local|1')).toBe(false)
  })

  it('retries a rejected gateway after ten minutes and keeps one journal id', () => {
    expect(shouldTryDelta({ historyDelta: false, checkedAt: 1_000 }, 1_000 + 60_000)).toBe(false)
    expect(shouldTryDelta({ historyDelta: false, checkedAt: 1_000 }, 1_000 + 11 * 60_000)).toBe(true)
    expect(shouldTryDelta(null)).toBe(true)
    const journal = withJournalEntry([], { id: 'sub', profile: 'alpha', sessionId: 's', text: 'hi', images: [], at: 1 })
    const again = withJournalEntry(journal, { id: 'sub', profile: 'alpha', sessionId: 's', text: 'hi', images: [], at: 2 })
    expect(again).toHaveLength(1)
    expect(again[0].at).toBe(2)
    expect(withoutJournalEntry(again, 'sub')).toEqual([])
  })
})
