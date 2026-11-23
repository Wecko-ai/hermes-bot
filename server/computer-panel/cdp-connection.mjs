import { WebSocket } from 'ws'
import { ComputerPanelError } from './errors.mjs'

const loopback = (hostname) => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname)

/** `ws:` on a loopback host, and only on the CDP port this client was given. */
export function allowedDebuggerSocket(raw, expectedPort) {
  let url
  try { url = new URL(String(raw || '')) } catch { return false }
  if (url.protocol !== 'ws:' || !loopback(url.hostname) || url.username || url.password) return false
  return (url.port || '80') === expectedPort
}

export function assertLoopbackHttpOrigin(raw) {
  let url
  try { url = new URL(String(raw || '')) } catch { throw new ComputerPanelError('cdp_unavailable', 503) }
  if (url.protocol !== 'http:' || !loopback(url.hostname)) throw new ComputerPanelError('cdp_unavailable', 503)
  return url
}

export class CdpConnection {
  constructor(url, expectedPort) {
    this.url = url
    this.expectedPort = expectedPort
    this.socket = null
    this.sequence = 0
    this.pending = new Map()
    this.events = new Map()
  }

  on(event, handler) {
    const list = this.events.get(event) || []
    list.push(handler)
    this.events.set(event, list)
  }

  emit(event, params) {
    for (const handler of this.events.get(event) || []) handler(params)
  }

  async open() {
    if (!allowedDebuggerSocket(this.url, this.expectedPort)) throw new ComputerPanelError('cdp_unavailable', 503)
    this.socket = new WebSocket(this.url)
    this.socket.on('message', (raw) => {
      let frame
      try { frame = JSON.parse(String(raw)) } catch { return }
      if (frame.method) {
        this.emit(frame.method, frame.params || {})
        return
      }
      const pending = this.pending.get(frame.id)
      if (!pending) return
      this.pending.delete(frame.id)
      clearTimeout(pending.timer)
      if (frame.error) pending.reject(new ComputerPanelError('cdp_command_failed', 502))
      else pending.resolve(frame.result || {})
    })
    this.socket.on('error', () => this.rejectPending())
    this.socket.on('close', () => this.rejectPending())
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket.terminate()
        reject(new ComputerPanelError('cdp_unavailable', 503))
      }, 3000)
      timer.unref()
      this.socket.once('open', () => { clearTimeout(timer); resolve() })
      this.socket.once('error', () => { clearTimeout(timer); reject(new ComputerPanelError('cdp_unavailable', 503)) })
    })
  }

  rejectPending() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new ComputerPanelError('cdp_unavailable', 503))
    }
    this.pending.clear()
  }

  call(method, params = {}, timeoutMs = 8000) {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new ComputerPanelError('cdp_unavailable', 503)
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new ComputerPanelError('cdp_timeout', 504))
      }, timeoutMs)
      timer.unref()
      this.pending.set(id, { resolve, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    this.rejectPending()
    if (this.socket?.readyState <= WebSocket.OPEN) this.socket.close()
    this.socket = null
  }
}