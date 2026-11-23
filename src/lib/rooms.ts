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

/** A log page said more events exist but did not move the cursor. The caller can show this. */
export const ROOM_LOG_STALLED = 'room_log_stalled'

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
  /** Set when a page claimed more events without a greater cursor (`ROOM_LOG_STALLED`). */
  error?: string
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

// One preview per room, reused while the log's length and last seq stay put.
const roomPreviewCache = new Map<string, { length: number; seq: number; text: string }>()

export function roomPreview(events: RoomEvent[]) {
  const last = events[events.length - 1]
  const roomId = last?.room_id ?? ''
  const seq = last?.seq ?? 0
  const hit = roomId ? roomPreviewCache.get(roomId) : undefined
  if (hit && hit.length === events.length && hit.seq === seq) return hit.text
  const items = roomTimeline(events)
  let text = ''
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].kind !== 'notice') {
      text = items[index].text
      break
    }
  }
  if (roomId) roomPreviewCache.set(roomId, { length: events.length, seq, text })
  return text
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
    const nextCursor = number(result.cursor, cursor)
    latestSeq = number(result.latest_seq, latestSeq)
    if (!result.has_more) {
      cursor = nextCursor
      break
    }
    // An empty page that still says `has_more` would request the same cursor forever.
    if (!(nextCursor > cursor)) {
      return {
        room: state.room,
        driver: state.driver_status ?? null,
        context: state.context ?? null,
        events,
        cursor,
        latestSeq,
        epoch,
        reset,
        error: ROOM_LOG_STALLED,
      }
    }
    cursor = nextCursor
  }
  return { room: state.room, driver: state.driver_status ?? null, context: state.context ?? null, events, cursor, latestSeq, epoch, reset }
}

export interface RoomPendingSend {
  eventId: string
  threadId: string
  text: string
}

/** What `groups.send` should do with a composer text and the room's pending attempt. */
export type RoomSendPlan =
  | { status: 'send'; pending: RoomPendingSend }
  | { status: 'previous-still-sending' }
  | { status: 'already-sending' }

/**
 * A failed attempt that is no longer on the wire can be replaced with new text and a new event id.
 * A different text while that attempt is still in flight is not a silent refusal.
 */
export function planRoomSend(
  content: string,
  existing: RoomPendingSend | undefined,
  inFlight: boolean,
  mint: () => { eventId: string; threadId: string } = () => ({ eventId: crypto.randomUUID(), threadId: crypto.randomUUID() }),
): RoomSendPlan {
  if (inFlight && existing && existing.text !== content) return { status: 'previous-still-sending' }
  if (inFlight) return { status: 'already-sending' }
  if (existing && existing.text === content) return { status: 'send', pending: existing }
  const ids = mint()
  return { status: 'send', pending: { eventId: ids.eventId, threadId: ids.threadId, text: content } }
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

/** Longest room name Hermes accepts (`MAX_ROOM_NAME_CHARS`). */
export const ROOM_NAME_MAX = 200

/** Rename needs only the method. */
export function roomCanRename(capabilities: RoomCapabilities | null) {
  return Boolean(capabilities?.methods.includes('groups.rename'))
}

/**
 * Delete needs `groups.disband` and the `replayable_disband` feature: the feature is what makes a repeated
 * disband answer with the same tombstone instead of an error, so a lost reply can be retried safely.
 */
export function roomCanDisband(capabilities: RoomCapabilities | null) {
  return Boolean(capabilities?.methods.includes('groups.disband') && capabilities.features.includes('replayable_disband'))
}

/**
 * `groups.rename`: one `event_id` per attempt. Hermes answers a repeated id with the same content as already
 * done, and refuses it with other content, so a retry of the same name must reuse the id.
 */
export async function renameRoom(client: HermesClient, roomId: string, eventId: string, name: string) {
  const result = await client.request<{ room: Room }>('groups.rename', { profile: ROOM_PROFILE, room_id: roomId, event_id: eventId, name: name.trim() })
  return result.room
}

/**
 * `groups.disband`: stops the room's work, revokes its routes, then tombstones the id for good. Repeating the
 * call on a disbanded room answers `idempotent: true`, so a lost reply is simply retried with the same ids.
 */
export async function disbandRoom(client: HermesClient, roomId: string, cancelId: string) {
  return client.request<{ tombstone: { room_id: string; disbanded_at: number; idempotent?: boolean } }>('groups.disband', { profile: ROOM_PROFILE, room_id: roomId, cancel_id: cancelId })
}

/** Room purpose, notes and gateway routing (`everyone` / `lead` / `auto`). */
export async function setRoomContext(
  client: HermesClient,
  roomId: string,
  eventId: string,
  patch: Partial<RoomContext> & { purpose?: string; notes?: string },
) {
  return client.request<{ context: RoomContext }>('groups.context', {
    profile: ROOM_PROFILE,
    room_id: roomId,
    event_id: eventId,
    purpose: patch.purpose ?? '',
    notes: patch.notes ?? '',
    ...(patch.routing ? { routing: patch.routing } : {}),
    ...(patch.lead_member_id !== undefined ? { lead_member_id: patch.lead_member_id } : {}),
  })
}

/** Reasons Hermes gives for a refused disband or rename, as keys of `room.menu.errors`. */
export function roomActionErrorKey(error: unknown): 'unsupported' | 'retry' | 'peer' | 'otherGateway' | 'stopPending' | 'failed' | 'offline' {
  if (roomMethodMissing(error)) return 'unsupported'
  if (!(error instanceof HermesRpcError)) return 'offline'
  switch (error.data.reason) {
    case 'room_disbanding_retry': return 'retry'
    case 'peer_unreachable': return 'peer'
    case 'authority_conflict': return 'otherGateway'
    case 'room_stop_pending': return 'stopPending'
    default: return 'failed'
  }
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
