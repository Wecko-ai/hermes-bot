// Sign-in to a Hermes gateway that needs no password: its default setup, bound to this machine.
//
// In that setup the Hermes Webapp authorizes requests with a session token kept in the Hermes home
// (`webapp/session-token`, readable by its owner only). That token gives full access to the person's
// agents, so it is sent to one place only: a connection whose other end is the gateway process that
// owns that home. Checked for every request that carries the token:
//
//   1. the gateway address is this machine, and `/api/status` says no sign-in is required;
//   2. the Hermes home belongs to this user and nobody else can write to it;
//   3. the gateway of that home answers `identify` on its private control socket, with its process ID;
//   4. the connection is opened to 127.0.0.1 itself (never a name that could resolve elsewhere), and
//      `lsof` shows that very process holding the other end of this very connection. A process of
//      another account, an SSH tunnel, or whoever takes the port between two requests gets nothing;
//   5. the token file belongs to this user, is closed to everyone else and has the expected shape.
//
// The token never leaves this module: callers get `fetch()`, which adds the header itself.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { Readable } from 'node:stream'

const TOKEN_HEADER = 'x-hermes-session-token'
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/
// The only address the token travels to. `localhost` in the settings is read as this address:
// left to the resolver, it could lead to a listener on another address of the same port.
const GATEWAY_HOST = '127.0.0.1'
const STATUS_CACHE_MS = 10_000
const MAX_CONTROL_ANSWER = 512 * 1024
// The gateway shows a connection once it has accepted it: a few short tries cover a busy moment.
const PEER_TRIES = 6
const PEER_WAIT_MS = 60
const IDLE_CLOSE_MS = 120_000

const refused = (reason) => ({ ok: false, reason })
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** `http://127.0.0.1:9120` gives 9120; anything that is not plain http on this machine gives null. */
export function loopbackPort(origin) {
  try {
    const url = new URL(origin)
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) return null
    const port = Number(url.port || 80)
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null
  } catch {
    return null
  }
}

/** A file, folder or socket that only this user can change. `closed` also refuses any read by others. */
export function ownedBy(info, uid, { closed = false } = {}) {
  if (!info || info.uid !== uid) return false
  return (info.mode & (closed ? 0o077 : 0o022)) === 0
}

/** The process ID and the home a gateway names in its `identify` answer, or null for any other answer. */
export function parseIdentify(line) {
  try {
    const answer = JSON.parse(line)
    const result = answer?.result
    if (answer?.ok !== true || answer.protocol !== 1 || answer.id !== 1 || !result || typeof result !== 'object') return null
    if (!Number.isInteger(result.pid) || result.pid <= 1 || typeof result.hermes_home !== 'string') return null
    return { pid: result.pid, home: result.hermes_home }
  } catch {
    return null
  }
}

/** True when lsof (`-Fn`, already limited to one process) shows it listening on exactly this address and port. */
export function listensOn(lsofOutput, port) {
  return String(lsofOutput).split('\n').includes(`n${GATEWAY_HOST}:${port}`)
}

/** True when lsof shows that process holding the other end of the connection that left from `localPort`. */
export function holdsPeer(lsofOutput, port, localPort) {
  return String(lsofOutput).split('\n').includes(`n${GATEWAY_HOST}:${port}->${GATEWAY_HOST}:${localPort}`)
}

function homeHash(home) {
  return createHash('sha256').update(home).digest('hex').slice(0, 16)
}

