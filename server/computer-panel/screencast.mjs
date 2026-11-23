import { CdpConnection } from './cdp-connection.mjs'
import { ComputerPanelError } from './errors.mjs'
import { listPages, pageMeta, pickPage } from './chrome.mjs'

const SCREENCAST = { format: 'jpeg', quality: 35, everyNthFrame: 2, maxWidth: 960, maxHeight: 720 }

export class ScreencastSession {
  constructor(origin, { onFrame, onMeta, onIdle } = {}) {
    this.origin = origin
    this.onFrame = onFrame
    this.onMeta = onMeta
    this.onIdle = onIdle
    this.connection = null
    this.page = null
    this.running = false
    this.metaTimer = null
    this.lastFrameAt = 0
    this.viewport = { width: 960, height: 720 }
  }

  async start(preferredTargetId = '') {
    if (this.running) return
    const pages = await listPages(this.origin)
    const page = pickPage(pages, preferredTargetId)
    if (!page) {
      this.onIdle?.('idle')
      throw new ComputerPanelError('chrome_idle', 503)
    }
    this.page = page
    const port = new URL(this.origin).port || '80'
    this.connection = new CdpConnection(page.webSocketDebuggerUrl, port)
    this.connection.on('Page.screencastFrame', (params) => {
      this.lastFrameAt = Date.now()
      const data = typeof params.data === 'string' ? params.data : ''
      if (data) this.onFrame?.({ data, sessionId: params.sessionId || '' })
      const sessionId = params.sessionId
      if (sessionId) {
        this.connection.call('Page.screencastFrameAck', { sessionId }, 2000).catch(() => undefined)
      }
      if (params.metadata?.deviceWidth && params.metadata?.deviceHeight) {
        this.viewport = {
          width: Number(params.metadata.deviceWidth) || this.viewport.width,
          height: Number(params.metadata.deviceHeight) || this.viewport.height,
        }
      }
    })
    await this.connection.open()
    await this.connection.call('Page.enable', {})
    await this.connection.call('Page.startScreencast', SCREENCAST)
    await this.publishMeta()
    this.metaTimer = setInterval(() => { this.publishMeta().catch(() => undefined) }, 2500)
    this.metaTimer.unref()
    this.running = true
  }

  async publishMeta() {
    if (!this.connection) return
    const meta = await pageMeta(this.connection)
    this.onMeta?.({ ...meta, state: 'live' })
  }

  async stop() {
    this.running = false
    if (this.metaTimer) {
      clearInterval(this.metaTimer)
      this.metaTimer = null
    }
    if (this.connection) {
      try { await this.connection.call('Page.stopScreencast', {}, 2000) } catch { /* already down */ }
      this.connection.close()
      this.connection = null
    }
    this.page = null
  }

  async dispatchMouse({ type, x, y, button = 'left', clickCount = 1, deltaX = 0, deltaY = 0 }) {
    if (!this.connection) throw new ComputerPanelError('not_streaming', 409)
    const scaleX = this.viewport.width
    const scaleY = this.viewport.height
    const px = Math.max(0, Math.min(scaleX, Number(x) || 0))
    const py = Math.max(0, Math.min(scaleY, Number(y) || 0))
    const payload = {
      type,
      x: px,
      y: py,
      button,
      clickCount,
      buttons: type === 'mousePressed' ? 1 : 0,
    }
    if (type === 'mouseWheel') {
      payload.deltaX = Number(deltaX) || 0
      payload.deltaY = Number(deltaY) || 0
    }
    await this.connection.call('Input.dispatchMouseEvent', payload)
  }

  async dispatchKey({ type, key, text = '', code = '', modifiers = 0 }) {
    if (!this.connection) throw new ComputerPanelError('not_streaming', 409)
    await this.connection.call('Input.dispatchKeyEvent', {
      type,
      key: key || text,
      text: type === 'keyDown' || type === 'keyUp' ? text : undefined,
      unmodifiedText: text || undefined,
      code: code || undefined,
      modifiers: Number(modifiers) || 0,
    })
  }
}