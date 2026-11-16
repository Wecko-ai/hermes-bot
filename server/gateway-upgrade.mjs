import { WebSocket } from 'ws'

// One frame of a large attachment is already capped by `maxPayload`. This caps how much
// may sit queued on a slow peer before the other direction stops reading.
export const RELAY_BUFFER_CAP = 8 * 1024 * 1024

const holding = new WeakMap()

/** After `target.send`, pause `source` while the target is holding more than `cap` bytes. */
export function holdWhenBuffered(source, target, cap = RELAY_BUFFER_CAP) {
  if (holding.get(source)) return
  if (!(target.bufferedAmount > cap)) return
  const outgoing = target._socket
  if (!outgoing) return
  holding.set(source, true)
  if (typeof source.pause === 'function') source.pause()
  else source._socket?.pause()
  const release = () => {
    if (!holding.get(source)) return
    holding.set(source, false)
    if (typeof source.resume === 'function') source.resume()
    else source._socket?.resume()
  }
  outgoing.once('drain', release)
}

export function sameUpgradeSession(before, after) {
  if (!before && !after) return true
  if (!before || !after) return false
  return before.id === after.id && before.kind === after.kind
}

function isRelayableCloseCode(code) {
  return Number.isInteger(code) && ((code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999))
}

function clientGone(socket) {
  return socket.destroyed || !socket.writable
}

/**
 * Browser WebSocket ↔ gateway WebSocket. The browser socket gets an error listener before any
 * await. A client that leaves during ticket mint or peer check must not leave a gateway socket up.
 */
export function attachGatewayUpgrade(httpServer, wss, deps) {
  const {
    host, port, accept, browserSession, hermesFetch, mintSocketTicket, localGateway,
    hermesWsOrigin, browserOrigin, maxPayload,
  } = deps

  httpServer.on('upgrade', async (request, socket, head) => {
    socket.on('error', () => socket.destroy())
    let upstream = null
    let checked = null
    let browser = null
    let stopped = false
    const stopUpstream = () => {
      if (stopped) return
      stopped = true
      if (upstream) {
        if (upstream.readyState === WebSocket.OPEN) upstream.close()
        else if (upstream.readyState !== WebSocket.CLOSED) upstream.terminate()
      }
      if (checked && !checked.destroyed) checked.destroy()
    }

    try {
      if (!accept(request)) throw Object.assign(new Error('forbidden'), { status: 403 })
      const url = new URL(request.url || '/', `http://${host}:${port}`)
      if (url.pathname !== '/api/ws') {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
        socket.destroy()
        return
      }
      const sessionBefore = browserSession(request)
      if (clientGone(socket)) return

      const identity = await hermesFetch(request, '/api/auth/me')
      await identity.body?.cancel().catch(() => {})
      if (clientGone(socket)) return
      if (!sameUpgradeSession(sessionBefore, browserSession(request))) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      if (!identity.ok) {
        console.warn(`Hermes WS identity: HTTP ${identity.status}`)
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }

      const profile = (url.searchParams.get('profile') || 'default').slice(0, 128)
      const ticket = await mintSocketTicket(request, profile)
      if (clientGone(socket)) return
      if (!sameUpgradeSession(sessionBefore, browserSession(request))) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }

      const local = browserSession(request)?.kind === 'local'
      checked = local ? await localGateway.connect() : null
      if (clientGone(socket) || !sameUpgradeSession(sessionBefore, browserSession(request))) {
        stopUpstream()
        if (!socket.destroyed) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
          socket.destroy()
        }
        return
      }

      const upstreamUrl = `${local ? localGateway.socketOrigin : hermesWsOrigin}/api/ws?native_dial=browser&profile=${encodeURIComponent(profile)}`
      upstream = new WebSocket(upstreamUrl, [
        'hermes-gateway-v1',
        `hermes-gateway-ticket.${ticket}`,
      ], {
        headers: local ? {} : { Origin: browserOrigin },
        handshakeTimeout: 20_000,
        maxPayload,
        perMessageDeflate: false,
        ...(checked ? { createConnection: () => checked } : {}),
      })
      if (checked) upstream.once('close', () => { if (!checked.destroyed) checked.destroy() })
      upstream.on('error', (error) => {
        if (!stopped) console.error(`Hermes WS upstream: ${error?.code || 'connection_error'}`)
        stopUpstream()
        if (browser && browser.readyState === WebSocket.OPEN) browser.close(1011)
      })
      upstream.on('unexpected-response', (_ignored, response) => {
        console.error(`Hermes WS upstream: HTTP ${response.statusCode}`)
        response.resume?.()
        const code = response.statusCode === 401 || response.statusCode === 403 ? 4401 : 1011
        if (browser && browser.readyState === WebSocket.OPEN) browser.close(code)
        else if (!socket.destroyed) socket.destroy()
        stopUpstream()
      })

      let upgraded = false
      wss.handleUpgrade(request, socket, head, (accepted) => {
        upgraded = true
        browser = accepted
        deps.onRelay?.(browser, upstream)
        const forward = (source, target) => {
          source.on('message', (data, binary) => {
            if (stopped || target.readyState !== WebSocket.OPEN) return
            target.send(data, { binary })
            holdWhenBuffered(source, target)
          })
        }
        browser.on('close', () => stopUpstream())
        browser.on('error', () => stopUpstream())
        upstream.on('open', () => {
          if (stopped || browser.readyState !== WebSocket.OPEN) {
            stopUpstream()
            return
          }
          console.log('Hermes WS upstream: connected')
          forward(browser, upstream)
          forward(upstream, browser)
        })
        upstream.on('close', (code, reason) => {
          console.warn(`Hermes WS upstream: close ${code}`)
          if (browser.readyState !== WebSocket.OPEN) return
          if (isRelayableCloseCode(code)) browser.close(code, reason)
          else browser.close(1011)
        })
      })
      if (!upgraded) stopUpstream()
    } catch (error) {
      stopUpstream()
      console.error(`Hermes WS upgrade: ${error?.status || error?.code || 'failed'}`)
      if (!socket.destroyed) {
        socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
        socket.destroy()
      }
    }
  })
}
