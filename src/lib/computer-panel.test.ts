import { describe, expect, it, vi, afterEach } from 'vitest'
import { setComputerTakeover, subscribeComputerPanel } from './computer-panel'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('computer panel client', () => {
  it('parses SSE frames and sends takeover requests', async () => {
    const listeners = new Map<string, (event: { data?: string }) => void>()
    class FakeEventSource {
      url: string
      onmessage: ((event: { data: string }) => void) | null = null
      onerror: (() => void) | null = null
      constructor(url: string) {
        this.url = url
        listeners.set(url, (event) => this.onmessage?.({ data: event.data || '' }))
      }
      close() { listeners.delete(this.url) }
    }
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ userControlled: true, steerText: 'pause' }),
    })))

    const frames: string[] = []
    const stop = subscribeComputerPanel('orion', {
      onMeta: (meta) => expect(meta.state).toBe('live'),
      onFrame: (jpeg) => frames.push(jpeg),
    })
    listeners.get('/api/computer-panel/stream?bot=orion')?.({ data: JSON.stringify({ type: 'meta', data: { state: 'live', url: 'https://a.test', title: 'A', driver: 'orion', userControlled: false } }) })
    listeners.get('/api/computer-panel/stream?bot=orion')?.({ data: JSON.stringify({ type: 'frame', data: { data: 'abc', sessionId: 's' } }) })
    expect(frames).toEqual(['abc'])
    stop()

    const takeover = await setComputerTakeover('orion', true)
    expect(takeover.steerText).toBe('pause')
  })
})