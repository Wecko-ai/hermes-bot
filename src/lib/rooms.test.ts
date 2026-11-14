import { describe, expect, it, vi } from 'vitest'
import type { Bot } from '../types'
import { HermesRpcError, type HermesClient } from './hermes'
import {
  createRoom,
  listRooms,
  mergeRoomEvents,
  readRoom,
  roomMembers,
  roomPreview,
  roomSendNotAdmitted,
  roomTimeline,
  sendRoomMessage,
  stopRoom,
  validateRoomBots,
  type Room,
  type RoomEvent,
} from './rooms'

const bot = (slug: string, name = slug): Bot => ({
  slug,
  name,
  role: '',
  section: '',
  sectionId: '',
  model: '',
  status: 'idle',
  preview: '',
  timestamp: null,
  unread: 0,
  hidden: false,
})

const room = (roomId = 'room-1', changes: Partial<Room> = {}): Room => ({
  room_id: roomId,
  name: roomId,
  members: [],
  authority_gateway_id: 'gateway-1',
  authority_epoch: 7,
  revision: 1,
  created_at: 1,
  updated_at: 1,
  latest_seq: 3,
  ...changes,
})

const event = (
  seq: number,
  kind = 'message.member',
  payload: Record<string, unknown> = {},
  changes: Partial<RoomEvent> = {},
): RoomEvent => ({
  room_id: 'room-1',
  seq,
  event_id: `event-${seq}`,
  kind,
  actor: { kind: 'member', id: 'orion' },
  authority_epoch: 7,
  payload,
  created_at: seq,
  ...changes,
})

const clientWith = (request: ReturnType<typeof vi.fn>) => ({ request }) as unknown as HermesClient

describe('roomTimeline', () => {
  it('sorts user and member messages, resolves their members, and drops blank messages', () => {
    const items = roomTimeline([
      event(2, 'message.member', { text: 'Done', member_id: 'member-orion', round_index: 3 }),
      event(1, 'message.user', { text: 'Start' }, {
        actor: { kind: 'user', id: 'local-user' },
        authority_epoch: 4,
        created_at: 0,
      }),
      event(3, 'message.member', { text: '   ' }),
      event(4, 'message.member', {}),
    ])

    expect(items).toEqual([
      {
        id: '4:1:event-1',
        seq: 1,
        kind: 'user',
        memberId: 'local-user',
        text: 'Start',
        roundIndex: undefined,
        createdAt: null,
      },
      {
        id: '7:2:event-2',
        seq: 2,
        kind: 'member',
        memberId: 'member-orion',
        text: 'Done',
        roundIndex: 3,
        createdAt: new Date(2_000).toISOString(),
      },
    ])
  })

  it('maps every visible notice and its detail, ignoring unrelated activity', () => {
    const items = roomTimeline([
      event(1, 'room.activity', { status: 'settled', reason_code: 'all_done', member_id: 'orion' }),
      event(2, 'room.activity', { status: 'bounded', reason_code: 'max_rounds' }),
      event(3, 'turn.failed', { error: 'boom', reason_code: 'ignored' }),
      event(4, 'turn.cancelled', { reason: 'requested' }),
      event(5, 'turn.deferred', { reason: 'later' }),
      event(6, 'room.stopped'),
      event(7, 'room.continued'),
      event(8, 'room.activity', { status: 'running' }),
      event(9, 'room.unknown'),
    ])

    expect(items.map(({ kind, notice, text, memberId }) => ({ kind, notice, text, memberId }))).toEqual([
      { kind: 'notice', notice: 'settled', text: 'all_done', memberId: 'orion' },
      { kind: 'notice', notice: 'bounded', text: 'max_rounds', memberId: '' },
      { kind: 'notice', notice: 'failed', text: 'boom', memberId: '' },
      { kind: 'notice', notice: 'cancelled', text: 'requested', memberId: '' },
      { kind: 'notice', notice: 'deferred', text: 'later', memberId: '' },
      { kind: 'notice', notice: 'stopped', text: '', memberId: '' },
      { kind: 'notice', notice: 'continued', text: '', memberId: '' },
    ])
  })
})

describe('roomPreview', () => {
  it('uses the latest user or member message, never a trailing notice', () => {
    expect(roomPreview([
      event(2, 'room.activity', { status: 'settled' }),
      event(1, 'message.member', { text: 'Latest answer' }),
    ])).toBe('Latest answer')
  })

  it('is empty when the timeline has no visible message', () => {
    expect(roomPreview([event(1, 'room.stopped')])).toBe('')
    expect(roomPreview([event(1, 'message.member', { text: ' ' })],)).toBe('')
  })
})

