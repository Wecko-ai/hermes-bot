import { describe, expect, it, beforeEach, vi } from 'vitest'
import { DEFAULT_ROOM_ROUTING, gatewayContextPatch, roomRoutingMode, roomSendAllowed, setRoomRoutingMode } from './room-routing'

const store = new Map<string, string>()
const storage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => { store.set(key, value) },
  removeItem: (key: string) => { store.delete(key) },
  clear: () => { store.clear() },
  key: () => null,
  length: 0,
}

describe('room-routing', () => {
  beforeEach(() => {
    store.clear()
    vi.stubGlobal('localStorage', storage)
  })

  it('defaults new rooms to mentions-only enforcement', () => {
    expect(roomRoutingMode('r1', null)).toBe(DEFAULT_ROOM_ROUTING)
    expect(roomSendAllowed('hello team', [], [{ slug: 'a', name: 'A', role: '', section: '', sectionId: '', model: '', status: 'idle', preview: '', timestamp: null, unread: 0, hidden: false }], 'mentions')).toBe(false)
    expect(roomSendAllowed('hello @a', [], [{ slug: 'a', name: 'A', role: '', section: '', sectionId: '', model: '', status: 'idle', preview: '', timestamp: null, unread: 0, hidden: false }], 'mentions')).toBe(true)
  })

  it('maps facilitator to gateway lead routing', () => {
    setRoomRoutingMode('r2', 'facilitator')
    expect(roomRoutingMode('r2', null)).toBe('facilitator')
    expect(gatewayContextPatch('facilitator', 'nova')).toEqual({ routing: 'lead', lead_member_id: 'nova' })
  })

  it('maps everyone to gateway everyone routing', () => {
    expect(gatewayContextPatch('everyone', '')).toEqual({ routing: 'everyone', lead_member_id: '' })
  })
})