/** The control socket of a Hermes home: `gateway.sock`, or the one its private pointer file names. */
async function controlSocketPath(home, uid) {
  const direct = path.join(home, 'gateway.sock')
  const node = await lstat(direct).catch(() => null)
  if (node) return node.isSocket() && ownedBy(node, uid) ? direct : null
  // A home whose path is too long for a socket keeps it in a private temporary folder.
  const pointer = path.join(home, 'gateway.sock.path')
  const pointerInfo = await lstat(pointer).catch(() => null)
  if (!pointerInfo?.isFile() || !ownedBy(pointerInfo, uid, { closed: true }) || pointerInfo.size > 4096) return null
  const target = (await readFile(pointer, 'utf8')).trim()
  if (!path.isAbsolute(target) || path.basename(target) !== 'control.sock') return null
  if (path.basename(path.dirname(target)) !== `hermes-gw-${homeHash(home)}`) return null
  const folder = await lstat(path.dirname(target)).catch(() => null)
  const socket = await lstat(target).catch(() => null)
  if (!folder?.isDirectory() || !ownedBy(folder, uid, { closed: true })) return null
  return socket?.isSocket() && ownedBy(socket, uid) ? target : null
}

/** One request line to a control socket, one answer line back. */
function controlQuery(socketPath, request, timeout = 2_000) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      socket.destroy()
      resolve(value)
    }
    const socket = net.createConnection({ path: socketPath })
    socket.setTimeout(timeout, () => finish(null))
    socket.on('connect', () => socket.write(request))
    socket.on('data', (chunk) => {
      chunks.push(chunk)
      size += chunk.length
      if (size > MAX_CONTROL_ANSWER) return finish(null)
      if (chunk.includes(10)) finish(Buffer.concat(chunks).toString('utf8').split('\n', 1)[0])
    })
    socket.on('end', () => finish(size ? Buffer.concat(chunks).toString('utf8').split('\n', 1)[0] : null))
    socket.on('error', () => finish(null))
  })
}

/** The TCP sockets of one process on the gateway address, as lsof names them (`-Fn`). Empty on any failure. */
function lsofSockets(pid, port) {
  return new Promise((resolve) => {
    execFile('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), `-iTCP@${GATEWAY_HOST}:${port}`, '-Fn'],
      { timeout: 4_000 }, (error, stdout) => resolve(error ? '' : stdout))
  })
}

function connect(port, timeout = 4_000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: GATEWAY_HOST, port })
    socket.setTimeout(timeout, () => { socket.destroy(); resolve(null) })
    socket.once('connect', () => { socket.setTimeout(0); resolve(socket) })
    socket.once('error', () => resolve(null))
  })
}

/** One HTTP request on an already open, already checked connection. Answers like `fetch` does. */
function requestOn(socket, port, route, { method = 'GET', headers, body, signal } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: GATEWAY_HOST, port, path: route, method, agent: false,
      headers: { ...Object.fromEntries(new Headers(headers)), host: `${GATEWAY_HOST}:${port}`, connection: 'close' },
      createConnection: () => socket,
    })
    const abort = () => request.destroy(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
    if (signal?.aborted) return abort()
    signal?.addEventListener('abort', abort, { once: true })
    request.once('error', reject)
    request.once('response', (incoming) => {
      const answer = new Headers()
      for (const [name, value] of Object.entries(incoming.headers)) {
        for (const item of Array.isArray(value) ? value : [value]) answer.append(name, item)
      }
      const empty = method === 'HEAD' || [204, 205, 304].includes(incoming.statusCode)
      if (empty) incoming.resume()
      // One request per connection: closed once the answer is read or dropped. A caller that never
      // reads the body must not keep it open either, hence the idle limit (a stream being read is not idle).
      incoming.once('close', () => socket.destroy())
      socket.setTimeout(IDLE_CLOSE_MS, () => socket.destroy())
      resolve(new Response(empty ? null : Readable.toWeb(incoming), { status: incoming.statusCode, headers: answer }))
    })
    request.end(body)
  })
}

/**
 * `check()` answers `{ ok: true }` when this user's own gateway, without a password, holds the gateway
 * address; otherwise `{ ok: false, reason }`. Reasons: `not_local`, `gateway_down`, `password_required`,
 * `unsafe_home`, `gateway_not_running`, `gateway_elsewhere`, `no_token`.
 * `fetch(route, init)` sends one request with the token, or throws `local_gateway_unavailable`.
 */
