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