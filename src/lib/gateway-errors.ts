import { HermesRpcError } from './hermes'

/** Wire reason of a gateway refusal: `data.reason` when present, otherwise the error message. */
export function rpcReason(error: unknown): string {
  if (error instanceof HermesRpcError) {
    const reason = error.data.reason
    if (typeof reason === 'string' && reason) return reason
    return error.message
  }
  return error instanceof Error ? error.message : ''
}

export function isStaleGeneration(error: unknown) {
  return rpcReason(error) === 'stale_generation'
}

export function isPermissionDenied(error: unknown) {
  return rpcReason(error) === 'permission_denied'
}

/**
 * A heartbeat failure closes the socket only on a timeout or a transport error.
 * A JSON-RPC error result (`HermesRpcError`) leaves the socket up.
 */
export function heartbeatFailureClosesSocket(error: unknown) {
  return !(error instanceof HermesRpcError)
}
