import { ScreencastSession } from './screencast.mjs'
import { ComputerPanelError } from './errors.mjs'

function listenerKey(bot) {
  return String(bot || '')
}

/** One live CDP screencast per team Chrome origin; several UI tabs can subscribe. */
export class ScreencastHub {
  constructor(origin) {
    this.origin = origin
    this.listeners = new Map()
    this.session = null
    this.starting = null
    this.meta = { url: '', title: '', driver: '', state: 'idle', userControlled: false }
    this.takeover = new Map()
    this.preferredTargetId = ''
    // A tab the user picked in the panel wins over the driver's tab until it closes or is cleared.
    this.manualTargetId = ''
  }

  /** The CDP target the screencast shows now ('' when idle). */
  get currentTargetId() {
    return this.session?.page?.id || ''
  }

  /** Watch another tab of this Chrome (viewer only: the tab is not brought to the front). '' = follow the driver. */
  async selectTarget(targetId) {
    const next = String(targetId || '').trim()
    if (next === this.manualTargetId && (!next || next === this.currentTargetId)) return
    this.manualTargetId = next
    if (this.session) {
      await this.session.stop().catch(() => undefined)
      this.session = null
    }
    if (this.hasListeners()) await this.ensureSession().catch(() => undefined)
  }

  setPreferredTarget(targetId) {
    this.preferredTargetId = String(targetId || '').trim()
  }

  setDriver(driver) {
    this.meta = { ...this.meta, driver: driver || '' }
    this.broadcastMeta()
  }

  setUserControlled(bot, value) {
    if (value) this.takeover.set(listenerKey(bot), true)
    else this.takeover.delete(listenerKey(bot))
    this.meta = { ...this.meta, userControlled: this.takeover.size > 0 }
    this.broadcastMeta()
  }

  isUserControlled(bot) {
    return Boolean(this.takeover.get(listenerKey(bot)))
  }

  attach(bot, onEvent) {
    const key = listenerKey(bot)
    const list = this.listeners.get(key) || new Set()
    list.add(onEvent)
    this.listeners.set(key, list)
    onEvent({ type: 'meta', data: this.meta })
    this.ensureSession().catch(() => undefined)
    return () => this.detach(bot, onEvent)
  }

  detach(bot, onEvent) {
    const key = listenerKey(bot)
    const list = this.listeners.get(key)
    if (!list) return
    list.delete(onEvent)
    if (!list.size) {
      this.listeners.delete(key)
      this.takeover.delete(key)
      this.meta = { ...this.meta, userControlled: this.takeover.size > 0 }
    }
    if (!this.hasListeners()) void this.stopSession()
  }

  hasListeners() {
    for (const list of this.listeners.values()) if (list.size) return true
    return false
  }

  broadcast(event) {
    for (const list of this.listeners.values()) {
      for (const onEvent of list) {
        try { onEvent(event) } catch { list.delete(onEvent) }
      }
    }
  }

  broadcastMeta() {
    this.broadcast({ type: 'meta', data: this.meta })
  }

  async ensureSession() {
    if (this.session || this.starting) {
      await this.starting
      return
    }
    this.starting = (async () => {
      const session = new ScreencastSession(this.origin, {
        onFrame: ({ data, sessionId }) => {
          this.broadcast({ type: 'frame', data: { data, sessionId } })
        },
        onMeta: (meta) => {
          this.meta = { ...this.meta, ...meta, state: 'live' }
          this.broadcastMeta()
        },
        onIdle: () => {
          this.meta = { ...this.meta, state: 'idle', url: '', title: '' }
          this.broadcastMeta()
        },
      })
      try {
        await session.start(this.manualTargetId || this.preferredTargetId)
        this.session = session
      } catch (error) {
        if (error instanceof ComputerPanelError && error.code === 'chrome_idle') {
          this.meta = { ...this.meta, state: 'idle', url: '', title: '' }
          this.broadcastMeta()
        }
        throw error
      }
    })()
    try {
      await this.starting
    } finally {
      this.starting = null
    }
  }

  async stopSession() {
    if (this.session) {
      await this.session.stop().catch(() => undefined)
      this.session = null
    }
    this.meta = { ...this.meta, state: 'idle' }
    this.broadcastMeta()
  }

  async input(bot, body) {
    if (!this.isUserControlled(bot)) throw new ComputerPanelError('not_in_control', 403)
    if (!this.session) throw new ComputerPanelError('not_streaming', 409)
    if (body.kind === 'mouse') {
      await this.session.dispatchMouse(body)
      return
    }
    if (body.kind === 'key') {
      await this.session.dispatchKey(body)
      if (body.type === 'keyDown' && body.autoKeyUp !== false) {
        await this.session.dispatchKey({ ...body, type: 'keyUp' })
      }
      return
    }
    if (body.kind === 'wheel') {
      await this.session.dispatchMouse({
        type: 'mouseWheel',
        x: body.x,
        y: body.y,
        deltaX: body.deltaX,
        deltaY: body.deltaY,
      })
      return
    }
    throw new ComputerPanelError('invalid_request', 400)
  }
}

const hubs = new Map()

export function hubForOrigin(origin) {
  const key = String(origin || '')
  let hub = hubs.get(key)
  if (!hub) {
    hub = new ScreencastHub(key)
    hubs.set(key, hub)
  }
  return hub
}

/** Tests only: drop every hub and close CDP sessions. */
export function resetScreencastHubs() {
  const closing = []
  for (const hub of hubs.values()) closing.push(hub.stopSession())
  hubs.clear()
  return Promise.all(closing)
}