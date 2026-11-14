import type { Bot } from '../types'
import { HermesRpcError, type HermesClient } from './hermes'
import { botMentionTag } from './mentions'

/** Native gateway-hosted rooms. The gateway owns routing and turns; the app never fans out Bot Chat prompts. */
export interface RoomMember {
  member_id: string
  profile: string
  handle: string
  display_name?: string | null
  target?: Record<string, unknown> | null
}

export interface Room {
  room_id: string
  name: string
  members: RoomMember[]
  authority_gateway_id: string
  authority_epoch: number
  revision: number
  created_at: number
  updated_at: number
  latest_seq?: number | null
  disbanded_at?: number | null
}

export interface RoomActor {
  kind: string
  id: string
  profile?: string | null
  display_name?: string | null
}

export interface RoomEvent {
  room_id: string
  seq: number
  event_id: string
  kind: string
  actor: RoomActor
  authority_epoch?: number | null
  payload: Record<string, unknown>
  created_at: number
}

export interface RoomMemberActivity {
  member_id: string
  status: 'queued' | 'running' | 'stopping' | string
  thread_id?: string | null
  round_index?: number | null
  started_at?: number | null
  tool?: string | null
  progress_at?: number | null
}

export interface RoomDriverStatus {
  running: boolean
  working: boolean
  blocked: boolean
  counts: Record<string, number>
  pending_actions: Record<string, unknown>[]
  member_activity?: RoomMemberActivity[]
  last_error?: string | null
  max_rounds?: number | null
  max_continues?: number | null
  routing_modes?: string[] | null
  peer_routes?: { room_id: string; member_id: string; status: string }[]
}

export interface RoomContext {
  purpose: string
  notes: string
  routing?: 'everyone' | 'lead' | 'auto'
  lead_member_id?: string
}

export interface RoomCapabilities {
  protocol_version: number
  driver: boolean
  persistent_process: boolean
  authority_gateway_id: string
  features: string[]
  methods: string[]
  max_log_limit: number
  seatable_profiles?: string[] | null
}

export interface RoomSnapshot {
  room: Room
  driver: RoomDriverStatus | null
  context: RoomContext | null
  events: RoomEvent[]
  cursor: number
  latestSeq: number
  epoch: number
  /** The local cursor or authority was stale: replace the cached log instead of appending. */
  reset: boolean
}

export type RoomNotice = 'settled' | 'bounded' | 'failed' | 'cancelled' | 'deferred' | 'stopped' | 'continued'

export interface RoomTimelineItem {
  id: string
  seq: number
  kind: 'user' | 'member' | 'notice'
  memberId: string
  text: string
  notice?: RoomNotice
  roundIndex?: number
  createdAt: string | null
}

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const text = (value: unknown) => typeof value === 'string' ? value : ''
const number = (value: unknown, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? value : fallback
const iso = (seconds: unknown) => {
  const value = number(seconds)
  return value > 0 ? new Date(value * 1000).toISOString() : null
}

export function roomTimeline(events: RoomEvent[]): RoomTimelineItem[] {
  const items: RoomTimelineItem[] = []
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    const payload = object(event.payload)
    const base = { id: `${event.authority_epoch ?? 0}:${event.seq}:${event.event_id}`, seq: event.seq, createdAt: iso(event.created_at) }
    if (event.kind === 'message.user' || event.kind === 'message.member') {
      const content = text(payload.text)
      if (!content.trim()) continue
      items.push({
        ...base,
        kind: event.kind === 'message.user' ? 'user' : 'member',
        memberId: text(payload.member_id) || text(event.actor?.id),
        text: content,
        roundIndex: typeof payload.round_index === 'number' ? payload.round_index : undefined,
      })
      continue
    }
    let notice: RoomNotice | undefined
    let detail = ''
    if (event.kind === 'room.activity') {
      const status = text(payload.status)
      if (status === 'settled' || status === 'bounded') notice = status
      detail = text(payload.reason_code)
    } else if (event.kind === 'turn.failed') {
      notice = 'failed'
      detail = text(payload.error) || text(payload.reason_code)
    } else if (event.kind === 'turn.cancelled') {
      notice = 'cancelled'
      detail = text(payload.reason)
    } else if (event.kind === 'turn.deferred') {
      notice = 'deferred'
      detail = text(payload.reason)
    } else if (event.kind === 'room.stopped') notice = 'stopped'
    else if (event.kind === 'room.continued') notice = 'continued'
    if (notice) items.push({ ...base, kind: 'notice', memberId: text(payload.member_id), text: detail, notice })
  }
  return items
}

export function roomPreview(events: RoomEvent[]) {
  const items = roomTimeline(events)
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].kind !== 'notice') return items[index].text
  }
  return ''
}

