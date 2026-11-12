import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReconnector } from './reconnect'

describe('reconnexion automatique', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('réessaie avec une attente croissante jusqu’au retour de la connexion', async () => {
    let connected = false
    const attempt = vi.fn(async () => { if (attempt.mock.calls.length >= 3) connected = true })
    const reconnector = createReconnector({ attempt, isConnected: () => connected, delays: [100, 200, 500] })
    reconnector.schedule()
    await vi.advanceTimersByTimeAsync(99)
    expect(attempt).toHaveBeenCalledTimes(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(attempt).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(200)
    expect(attempt).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(500)
    expect(attempt).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(attempt).toHaveBeenCalledTimes(3)
    expect(reconnector.pending).toBe(false)
  })

  it('garde la dernière attente au-delà de la liste et repart de zéro après un succès', async () => {
    let connected = false
    const attempt = vi.fn(async () => undefined)
    const reconnector = createReconnector({ attempt, isConnected: () => connected, delays: [100, 300] })
    reconnector.schedule()
    await vi.advanceTimersByTimeAsync(100 + 300 + 300)
    expect(attempt).toHaveBeenCalledTimes(3)
    connected = true
    await vi.advanceTimersByTimeAsync(300)
    expect(attempt).toHaveBeenCalledTimes(4)
    connected = false
    reconnector.schedule()
    await vi.advanceTimersByTimeAsync(100)
    expect(attempt).toHaveBeenCalledTimes(5)
    reconnector.stop()
  })

  it('n’empile pas les tentatives et ne relance pas une tentative en cours', async () => {
    let release: () => void = () => undefined
    const attempt = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const reconnector = createReconnector({ attempt, isConnected: () => true, delays: [100] })
    reconnector.schedule()
    reconnector.schedule()
    await vi.advanceTimersByTimeAsync(100)
    reconnector.now()
    reconnector.schedule()
    expect(attempt).toHaveBeenCalledTimes(1)
    release()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('essaie tout de suite quand le réseau revient, et s’arrête à la déconnexion', async () => {
    const attempt = vi.fn(async () => undefined)
    const reconnector = createReconnector({ attempt, isConnected: () => false, delays: [10_000] })
    reconnector.schedule()
    reconnector.now()
    await vi.advanceTimersByTimeAsync(0)
    expect(attempt).toHaveBeenCalledTimes(1)
    reconnector.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('une tentative qui lève une erreur compte comme un échec', async () => {
    const attempt = vi.fn(async () => { throw new Error('réseau') })
    const reconnector = createReconnector({ attempt, isConnected: () => false, delays: [50] })
    reconnector.schedule()
    await vi.advanceTimersByTimeAsync(100)
    expect(attempt).toHaveBeenCalledTimes(2)
    reconnector.stop()
  })
})
