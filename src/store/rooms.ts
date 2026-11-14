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
    const events = mergeRoomEvents(cached?.events || [], snapshot.events, snapshot.reset || cached?.epoch !== snapshot.epoch)
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

export function resetRoomStore() {
  cancelIds.clear()
  useRoomStore.setState({ rooms: [], capabilities: null, support: 'unknown', selectedRoomId: '', cache: {}, pendingSends: {}, sendFlights: {} })
}
