/** Waits between automatic reconnection attempts: 1 s, 2 s, 5 s, 10 s, then every 15 s. */
export const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 15_000]

/** Heartbeat while connected and visible: a silent socket counts as dropped. */
export const HEARTBEAT_MS = 25_000
export const HEARTBEAT_TIMEOUT_MS = 10_000

export interface Reconnector {
  /** The connection dropped: try again after the next backoff step (no-op if one is already planned). */
  schedule: () => void
  /** Network back, window shown: try at once and start the backoff over. */
  now: () => void
  /** Stops the planned attempt (sign-out, unmount). */
  stop: () => void
  readonly pending: boolean
}

interface ReconnectorOptions {
  /** One reconnection attempt. Never throws; the connection state is read afterwards. */
  attempt: () => Promise<void>
  isConnected: () => boolean
  delays?: number[]
}

/** Retries until the connection is back, with a growing wait. Only one attempt runs at a time. */
export function createReconnector({ attempt, isConnected, delays = RECONNECT_DELAYS_MS }: ReconnectorOptions): Reconnector {
  let timer: ReturnType<typeof setTimeout> | undefined
  let step = 0
  let running = false
  let stopped = false

  const run = async () => {
    timer = undefined
    if (stopped || running) return
    running = true
    try { await attempt() } catch { /* the state read below decides */ } finally { running = false }
    if (stopped) return
    if (isConnected()) step = 0
    else schedule()
  }

  const schedule = () => {
    stopped = false
    if (timer || running) return
    const delay = delays[Math.min(step, delays.length - 1)]
    step += 1
    timer = setTimeout(() => { void run() }, delay)
  }

  return {
    schedule,
    now: () => {
      stopped = false
      if (running) return
      if (timer) clearTimeout(timer)
      timer = undefined
      step = 0
      void run()
    },
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = undefined
      step = 0
    },
    get pending() { return Boolean(timer) || running },
  }
}
