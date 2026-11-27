import http from 'node:http'
import { execFile } from 'node:child_process'
import { URL } from 'node:url'

let memPressureCache = { at: 0, value: 0.25, inflight: false }

function sysctlPressureLevel() {
  return new Promise((resolve) => {
    execFile('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null)
      const n = Number(String(stdout).trim())
      resolve(Number.isFinite(n) ? n : null)
    })
  })
}

function mapPressureLevel(level) {
  if (level === null) return 0.25
  if (level >= 4) return 0.95
  if (level === 2 || level === 3) return 0.85
  return 0.25
}

export function isMemoryPressureHigh({ cacheMs = 10000 } = {}) {
  const nowMs = Date.now()
  if (nowMs - memPressureCache.at >= cacheMs && !memPressureCache.inflight) {
    memPressureCache.inflight = true
    sysctlPressureLevel()
      .then((level) => {
        memPressureCache.value = mapPressureLevel(level)
        memPressureCache.at = Date.now()
      })
      .catch(() => { memPressureCache.value = 0.25 })
      .finally(() => { memPressureCache.inflight = false })
  }
  return memPressureCache.value
}

const LANES = ['P0', 'P1', 'P2', 'P3']
const LANE_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 }

export function createSplashGate({
  port = 8098,
  host = '127.0.0.1',
  targetHost = '127.0.0.1',
  targetPort = 8099,
  p0TimeoutMs = 20000,
  ageThresholdMs = 15 * 60 * 1000,
  maxTokensBackground = 2048,
  memoryPressureProvider = isMemoryPressureHigh,
  memoryPressureLimit = 0.8,
  p2YieldAt = 3,
  p95WaitWindow = 200,
  maxConcurrent = 1,
  now = () => Date.now(),
} = {}) {
  let queue = []
  let current = null
  let busyTotalMs = 0
  let busyStartedAt = null
  const startedAt = now()
  let recentWaits = []
  let counts = { P0: 0, P1: 0, P2: 0, P3: 0 }
  let consecutiveP2 = 0

  const server = http.createServer((req, res) => onRequest(req, res))

  function effectiveLane(job) {
    if (job.lane === 'P1' && now() - job.enqueuedAt >= ageThresholdMs) return 'P0'
    return job.lane
  }

  function priorityOf(req, url) {
    const h = req.headers['x-splash-priority']
    if (h && LANES.includes(h.toUpperCase())) return h.toUpperCase()
    const q = url.searchParams.get('priority')
    if (q && LANES.includes(q.toUpperCase())) return q.toUpperCase()
    return 'P2'
  }

  function memoryBlocked() {
    return memoryPressureProvider() > memoryPressureLimit
  }

  function dispatchable(job) {
    if (job.lane === 'P3' && memoryBlocked()) return false
    return !job.settled
  }

  function bestJob() {
    const queued = queue.filter(dispatchable)
    if (!queued.length) return null
    queued.sort((a, b) => {
      const ea = LANE_ORDER[effectiveLane(a)]
      const eb = LANE_ORDER[effectiveLane(b)]
      if (ea !== eb) return ea - eb
      return a.enqueuedAt - b.enqueuedAt
    })
    const head = queued[0]
    // P1 yields to P2 only while some, but fewer than p2YieldAt, consecutive P2 dispatches have happened
    if (effectiveLane(head) === 'P1' && consecutiveP2 > 0 && consecutiveP2 < p2YieldAt) {
      const p2 = queued.find((j) => effectiveLane(j) === 'P2')
      if (p2) return p2
    }
    return head
  }

  function removeFromQueue(job) {
    const i = queue.indexOf(job)
    if (i >= 0) queue.splice(i, 1)
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', reject)
    })
  }

  function scheduleDispatch() {
    if (current) return
    const job = bestJob()
    if (!job) return
    removeFromQueue(job)
    current = job
    job.dispatched = true
    job.waitMs = now() - job.enqueuedAt
    if (job.timer) { clearTimeout(job.timer); job.timer = null }
    consecutiveP2 = job.lane === 'P2' ? consecutiveP2 + 1 : 0
    counts[job.lane] += 1
    busyStart()
    dispatch(job)
  }

  let busyStartAtLocal = null
  function busyStart() { busyStartAtLocal = now() }

  async function dispatch(job) {
    try {
      const body = await readBody(job.req)
      await forward(job, body)
    } catch (err) {
      try {
        if (!job.res.headersSent) {
          job.res.writeHead(502, { 'content-type': 'application/json' })
          job.res.end(JSON.stringify({ error: 'upstream_error', detail: String(err?.message || err) }))
        }
      } catch { /* socket already dead */ }
    } finally {
      busyTotalMs += now() - (busyStartAtLocal || now())
      busyStartAtLocal = null
      const wait = job.waitMs
      recentWaits = [...recentWaits, wait].slice(-p95WaitWindow)
      current = null
      scheduleDispatch()
    }
  }

  function forward(job, body) {
    return new Promise((resolve) => {
      const isBackground = job.lane !== 'P0'
      let fwdBody = body
      const headers = { ...job.req.headers }
      delete headers['host']
      delete headers['content-length']
      if (isBackground && body.length && (job.req.headers['content-type'] || '').includes('application/json')) {
        try {
          const j = JSON.parse(body.toString('utf8'))
          if (j && typeof j === 'object' && typeof j.max_tokens === 'number' && j.max_tokens > maxTokensBackground) {
            j.max_tokens = maxTokensBackground
            fwdBody = Buffer.from(JSON.stringify(j))
            headers['content-type'] = 'application/json'
          }
        } catch { /* leave body untouched */ }
      }
      const options = {
        hostname: targetHost,
        port: targetPort,
        path: job.url.pathname + job.url.search,
        method: job.req.method,
        headers: { ...headers, host: `${targetHost}:${targetPort}` },
      }
      const proxyReq = http.request(options, (proxyRes) => {
        const passHeaders = { ...proxyRes.headers }
        delete passHeaders['transfer-encoding']
        job.res.writeHead(proxyRes.statusCode || 200, passHeaders)
        proxyRes.pipe(job.res)
        proxyRes.on('end', () => resolve())
        proxyRes.on('error', () => resolve())
      })
      proxyReq.on('error', () => {
        try {
          if (!job.res.headersSent) {
            job.res.writeHead(502, { 'content-type': 'application/json' })
            job.res.end(JSON.stringify({ error: 'upstream_error', detail: 'upstream unreachable' }))
          }
        } catch { /* socket already dead */ }
        resolve()
      })
      if (fwdBody && fwdBody.length) proxyReq.write(fwdBody)
      proxyReq.end()
    })
  }

  function onRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`)
    if (url.pathname === '/gate/status') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(status()))
      return
    }
    const lane = priorityOf(req, url)
    const job = { lane, enqueuedAt: now(), req, res, url, settled: false, dispatched: false, timer: null, waitMs: 0 }
    if (lane === 'P0') {
      job.timer = setTimeout(() => {
        if (!job.settled && !job.dispatched) {
          job.settled = true
          removeFromQueue(job)
          try {
            if (!res.headersSent) {
              res.writeHead(503, { 'x-splash-gate-wait-exceeded': '1', 'content-type': 'application/json' })
              res.end(JSON.stringify({ error: 'fail_open_timeout', lane: 'P0', waitedMs: now() - job.enqueuedAt }))
            }
          } catch { /* socket dead */ }
        }
      }, p0TimeoutMs)
      if (job.timer.unref) job.timer.unref()
    }
    queue.push(job)
    scheduleDispatch()
  }

  function status() {
    const waits = recentWaits.slice().sort((a, b) => a - b)
    let p95 = 0
    if (waits.length) {
      const idx = Math.min(waits.length - 1, Math.ceil(waits.length * 0.95) - 1)
      p95 = waits[Math.max(0, idx)]
    }
    const queueLengths = { P0: 0, P1: 0, P2: 0, P3: 0 }
    for (const j of queue) { if (!j.settled) queueLengths[j.lane]++ }
    const totalTimeMs = now() - startedAt
    const busyMs = busyTotalMs + (current ? now() - (busyStartAtLocal || now()) : 0)
    return {
      queueLengths,
      queueTotal: queue.filter((j) => !j.settled).length,
      busy: current ? 1 : 0,
      busyPct: totalTimeMs > 0 ? busyMs / totalTimeMs : 0,
      p95WaitMs: p95,
      counts: { ...counts },
      consecutiveP2,
      memoryPressure: memoryPressureProvider(),
      ageThresholdMs,
      p0TimeoutMs,
      maxConcurrent,
      target: `${targetHost}:${targetPort}`,
      host,
      port,
    }
  }

  function start() {
    if (server.listening) return Promise.resolve(server)
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        server.removeListener('error', reject)
        resolve(server)
      })
    })
  }

  function close() {
    return new Promise((resolve) => {
      if (!server.listening) return resolve()
      server.close(() => resolve())
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
    })
  }

  return { server, start, close, status }
}

export async function resolveSplashTarget({
  gateHost = '127.0.0.1',
  gatePort = 8098,
  directHost = '127.0.0.1',
  directPort = 8099,
  fetchImpl = fetch,
  probeTimeoutMs = 500,
} = {}) {
  const gateUrl = `http://${gateHost}:${gatePort}`
  const directUrl = `http://${directHost}:${directPort}`
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), probeTimeoutMs)
    const res = await fetchImpl(`${gateUrl}/gate/status`, { signal: controller.signal }).finally(() => clearTimeout(timer))
    if (res && res.ok) return { kind: 'gate', url: gateUrl }
  } catch { /* fall through */ }
  return { kind: 'direct', url: directUrl }
}

export async function requestWithFallback({
  path = '/',
  gateHost = '127.0.0.1',
  gatePort = 8098,
  directHost = '127.0.0.1',
  directPort = 8099,
  method = 'POST',
  headers = {},
  body,
  fetchImpl = fetch,
  probeTimeoutMs = 500,
} = {}) {
  const target = await resolveSplashTarget({ gateHost, gatePort, directHost, directPort, fetchImpl, probeTimeoutMs })
  const doFetch = (url) => fetchImpl(`${url}${path}`, { method, headers, body })
  try {
    return await doFetch(target.url)
  } catch (err) {
    if (target.kind === 'gate') {
      return await doFetch(`http://${directHost}:${directPort}`)
    }
    throw err
  }
}

import { pathToFileURL } from 'node:url'

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const gate = createSplashGate({ port: 8098, host: '127.0.0.1', targetHost: '127.0.0.1', targetPort: 8099 })
  await gate.start()
  console.log('splash-gate listening on 127.0.0.1:8098 (target 127.0.0.1:8099)')
  const shutdown = async () => {
    await gate.close()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}
