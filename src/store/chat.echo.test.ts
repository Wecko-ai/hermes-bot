import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../types'
import type { ActiveChat } from '../lib/hermes'
import { stitchHistory } from '../lib/replica'
import { resolveSyncedMessages, withoutEchoedRows, type ChatCacheEntry } from './chat'

const row = (id: string, role: ChatMessage['role'], content: string, createdAt: string): ChatMessage => ({ id, role, content, createdAt })
const entry = (messages: ChatMessage[]): ChatCacheEntry => ({
  chat: { profile: 'orion', sessionId: 's', revision: 1, executionGeneration: 1, running: false, socketGeneration: 1 } as ActiveChat,
  messages,
  routines: [],
})

// Question sent from the app, answer arrived while another bot was open.
const before = [row('11269', 'assistant', 'Voilà pour l’appel', '2026-11-27T06:10:45.168Z')]
const optimistic = [
  row('local-1795762123573', 'user', 'donne moi son chemin complet sur le serveur', '2026-11-27T06:48:43.572Z'),
  row('background-1795762133299', 'assistant', '/Users/test/.hermes/profiles/orion/workspace/brief-v2.md', '2026-11-27T06:48:53.299Z'),
]
const persisted = [
  row('11304', 'user', 'donne moi son chemin complet sur le serveur', '2026-11-27T06:48:43.772Z'),
  row('11305', 'assistant', '/Users/test/.hermes/profiles/orion/workspace/brief-v2.md', '2026-11-27T06:48:52.984Z'),
]

describe('optimistic rows echoed by the gateway transcript', () => {
  it('a delta re-read does not show the question and the answer twice', () => {
    const cached = entry([...before, ...optimistic])
    const base = stitchHistory(cached.messages, persisted, 'delta')
    expect(resolveSyncedMessages(cached, base, false).map((m) => m.id)).toEqual(['11269', '11304', '11305'])
  })

  it('cleans a replica already saved with the duplicates (unchanged re-read)', () => {
    const polluted = [...before, ...optimistic, ...persisted]
    expect(resolveSyncedMessages(undefined, polluted, false).map((m) => m.id)).toEqual(['11269', '11304', '11305'])
    expect(withoutEchoedRows(polluted).map((m) => m.id)).toEqual(['11269', '11304', '11305'])
  })

  it('keeps a pending send that the gateway has not written yet', () => {
    const list = [...before, optimistic[0]]
    expect(withoutEchoedRows(list)).toBe(list)
  })

  it('keeps a message really sent twice: one persisted row absorbs one optimistic row', () => {
    const list = [
      row('100', 'user', 'ok', '2026-11-27T06:00:00.000Z'),
      row('local-1', 'user', 'ok', '2026-11-27T06:00:00.100Z'),
      row('local-2', 'user', 'ok', '2026-11-27T06:00:05.000Z'),
    ]
    expect(withoutEchoedRows(list).map((m) => m.id)).toEqual(['100', 'local-2'])
  })

  it('does not match an old identical message from much earlier', () => {
    const list = [
      row('50', 'user', 'ok', '2026-11-27T01:00:00.000Z'),
      row('local-9', 'user', 'ok', '2026-11-27T06:00:00.000Z'),
    ]
    expect(withoutEchoedRows(list).map((m) => m.id)).toEqual(['50', 'local-9'])
  })
})
