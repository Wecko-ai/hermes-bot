import { create } from 'zustand'
import { mergeRoomEvents, type Room, type RoomCapabilities, type RoomContext, type RoomDriverStatus, type RoomEvent, type RoomSnapshot } from '../lib/rooms'

export interface RoomCacheEntry {
  room: Room
  driver: RoomDriverStatus | null
  context: RoomContext | null
  events: RoomEvent[]
  cursor: number
  epoch: number
  loading: boolean
  error: string
}

export interface PendingRoomSend {
  eventId: string
  threadId: string
  text: string
}

export type RoomSupport = 'unknown' | 'loading' | 'ready' | 'unsupported' | 'error'

interface RoomState {
  rooms: Room[]
  capabilities: RoomCapabilities | null
  support: RoomSupport
  selectedRoomId: string
  cache: Record<string, RoomCacheEntry>
  pendingSends: Record<string, PendingRoomSend>
  sendFlights: Record<string, boolean>

  setRooms: (rooms: Room[]) => void
  setCapabilities: (capabilities: RoomCapabilities | null) => void
  setSupport: (support: RoomSupport) => void
  selectRoom: (roomId: string) => void
  closeRoom: () => void
  /** Drops a room that was deleted (or renamed away) from the list, its cache and its pending state. */
  removeRoom: (roomId: string) => void
  /** Applies a renamed room to the list and the cache at once. */
  patchRoom: (room: Room) => void
  setRoomLoading: (roomId: string, loading: boolean) => void
  setRoomError: (roomId: string, error: string) => void
  applySnapshot: (roomId: string, snapshot: RoomSnapshot) => void
  setPendingSend: (roomId: string, pending: PendingRoomSend | null) => void
  setSendFlight: (roomId: string, flying: boolean) => void
}

export const useRoomStore = create<RoomState>()((set) => ({
  rooms: [],
  capabilities: null,
  support: 'unknown',
  selectedRoomId: '',
  cache: {},
  pendingSends: {},
  sendFlights: {},

  setRooms: (rooms) => set({ rooms: [...rooms].sort((a, b) => b.updated_at - a.updated_at || a.room_id.localeCompare(b.room_id)) }),
  setCapabilities: (capabilities) => set({ capabilities }),
  setSupport: (support) => set({ support }),
  selectRoom: (selectedRoomId) => set({ selectedRoomId }),
  closeRoom: () => set({ selectedRoomId: '' }),
  removeRoom: (roomId) => set((state) => {
    const { [roomId]: _cache, ...cache } = state.cache
    const { [roomId]: _pending, ...pendingSends } = state.pendingSends
    const { [roomId]: _flight, ...sendFlights } = state.sendFlights
    return {
      rooms: state.rooms.filter((room) => room.room_id !== roomId),
      selectedRoomId: state.selectedRoomId === roomId ? '' : state.selectedRoomId,
      cache,
      pendingSends,
      sendFlights,
    }
  }),
  patchRoom: (room) => set((state) => {
    const cached = state.cache[room.room_id]
    return {
      rooms: state.rooms.map((item) => item.room_id === room.room_id ? { ...item, ...room, members: item.members } : item),
      cache: cached ? { ...state.cache, [room.room_id]: { ...cached, room: { ...cached.room, ...room, members: cached.room.members } } } : state.cache,
    }
  }),
  setRoomLoading: (roomId, loading) => set((state) => {
    const cached = state.cache[roomId]
    const room = cached?.room || state.rooms.find((item) => item.room_id === roomId)
    if (!room) return state
    return { cache: { ...state.cache, [roomId]: { ...(cached || emptyCache(room)), loading } } }
  }),
  setRoomError: (roomId, error) => set((state) => {
    const cached = state.cache[roomId]
    return cached ? { cache: { ...state.cache, [roomId]: { ...cached, error, loading: false } } } : state
  }),
  applySnapshot: (roomId, snapshot) => set((state) => {
    const cached = state.cache[roomId]
    const reset = Boolean(snapshot.reset) || cached?.epoch !== snapshot.epoch
    const events = mergeRoomEvents(cached?.events || [], snapshot.events, reset)
    if (
      cached
      && !reset
      && !cached.loading
      && cached.error === ''
      && cached.cursor === snapshot.cursor
      && cached.epoch === snapshot.epoch
      && sameRoomIdentity(cached.room, snapshot.room)
      && sameLog(cached.events, events)
      && sameValue(cached.driver, snapshot.driver)
      && sameValue(cached.context, snapshot.context)
    ) return state
    const cache = {
      room: snapshot.room,
      driver: snapshot.driver,
      context: snapshot.context,
      events,
      cursor: snapshot.cursor,
      epoch: snapshot.epoch,
      loading: false,
      error: '',
    }
    const rooms = state.rooms.some((room) => room.room_id === roomId)
      ? state.rooms.map((room) => room.room_id === roomId ? snapshot.room : room)
      : [...state.rooms, snapshot.room]
    return { cache: { ...state.cache, [roomId]: cache }, rooms }
  }),
  setPendingSend: (roomId, pending) => set((state) => {
    const next = { ...state.pendingSends }
    if (pending) next[roomId] = pending
    else delete next[roomId]
    return { pendingSends: next }
  }),
  setSendFlight: (roomId, flying) => set((state) => ({ sendFlights: { ...state.sendFlights, [roomId]: flying } })),
}))

function sameValue(a: unknown, b: unknown) {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}

function sameLog(current: RoomEvent[], next: RoomEvent[]) {
  if (current.length !== next.length) return false
  return (current[current.length - 1]?.seq ?? 0) === (next[next.length - 1]?.seq ?? 0)
}

function sameRoomIdentity(current: Room, next: Room) {
  return current.updated_at === next.updated_at
    && current.name === next.name
    && current.latest_seq === next.latest_seq
    && current.disbanded_at === next.disbanded_at
}

function emptyCache(room: Room): RoomCacheEntry {
  return { room, driver: null, context: null, events: [], cursor: 0, epoch: room.authority_epoch || 0, loading: true, error: '' }
}

const cancelIds = new Map<string, string>()

/** A Stop retries with one identity until the gateway acknowledges it. */
export function roomCancelId(roomId: string) {
  let id = cancelIds.get(roomId)
  if (!id) {
    id = crypto.randomUUID()
    cancelIds.set(roomId, id)
  }
  return id
}

export function clearRoomCancel(roomId: string) {
  cancelIds.delete(roomId)
}

const renameIds = new Map<string, { name: string; eventId: string }>()
const disbandIds = new Map<string, string>()

/** A rename retries with one event id while the name stays the same; another name is a new event. */
export function roomRenameEventId(roomId: string, name: string) {
  const known = renameIds.get(roomId)
  if (known && known.name === name) return known.eventId
  const eventId = crypto.randomUUID()
  renameIds.set(roomId, { name, eventId })
  return eventId
}

export function clearRoomRename(roomId: string) {
  renameIds.delete(roomId)
}

/** A disband retries with one cancel id until Hermes confirms the tombstone. */
export function roomDisbandCancelId(roomId: string) {
  let id = disbandIds.get(roomId)
  if (!id) {
    id = `disband-${crypto.randomUUID()}`
    disbandIds.set(roomId, id)
  }
  return id
}

export function clearRoomDisband(roomId: string) {
  disbandIds.delete(roomId)
}

export function resetRoomStore() {
  cancelIds.clear()
  renameIds.clear()
  disbandIds.clear()
  useRoomStore.setState({ rooms: [], capabilities: null, support: 'unknown', selectedRoomId: '', cache: {}, pendingSends: {}, sendFlights: {} })
}
