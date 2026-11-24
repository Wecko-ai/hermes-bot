import type { Bot, ChatMessage, SessionUsage } from '../types'
import type { HostCapabilities, ScrollMemory, SendJournalEntry } from './replica'

export interface StoredReplica {
  profile: string
  sessionId: string
  revision: string
  lastId: number
  lastTime: string
  title: string
  model: string
  usage: SessionUsage | null
  hasOlder: boolean
  messages: ChatMessage[]
  scroll?: ScrollMemory
}

export interface CacheBoot {
  selection: string
  roster: Bot[]
  capabilities: HostCapabilities
  journal: SendJournalEntry[]
  replica: StoredReplica | null
}

async function put(path: string, body: unknown) {
  await fetch(path, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => undefined)
}

export async function loadBoot(): Promise<CacheBoot | null> {
  const response = await fetch('/api/conv-cache/boot', { credentials: 'same-origin' }).catch(() => null)
  if (!response?.ok) return null
  return response.json().catch(() => null)
}

export async function loadReplica(profile: string): Promise<StoredReplica | null> {
  const response = await fetch(`/api/conv-cache/replica?${new URLSearchParams({ profile })}`, { credentials: 'same-origin' }).catch(() => null)
  if (!response?.ok) return null
  return response.json().catch(() => null)
}

export function saveReplica(replica: StoredReplica) {
  void put('/api/conv-cache/replica', replica)
}

export function saveRoster(roster: Bot[]) {
  void put('/api/conv-cache/roster', { roster })
}

export function saveSelection(profile: string) {
  void put('/api/conv-cache/selection', { profile })
}

export function saveJournal(journal: SendJournalEntry[]) {
  void put('/api/conv-cache/journal', { journal })
}

export function saveCapabilities(capabilities: HostCapabilities) {
  void put('/api/conv-cache/capabilities', capabilities)
}
