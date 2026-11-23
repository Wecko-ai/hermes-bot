import type { RoomContext, RoomMember } from './rooms'
import type { Bot } from '../types'
import { resolveMentions } from './mentions'

/** How an unaddressed user message is routed in a hosted room. */
export type RoomRoutingMode = 'everyone' | 'mentions' | 'facilitator'

const STORAGE_KEY = 'hermesbot-room-routing'

export const DEFAULT_ROOM_ROUTING: RoomRoutingMode = 'mentions'

type Stored = Record<string, RoomRoutingMode>

function readStore(): Stored {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Stored : {}
  } catch {
    return {}
  }
}

function writeStore(store: Stored) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)) } catch { /* quota */ }
}

export function roomRoutingMode(roomId: string, context?: RoomContext | null): RoomRoutingMode {
  const local = readStore()[roomId]
  if (local === 'everyone' || local === 'mentions' || local === 'facilitator') return local
  if (context?.routing === 'lead' && context.lead_member_id) return 'facilitator'
  if (context?.routing === 'everyone') return 'everyone'
  return DEFAULT_ROOM_ROUTING
}

export function setRoomRoutingMode(roomId: string, mode: RoomRoutingMode) {
  const store = readStore()
  store[roomId] = mode
  writeStore(store)
}

export function gatewayContextPatch(mode: RoomRoutingMode, leadMemberId: string): Partial<RoomContext> {
  if (mode === 'everyone') return { routing: 'everyone', lead_member_id: '' }
  if (mode === 'facilitator' && leadMemberId) return { routing: 'lead', lead_member_id: leadMemberId }
  return { routing: 'everyone', lead_member_id: '' }
}

/** Mention-only mode blocks send when nobody is addressed (gateway would fan out to everyone). */
export function roomSendAllowed(text: string, members: RoomMember[], bots: Bot[], mode: RoomRoutingMode) {
  if (mode !== 'mentions') return true
  return resolveMentions(text, bots.length ? bots : members.map((member) => ({
    slug: member.profile || member.member_id,
    name: member.display_name || member.handle || member.member_id,
    role: '', section: '', sectionId: '', model: '', status: 'idle', preview: '', timestamp: null, unread: 0, hidden: false,
  })), '').length > 0
}