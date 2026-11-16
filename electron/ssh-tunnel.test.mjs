import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import tunnel from './ssh-tunnel.cjs'

const { sshForwardArgs, stopTunnel } = tunnel

function fakeClock() {
  const timers = []
  return {
    timers,
    schedule(fn, ms) {
      const timer = { fn, ms, cleared: false }
      timers.push(timer)
      return timer
    },
    cancel(timer) { if (timer) timer.cleared = true },
  }
}

function liveProcess() {
  const child = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  child.signals = []
  child.kill = (signal) => { child.signals.push(signal) }
  return child
}

describe('ssh tunnel', () => {
  it('forwards only loopback and drops a silent tunnel', () => {
    expect(sshForwardArgs(9120, 'gateway.example')).toEqual([
      '-N', '-L', '9120:127.0.0.1:9120',
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      '--',
      'gateway.example',
    ])
    expect(sshForwardArgs(4331, 'gateway.example')[2]).toBe('4331:127.0.0.1:4331')
  })

  it('is a no-op when the tunnel is already gone', async () => {
    const kill = () => { throw new Error('should not kill') }
    await stopTunnel(null)
    await stopTunnel({ exitCode: 0, signalCode: null, kill })
    await stopTunnel({ exitCode: null, signalCode: 'SIGTERM', kill })
  })

  it('sends SIGTERM and resolves on exit without SIGKILL', async () => {
    const clock = fakeClock()
    const child = liveProcess()
    const pending = stopTunnel(child, { termMs: 2000, schedule: clock.schedule, cancel: clock.cancel })
    expect(child.signals).toEqual(['SIGTERM'])
    child.exitCode = 0
    child.emit('exit', 0)
    await pending
    expect(child.signals).toEqual(['SIGTERM'])
    expect(clock.timers[0].cleared).toBe(true)
    expect(clock.timers[0].ms).toBe(2000)
  })

  it('sends SIGKILL after the grace period if the tunnel is still alive', async () => {
    const clock = fakeClock()
    const child = liveProcess()
    const pending = stopTunnel(child, { termMs: 2000, schedule: clock.schedule, cancel: clock.cancel })
    expect(clock.timers).toHaveLength(1)
    clock.timers[0].fn()
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(clock.timers[1].ms).toBe(500)
    clock.timers[1].fn()
    await pending
  })
})
