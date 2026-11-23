export interface LibraryPage {
  id: string
  profile: string
  path: string
  name: string
  title: string
  openedAt: string
  archived?: boolean
}

async function libraryRequest<T>(method: 'GET' | 'POST', search = '', body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(`/api/pages-library${search}`, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!response.ok) throw new Error('pages_library_failed')
  return response.json() as Promise<T>
}

export async function listLibraryPages(profile: string, query = '', archived = false) {
  const params = new URLSearchParams({ profile, ...(query ? { q: query } : {}), ...(archived ? { archived: '1' } : {}) })
  const result = await libraryRequest<{ items?: LibraryPage[] }>('GET', `?${params}`)
  return Array.isArray(result.items) ? result.items : []
}

export async function touchLibraryPage(profile: string, path: string, name: string, title?: string) {
  return libraryRequest<{ id: string }>('POST', '', { action: 'touch', profile, path, name, title })
}

export async function renameLibraryPage(profile: string, id: string, title: string) {
  await libraryRequest('POST', '', { action: 'rename', profile, id, title })
}

export async function archiveLibraryPage(profile: string, id: string) {
  await libraryRequest('POST', '', { action: 'archive', profile, id })
}