describe('mergeRoomEvents', () => {
  it('deduplicates by event id with the incoming version and sorts by sequence', () => {
    const current = [
      event(2, 'message.member', { text: 'old' }, { event_id: 'shared' }),
      event(1, 'message.user', { text: 'first' }),
    ]
    const incoming = [
      event(3, 'message.member', { text: 'third' }),
      event(2, 'message.member', { text: 'replacement' }, { event_id: 'shared' }),
    ]

    const merged = mergeRoomEvents(current, incoming)
    expect(merged.map((item) => item.event_id)).toEqual(['event-1', 'shared', 'event-3'])
    expect(merged[1].payload.text).toBe('replacement')
  })

  it('drops the current log on reset while retaining incoming order', () => {
    const merged = mergeRoomEvents(
      [event(1, 'message.user', { text: 'old' })],
      [event(2, 'message.member', { text: 'newer' }), event(1, 'message.user', { text: 'new' })],
      true,
    )
    expect(merged.map((item) => item.payload.text)).toEqual(['new', 'newer'])
  })
})

describe('validateRoomBots', () => {
  it('accepts from two through six bots and rejects smaller or larger rooms', () => {
    expect(validateRoomBots([bot('one')])).toBe('few')
    expect(validateRoomBots([bot('one'), bot('two')])).toBeNull()
    expect(validateRoomBots(['one', 'two', 'three', 'four', 'five', 'six'].map((slug) => bot(slug)))).toBeNull()
    expect(validateRoomBots(['one', 'two', 'three', 'four', 'five', 'six', 'seven'].map((slug) => bot(slug)))).toBe('many')
  })

  it('rejects duplicate profiles and case-insensitive duplicate handles', () => {
    expect(validateRoomBots([bot('orion', 'Orion'), bot('orion', 'Other')])).toBe('handles')
    expect(validateRoomBots([bot('orion', 'Same Name'), bot('vega', 'same name')])).toBe('handles')
  })

  it.each(['all', 'everyone'])('rejects the reserved handle %s', (handle) => {
    expect(validateRoomBots([bot(handle), bot('orion')])).toBe('handles')
  })
})

describe('roomMembers', () => {
  it('creates local targets and display handles for each bot', () => {
    expect(roomMembers([bot('orion', 'Dr. Orion'), bot('vega', 'Vega')])).toEqual([
      {
        member_id: 'orion',
        profile: 'orion',
        handle: 'dr-orion',
        display_name: 'Dr. Orion',
        target: { kind: 'local', profile: 'orion' },
      },
      {
        member_id: 'vega',
        profile: 'vega',
        handle: 'vega',
        display_name: 'Vega',
        target: { kind: 'local', profile: 'vega' },
      },
    ])
  })
})