export function mergeRoomEvents(current: RoomEvent[], incoming: RoomEvent[], reset = false) {
  const byId = new Map<string, RoomEvent>()
  if (!reset) for (const event of current) byId.set(event.event_id, event)
  for (const event of incoming) byId.set(event.event_id, event)
  return [...byId.values()].sort((a, b) => a.seq - b.seq).slice(-2000)
}

export function validateRoomBots(bots: Bot[]): 'few' | 'many' | 'handles' | null {
  if (bots.length < 2) return 'few'
  if (bots.length > 6) return 'many'
  const profiles = new Set(bots.map((bot) => bot.slug))
  const handles = bots.map((bot) => botMentionTag(bot).toLowerCase())
  if (profiles.size !== bots.length || new Set(handles).size !== bots.length || handles.some((handle) => handle === 'all' || handle === 'everyone')) return 'handles'
  return null
}

export function roomMembers(bots: Bot[]): RoomMember[] {
  return bots.map((bot) => ({
    member_id: bot.slug,
    profile: bot.slug,
    handle: botMentionTag(bot),
    display_name: bot.name,
    target: { kind: 'local', profile: bot.slug },
  }))
}

const ROOM_PROFILE = 'default'

export async function loadRoomCapabilities(client: HermesClient) {
  return client.request<RoomCapabilities>('groups.capabilities', { profile: ROOM_PROFILE })
}

export async function listRooms(client: HermesClient) {
  const rooms: Room[] = []
  let offset: number | null = 0
  for (let page = 0; page < 20 && offset !== null; page += 1) {
    const result: { rooms: Room[]; next_offset?: number | null } = await client.request('groups.list', { profile: ROOM_PROFILE, include_disbanded: false, limit: 100, offset })
    rooms.push(...(Array.isArray(result.rooms) ? result.rooms : []))
    offset = typeof result.next_offset === 'number' ? result.next_offset : null
  }
  return rooms
}

export async function createRoom(client: HermesClient, roomId: string, name: string, bots: Bot[]) {
  const result = await client.request<{ room: Room }>('groups.create', {
    profile: ROOM_PROFILE,
    room_id: roomId,
    name: name.trim(),
    members: roomMembers(bots),
  })
  return result.room
}

export async function readRoom(client: HermesClient, roomId: string, sinceSeq = 0, knownEpoch?: number): Promise<RoomSnapshot> {
  const state = await client.request<{ room: Room; driver_status?: RoomDriverStatus | null; context?: RoomContext | null }>('groups.state', { profile: ROOM_PROFILE, room_id: roomId, include_disbanded: false })
  const epoch = number(state.room.authority_epoch, 0)
  const latest = number(state.room.latest_seq, 0)
  let cursor = knownEpoch !== undefined && knownEpoch !== epoch ? 0 : sinceSeq
  let reset = cursor !== sinceSeq
  if (cursor > latest) {
    cursor = 0
    reset = true
  }
  const events: RoomEvent[] = []
  let latestSeq = latest
  for (let page = 0; page < 50; page += 1) {
    const result = await client.request<{ events: RoomEvent[]; cursor: number; latest_seq: number; has_more: boolean }>('groups.log', {
      profile: ROOM_PROFILE,
      room_id: roomId,
      since_seq: cursor,
      limit: 100,
      include_disbanded: false,
    })
    events.push(...(Array.isArray(result.events) ? result.events : []))
    cursor = number(result.cursor, cursor)
    latestSeq = number(result.latest_seq, latestSeq)
    if (!result.has_more) break
  }
  return { room: state.room, driver: state.driver_status ?? null, context: state.context ?? null, events, cursor, latestSeq, epoch, reset }
}

export async function sendRoomMessage(client: HermesClient, roomId: string, eventId: string, content: string, threadId = eventId) {
  const result = await client.request<{ accepted?: boolean; client_event_id?: string }>('groups.send', {
    profile: ROOM_PROFILE,
    room_id: roomId,
    event_id: eventId,
    payload: { text: content, thread_id: threadId, attachments: [] },
  })
  if (result.accepted !== true || result.client_event_id !== eventId) throw new Error('unconfirmed_room_send')
}

export async function stopRoom(client: HermesClient, roomId: string, cancelId: string) {
  return client.request<{ cancelled: number }>('groups.stop', { profile: ROOM_PROFILE, room_id: roomId, cancel_id: cancelId })
}

export function roomMethodMissing(error: unknown) {
  return error instanceof HermesRpcError && error.code === -32601
}

/** Only this explicit pre-commit refusal proves that retrying would not duplicate the user's words. */
export function roomSendNotAdmitted(error: unknown) {
  return error instanceof HermesRpcError && error.data.admitted === false
}

export function roomErrorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
