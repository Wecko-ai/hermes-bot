import { BrowserVaultError, vaultError } from './errors.mjs'

/** Exact origin: protocol, normalized IDN host and effective port. */
export function normalizeOrigin(value) {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('unsupported')
    return url.origin
  } catch {
    throw new BrowserVaultError('invalid_origin', 400)
  }
}