export function createLocalGateway({ gatewayOrigin, hermesHome, uid = process.getuid?.(), deps = {} }) {
  const fetchImpl = deps.fetch || fetch
  const query = deps.controlQuery || controlQuery
  const sockets = deps.lsofSockets || lsofSockets
  const port = loopbackPort(gatewayOrigin)
  let statusUntil = 0

  /** Whether the gateway says it needs no sign-in. Nothing secret is sent to ask, so the answer is kept a moment. */
  async function needsNoPassword() {
    if (statusUntil > Date.now()) return true
    try {
      const response = await fetchImpl(`http://${GATEWAY_HOST}:${port}/api/status`, { redirect: 'manual', signal: AbortSignal.timeout(4_000) })
      if (!response.ok) return null
      const body = await response.json()
      if (body?.auth_required !== false) return false
      statusUntil = Date.now() + STATUS_CACHE_MS
      return true
    } catch {
      return null
    }
  }

  /** Everything but the connection: the gateway's process and the token, read again each time. */
  async function verify() {
    if (port === null || typeof uid !== 'number') return refused('not_local')
    const open = await needsNoPassword()
    if (open === null) return refused('gateway_down')
    if (!open) return refused('password_required')

    const home = await realpath(hermesHome).catch(() => null)
    const homeInfo = home && await lstat(home).catch(() => null)
    if (!homeInfo?.isDirectory() || !ownedBy(homeInfo, uid)) return refused('unsafe_home')

    const socketPath = await controlSocketPath(home, uid)
    const answer = socketPath && await query(socketPath, '{"protocol":1,"verb":"identify","id":1}\n')
    const gateway = answer ? parseIdentify(answer) : null
    // The gateway must name this home as its own: a socket left by another setup proves nothing.
    if (!gateway || await realpath(gateway.home).catch(() => null) !== home) return refused('gateway_not_running')

    const tokenFile = path.join(home, 'webapp', 'session-token')
    const tokenInfo = await lstat(tokenFile).catch(() => null)
    if (!tokenInfo?.isFile() || !ownedBy(tokenInfo, uid, { closed: true }) || tokenInfo.size > 256) return refused('no_token')
    const token = (await readFile(tokenFile, 'utf8').catch(() => '')).trim()
    return TOKEN_SHAPE.test(token) ? { ok: true, token, pid: gateway.pid } : refused('no_token')
  }

  return {
    /** For the sign-in screen and the sign-in itself: no token is used, the listener is enough. */
    async check() {
      const found = await verify()
      if (!found.ok) return found
      return listensOn(await sockets(found.pid, port), port) ? { ok: true } : refused('gateway_elsewhere')
    },

    async fetch(route, init = {}) {
      const unavailable = (reason) => Object.assign(new Error('local_gateway_unavailable'), { status: 401, reason })
      const found = await verify()
      if (!found.ok) throw unavailable(found.reason)
      const socket = await connect(port)
      if (!socket) throw unavailable('gateway_down')
      // The token only leaves once the gateway's own process is seen at the other end of this connection.
      let peer = false
      for (let attempt = 0; attempt < PEER_TRIES && !peer; attempt += 1) {
        if (attempt) await delay(PEER_WAIT_MS)
        peer = holdsPeer(await sockets(found.pid, port), port, socket.localPort)
      }
      if (!peer) {
        socket.destroy()
        throw unavailable('gateway_elsewhere')
      }
      const headers = new Headers(init.headers)
      headers.set(TOKEN_HEADER, found.token)
      try {
        return await requestOn(socket, port, route, { ...init, headers })
      } catch (error) {
        socket.destroy()
        throw error
      }
    },

    /** The gateway refused the token, or was restarted: ask it again whether it still needs no sign-in. */
    invalidate() {
      statusUntil = 0
    },

    /** Address of the gateway's WebSocket, on the same pinned address as every other request. */
    socketOrigin: port === null ? '' : `ws://${GATEWAY_HOST}:${port}`,
  }
}
