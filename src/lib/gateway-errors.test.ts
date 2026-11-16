import { describe, expect, it } from 'vitest'
import { HermesRpcError } from './hermes'
import { heartbeatFailureClosesSocket, isPermissionDenied, isStaleGeneration } from './gateway-errors'

describe('gateway errors', () => {
  it('treats a JSON-RPC error as a reason, not a dropped socket', () => {
    const stale = new HermesRpcError('stale_generation', { reason: 'stale_generation' })
    const denied = new HermesRpcError('refused', { reason: 'permission_denied' })
    expect(isStaleGeneration(stale)).toBe(true)
    expect(isPermissionDenied(denied)).toBe(true)
    expect(isPermissionDenied(new Error('permission_denied'))).toBe(true)
    expect(heartbeatFailureClosesSocket(stale)).toBe(false)
    expect(heartbeatFailureClosesSocket(denied)).toBe(false)
  })

  it('closes the socket on a timeout or a transport error', () => {
    expect(heartbeatFailureClosesSocket(new Error('no answer'))).toBe(true)
    expect(heartbeatFailureClosesSocket(new Error('connection closed'))).toBe(true)
    expect(isStaleGeneration(new Error('timeout'))).toBe(false)
  })
})
