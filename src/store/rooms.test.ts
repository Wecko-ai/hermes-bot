import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Room, RoomEvent, RoomSnapshot } from '../lib/rooms'
import {
  clearRoomCancel,
  clearRoomDisband,
  clearRoomRename,
  resetRoomStore,
  roomCancelId,
  roomDisbandCancelId,
  roomRenameEventId,
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

  it('applySnapshot keeps the same state when the room, driver and log tail are unchanged', () => {
    const initial = room('room-1', { updated_at: 4, latest_seq: 2 })
    const driver = { running: false, working: false, blocked: false, counts: { idle: 1 }, pending_actions: [] as Record<string, unknown>[] }
    const events = [event(1), event(2)]
    const { applySnapshot } = useRoomStore.getState()
    applySnapshot(initial.room_id, snapshot(initial, events, { driver, cursor: 2 }))
    const before = useRoomStore.getState()
    applySnapshot(initial.room_id, snapshot({ ...initial }, events.map((item) => ({ ...item })), {
      driver: { running: false, working: false, blocked: false, counts: { idle: 1 }, pending_actions: [] },
      cursor: 2,
    }))
    expect(useRoomStore.getState()).toBe(before)
    applySnapshot(initial.room_id, snapshot(initial, events, {
      driver: { ...driver, working: true },
      cursor: 2,
    }))
    expect(useRoomStore.getState()).not.toBe(before)
    expect(useRoomStore.getState().cache['room-1'].driver?.working).toBe(true)
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

  it('removeRoom drops the room, its cache and pending state, and leaves the room view', () => {
    const { applySnapshot, removeRoom, selectRoom, setPendingSend, setRooms, setSendFlight } = useRoomStore.getState()
    const doomed = room('room-1')
    setRooms([doomed, room('room-2')])
    applySnapshot('room-1', snapshot(doomed, [event(1)]))
    selectRoom('room-1')
    setPendingSend('room-1', { eventId: 'e', threadId: 't', text: 'x' })
    setSendFlight('room-1', true)
    removeRoom('room-1')
    const state = useRoomStore.getState()
    expect(state.rooms.map((item) => item.room_id)).toEqual(['room-2'])
    expect(state.cache['room-1']).toBeUndefined()
    expect(state.pendingSends['room-1']).toBeUndefined()
    expect(state.sendFlights['room-1']).toBeUndefined()
    expect(state.selectedRoomId).toBe('')
  })

  it('removeRoom keeps another open room open', () => {
    const { removeRoom, selectRoom, setRooms } = useRoomStore.getState()
    setRooms([room('room-1'), room('room-2')])
    selectRoom('room-2')
    removeRoom('room-1')
    expect(useRoomStore.getState().selectedRoomId).toBe('room-2')
  })

  it('patchRoom applies a new name to the list and the cache and keeps the members', () => {
    const { applySnapshot, patchRoom, setRooms } = useRoomStore.getState()
    const member = { member_id: 'orion', profile: 'orion', handle: 'orion' }
    const original = room('room-1', { members: [member] })
    setRooms([original])
    applySnapshot('room-1', snapshot(original, [event(1)]))
    patchRoom(room('room-1', { name: 'Renamed', members: [], updated_at: 9 }))
    const state = useRoomStore.getState()
    expect(state.rooms[0]).toMatchObject({ name: 'Renamed', updated_at: 9, members: [member] })
    expect(state.cache['room-1'].room).toMatchObject({ name: 'Renamed', members: [member] })
  })

  it('keeps one rename event id per name and one disband cancel id until cleared', () => {
    const first = roomRenameEventId('room-1', 'A')
    expect(roomRenameEventId('room-1', 'A')).toBe(first)
    expect(roomRenameEventId('room-1', 'B')).not.toBe(first)
    clearRoomRename('room-1')
    expect(roomRenameEventId('room-1', 'B')).toBeTruthy()
    const cancel = roomDisbandCancelId('room-1')
    expect(roomDisbandCancelId('room-1')).toBe(cancel)
    expect(roomDisbandCancelId('room-2')).not.toBe(cancel)
    clearRoomDisband('room-1')
    expect(roomDisbandCancelId('room-1')).not.toBe(cancel)
  })
})
