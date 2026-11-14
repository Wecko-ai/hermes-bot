import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Room, RoomEvent, RoomSnapshot } from '../lib/rooms'
import {
  clearRoomCancel,
  resetRoomStore,
  roomCancelId,
  useRoomStore,
} from './rooms'

const room = (roomId = 'room-1', changes: Partial<Room> = {}): Room => ({
  room_id: roomId,
  name: roomId,
  members: [],
  authority_gateway_id: 'gateway-1',
  authority_epoch: 1,
  revision: 1,
  created_at: 1,
  updated_at: 1,
  latest_seq: 0,
  ...changes,
})

const event = (
  seq: number,
  eventId = `event-${seq}`,
  text = `message ${seq}`,
  epoch = 1,
): RoomEvent => ({
  room_id: 'room-1',
  seq,
  event_id: eventId,
  kind: 'message.member',
  actor: { kind: 'member', id: 'orion' },
  authority_epoch: epoch,
  payload: { text },
  created_at: seq,
})

const snapshot = (
  roomValue: Room,
  events: RoomEvent[],
  changes: Partial<RoomSnapshot> = {},
): RoomSnapshot => ({
  room: roomValue,
  driver: null,
  context: null,
  events,
  cursor: events.at(-1)?.seq || 0,
  latestSeq: events.at(-1)?.seq || 0,
  epoch: roomValue.authority_epoch,
  reset: false,
  ...changes,
})

describe('room store', () => {
  beforeEach(resetRoomStore)
  afterEach(() => vi.restoreAllMocks())

  it('applySnapshot merges and deduplicates events, updates the room, and clears loading state', () => {
    const initialRoom = room()
    const { applySnapshot, setRoomError, setRoomLoading, setRooms } = useRoomStore.getState()
    setRooms([initialRoom])
    applySnapshot(initialRoom.room_id, snapshot(initialRoom, [event(2)]))
    setRoomError(initialRoom.room_id, 'stale error')
    setRoomLoading(initialRoom.room_id, true)

    const updatedRoom = room('room-1', { name: 'Renamed', updated_at: 2, latest_seq: 2 })
    applySnapshot(initialRoom.room_id, snapshot(updatedRoom, [
      event(1),
      event(2, 'event-2', 'replacement'),
    ]))

    const state = useRoomStore.getState()
    expect(state.cache['room-1'].events.map((item) => [item.event_id, item.payload.text])).toEqual([
      ['event-1', 'message 1'],
      ['event-2', 'replacement'],
    ])
    expect(state.cache['room-1']).toMatchObject({
      room: updatedRoom,
      cursor: 2,
      epoch: 1,
      loading: false,
      error: '',
    })
    expect(state.rooms).toEqual([updatedRoom])
  })

  it('applySnapshot replaces the log on an epoch change or an explicit reset', () => {
    const initialRoom = room()
    const { applySnapshot } = useRoomStore.getState()
    applySnapshot(initialRoom.room_id, snapshot(initialRoom, [event(1, 'old')]))

    const newEpochRoom = room('room-1', { authority_epoch: 2 })
    applySnapshot(initialRoom.room_id, snapshot(newEpochRoom, [event(1, 'new-epoch', 'new epoch', 2)]))
    expect(useRoomStore.getState().cache['room-1'].events.map((item) => item.event_id)).toEqual(['new-epoch'])

    applySnapshot(initialRoom.room_id, snapshot(newEpochRoom, [event(2, 'fresh', 'fresh log', 2)], { reset: true }))
    expect(useRoomStore.getState().cache['room-1'].events.map((item) => item.event_id)).toEqual(['fresh'])
  })

  it('pending sends are isolated by room and clear only their own entry', () => {
    const { setPendingSend, setSendFlight } = useRoomStore.getState()
    const first = { eventId: 'event-a', threadId: 'thread-a', text: 'A' }
    const second = { eventId: 'event-b', threadId: 'thread-b', text: 'B' }
    setPendingSend('room-a', first)
    setPendingSend('room-b', second)
    setSendFlight('room-a', true)
    setSendFlight('room-b', true)

    setPendingSend('room-a', null)
    setSendFlight('room-a', false)
    expect(useRoomStore.getState().pendingSends).toEqual({ 'room-b': second })
    expect(useRoomStore.getState().sendFlights).toEqual({ 'room-a': false, 'room-b': true })

    setPendingSend('room-b', null)
    expect(useRoomStore.getState().pendingSends).toEqual({})
  })

  it('stop cancellation keeps one identity per room until cleared or reset', () => {
    const randomUUID = vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000001')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000002')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000003')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000004')

    const first = roomCancelId('room-a')
    expect(roomCancelId('room-a')).toBe(first)
    const other = roomCancelId('room-b')
    expect(other).not.toBe(first)

    clearRoomCancel('room-a')
    expect(roomCancelId('room-a')).not.toBe(first)
    expect(roomCancelId('room-b')).toBe(other)

    resetRoomStore()
    expect(roomCancelId('room-b')).not.toBe(other)
    expect(randomUUID).toHaveBeenCalledTimes(4)
  })
})
