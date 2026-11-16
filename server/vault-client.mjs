// Admin calls from this server to the credential vault on 127.0.0.1. The Hermes cookie
// proves a signed-in user and is sent only with a write. The poll is a GET.

const TOKEN_SHAPE = /^[0-9a-f]{64}$/

export function selectVaultToken(globalToken, envToken, readFile) {
  if (TOKEN_SHAPE.test(globalToken || '')) return String(globalToken)
  if (TOKEN_SHAPE.test(envToken || '')) return String(envToken)
  try {
    const value = String(readFile() ?? '').trim()
    return TOKEN_SHAPE.test(value) ? value : ''
  } catch {
    return ''
  }
}

export function vaultRequestHeaders(method, token, hermesCookie = '') {
  const headers = { Authorization: `Bearer ${token}` }
  if (method === 'POST') {
    headers['Content-Type'] = 'application/json'
    if (hermesCookie) headers['X-Hermes-Cookie'] = hermesCookie
  }
  return headers
}

/** Last good snapshots win. A failed or malformed poll must not clear the cards. */
export function reduceVaultPoll(state, status, body) {
  const ok = status === 200 && body && typeof body === 'object'
  return {
    requests: ok && Array.isArray(body.requests) ? JSON.stringify(body.requests) : state.requests,
    notices: ok && Array.isArray(body.notices) ? JSON.stringify(body.notices) : state.notices,
  }
}

/** Tells the vault to drop its session-validation cache. 404 and a down vault are ignored. */
export async function postVaultLogout(origin, token, fetchImpl = fetch) {
  if (!TOKEN_SHAPE.test(token || '')) return
  try {
    const response = await fetchImpl(`${origin}/admin/v1/logout`, {
      method: 'POST',
      headers: vaultRequestHeaders('POST', token),
      signal: AbortSignal.timeout(2_000),
    })
    await response?.body?.cancel?.().catch(() => {})
  } catch {
    // Best effort: the route may not exist yet, or the vault is not running.
  }
}
