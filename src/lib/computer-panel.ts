export interface ComputerPanelMeta {
  state: 'idle' | 'live'
  url: string
  title: string
  driver: string
  userControlled: boolean
}

type PanelEvent =
  | { type: 'meta'; data: ComputerPanelMeta }
  | { type: 'frame'; data: { data: string; sessionId: string } }

function parseEvent(raw: string): PanelEvent | null {
  try {
    const value = JSON.parse(raw) as PanelEvent
    if (value?.type === 'meta' || value?.type === 'frame') return value
  } catch { /* malformed chunk */ }
  return null
}

/** Live CDP view of the bot's team Chrome (`Page.startScreencast` relayed by the local server). */
export function subscribeComputerPanel(bot: string, handlers: {
  onMeta: (meta: ComputerPanelMeta) => void
  onFrame: (jpegBase64: string) => void
  onError?: () => void
}) {
  const source = new EventSource(`/api/computer-panel/stream?bot=${encodeURIComponent(bot)}`)
  source.onmessage = (message) => {
    const event = parseEvent(message.data)
    if (!event) return
    if (event.type === 'meta') handlers.onMeta(event.data)
    if (event.type === 'frame' && event.data.data) handlers.onFrame(event.data.data)
  }
  source.onerror = () => handlers.onError?.()
  return () => source.close()
}

export async function setComputerTakeover(bot: string, active: boolean) {
  const response = await fetch('/api/computer-panel/takeover', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bot, active }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'takeover_failed')
  return body as { bot: string; userControlled: boolean; steerText: string }
}

export async function sendComputerInput(bot: string, payload: Record<string, unknown>) {
  const response = await fetch('/api/computer-panel/input', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bot, ...payload }),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(typeof body.error === 'string' ? body.error : 'input_failed')
  }
}
export interface ComputerPanelPage { id: string; title: string; url: string; current: boolean }
export interface ComputerPanelPages { team: string; following: boolean; pages: ComputerPanelPage[] }

const asPages = (body: unknown): ComputerPanelPages => {
  const raw = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const pages = Array.isArray(raw.pages) ? raw.pages : []
  return {
    team: typeof raw.team === 'string' ? raw.team : '',
    following: raw.following !== false,
    pages: pages.filter((page): page is Record<string, unknown> => Boolean(page) && typeof page === 'object')
      .map((page) => ({ id: String(page.id || ''), title: String(page.title || ''), url: String(page.url || ''), current: page.current === true }))
      .filter((page) => page.id),
  }
}

/** The tabs of the bot's team Chrome. */
export async function loadComputerPages(bot: string): Promise<ComputerPanelPages> {
  const response = await fetch(`/api/computer-panel/pages?bot=${encodeURIComponent(bot)}`, { credentials: 'same-origin' })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'pages_failed')
  return asPages(body)
}

/** Watch another tab (viewer only, the tab is not brought to the front); '' follows the bot again. */
export async function selectComputerPage(bot: string, targetId: string): Promise<ComputerPanelPages> {
  const response = await fetch('/api/computer-panel/pages', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bot, targetId }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'select_failed')
  return asPages(body)
}

/** A Mac the bot drives over SSH with the remote-cua plugin (a remote Mac): who has control. */
export interface RemoteMac {
  configured: boolean
  installed: boolean
  machine: { host: string; user: string; os: string } | null
  lease: { holder: 'agent' | 'human'; viewer: string | null; since: number; epoch: number }
  mine: boolean
  error?: string
  steerText?: string
}

export async function loadRemoteMac(bot: string): Promise<RemoteMac | null> {
  const response = await fetch(`/api/computer-panel/remote?bot=${encodeURIComponent(bot)}`, { credentials: 'same-origin' })
  if (!response.ok) return null
  return response.json() as Promise<RemoteMac>
}

/** Take over (`active`) or hand back. A hand back left by another viewer needs `force` with the epoch seen. */
export async function setRemoteMacControl(bot: string, active: boolean, force?: { epoch: number }): Promise<RemoteMac> {
  const response = await fetch('/api/computer-panel/remote', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bot, active, ...(force ? { force: true, epoch: force.epoch } : {}) }),
  })
  const body = await response.json().catch(() => ({}))
  if (response.status !== 200 && response.status !== 409) throw new Error(typeof body.error === 'string' ? body.error : 'remote_failed')
  return body as RemoteMac
}
