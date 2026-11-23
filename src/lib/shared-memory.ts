export type MemoryType = 'profile' | 'rules' | 'people' | 'workstreams'

export interface MemoryEntry {
  id: string
  title: string
  date: string
  source: string
  body: string
  type: MemoryType
}

export interface MemoryFile {
  type: MemoryType
  text: string
  entries: MemoryEntry[]
}

const ROUTE = '/api/shared-memory'

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(String((body as { error?: string }).error || response.status))
  return body as T
}

export async function loadMemoryIndex() {
  return fetchJson<{ types: Record<MemoryType, { entries: number; preview: string }> }>(ROUTE)
}

export async function loadMemory(type: MemoryType) {
  return fetchJson<MemoryFile>(`${ROUTE}/${type}`)
}

export async function saveMemoryEntry(type: MemoryType, entry: Partial<MemoryEntry> & { title: string; body: string }) {
  return fetchJson<MemoryFile>(`${ROUTE}/${type}/entries`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
  })
}

export async function deleteMemoryEntry(type: MemoryType, id: string) {
  return fetchJson<MemoryFile>(`${ROUTE}/${type}/entries/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function searchMemory(query: string) {
  return fetchJson<{ hits: MemoryEntry[] }>(`${ROUTE}/search?${new URLSearchParams({ q: query })}`)
}

export async function loadMemorySummary() {
  return fetchJson<{ enabled: boolean; summary: string }>(`${ROUTE}/summary`)
}

/** Appends the shared-memory note to api_text for this turn only. */
export function sharedMemoryApiText(apiText: string | undefined, summary: string) {
  if (!summary.trim()) return apiText
  const note = apiText ?? ''
  return `${note}${note ? '\n\n' : ''}${summary}`
}