describe('room gateway requests', () => {
  it('listRooms follows offsets until the gateway ends pagination', async () => {
    const first = room('room-1')
    const second = room('room-2')
    const third = room('room-3')
    const request = vi.fn()
      .mockResolvedValueOnce({ rooms: [first], next_offset: 1 })
      .mockResolvedValueOnce({ rooms: [second], next_offset: 2 })
      .mockResolvedValueOnce({ rooms: [third], next_offset: null })

    await expect(listRooms(clientWith(request))).resolves.toEqual([first, second, third])
    expect(request.mock.calls).toEqual([
      ['groups.list', { profile: 'default', include_disbanded: false, limit: 100, offset: 0 }],
      ['groups.list', { profile: 'default', include_disbanded: false, limit: 100, offset: 1 }],
      ['groups.list', { profile: 'default', include_disbanded: false, limit: 100, offset: 2 }],
    ])
  })

  it('createRoom trims the name and sends the exact member payload', async () => {
    const created = room('room-new')
    const request = vi.fn().mockResolvedValue({ room: created })
    const bots = [bot('orion', 'Dr. Orion'), bot('vega', 'Vega')]

    await expect(createRoom(clientWith(request), 'room-new', '  Planning room  ', bots)).resolves.toBe(created)
    expect(request).toHaveBeenCalledExactlyOnceWith('groups.create', {
      profile: 'default',
      room_id: 'room-new',
      name: 'Planning room',
      members: roomMembers(bots),
    })
  })

  it('readRoom reads every incremental log page from the cached cursor', async () => {
    const stateRoom = room('room-1', { authority_epoch: 7, latest_seq: 3 })
    const second = event(2, 'message.member', { text: 'two' })
    const third = event(3, 'message.member', { text: 'three' })
    const request = vi.fn()
      .mockResolvedValueOnce({ room: stateRoom, driver_status: null, context: null })
      .mockResolvedValueOnce({ events: [second], cursor: 2, latest_seq: 3, has_more: true })
      .mockResolvedValueOnce({ events: [third], cursor: 3, latest_seq: 3, has_more: false })

    const snapshot = await readRoom(clientWith(request), 'room-1', 1, 7)
    expect(snapshot).toEqual({
      room: stateRoom,
      driver: null,
      context: null,
      events: [second, third],
      cursor: 3,
      latestSeq: 3,
      epoch: 7,
      reset: false,
    })
    expect(request.mock.calls).toEqual([
      ['groups.state', { profile: 'default', room_id: 'room-1', include_disbanded: false }],
      ['groups.log', { profile: 'default', room_id: 'room-1', since_seq: 1, limit: 100, include_disbanded: false }],
      ['groups.log', { profile: 'default', room_id: 'room-1', since_seq: 2, limit: 100, include_disbanded: false }],
    ])
  })

  it.each([
    { label: 'authority epoch changes', sinceSeq: 8, knownEpoch: 6, latestSeq: 10 },
    { label: 'cached cursor is ahead of latest_seq', sinceSeq: 12, knownEpoch: 7, latestSeq: 3 },
  ])('readRoom rewinds and marks a reset when the $label', async ({ sinceSeq, knownEpoch, latestSeq }) => {
    const stateRoom = room('room-1', { authority_epoch: 7, latest_seq: latestSeq })
    const request = vi.fn()
      .mockResolvedValueOnce({ room: stateRoom })
      .mockResolvedValueOnce({ events: [], cursor: 0, latest_seq: latestSeq, has_more: false })

    const snapshot = await readRoom(clientWith(request), 'room-1', sinceSeq, knownEpoch)
    expect(snapshot.reset).toBe(true)
    expect(snapshot.cursor).toBe(0)
    expect(snapshot.epoch).toBe(7)
    expect(request).toHaveBeenNthCalledWith(2, 'groups.log', {
      profile: 'default',
      room_id: 'room-1',
      since_seq: 0,
      limit: 100,
      include_disbanded: false,
    })
  })

  it('sendRoomMessage sends the exact payload and accepts only its matching ACK', async () => {
    const request = vi.fn().mockResolvedValue({ accepted: true, client_event_id: 'event-1' })

    await expect(sendRoomMessage(clientWith(request), 'room-1', 'event-1', '  Hello room  ', 'thread-9')).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledExactlyOnceWith('groups.send', {
      profile: 'default',
      room_id: 'room-1',
      event_id: 'event-1',
      payload: { text: '  Hello room  ', thread_id: 'thread-9', attachments: [] },
    })
  })

  it.each([
    {},
    { accepted: false, client_event_id: 'event-1' },
    { accepted: true },
    { accepted: true, client_event_id: 'another-event' },
  ])('sendRoomMessage rejects an unconfirmed ACK: %j', async (ack) => {
    const request = vi.fn().mockResolvedValue(ack)
    await expect(sendRoomMessage(clientWith(request), 'room-1', 'event-1', 'Hello')).rejects.toThrow('unconfirmed_room_send')
  })

  it('roomSendNotAdmitted recognizes only the explicit pre-commit refusal', () => {
    expect(roomSendNotAdmitted(new HermesRpcError('refused', { admitted: false }))).toBe(true)
    expect(roomSendNotAdmitted(new HermesRpcError('accepted', { admitted: true }))).toBe(false)
    expect(roomSendNotAdmitted(new HermesRpcError('unknown'))).toBe(false)
    expect(roomSendNotAdmitted(new Error('network failed'))).toBe(false)
  })

  it('stopRoom sends one stable cancellation identity and returns the gateway result', async () => {
    const request = vi.fn().mockResolvedValue({ cancelled: 2 })
    await expect(stopRoom(clientWith(request), 'room-1', 'cancel-1')).resolves.toEqual({ cancelled: 2 })
    expect(request).toHaveBeenCalledExactlyOnceWith('groups.stop', {
      profile: 'default',
      room_id: 'room-1',
      cancel_id: 'cancel-1',
    })
  })
})
