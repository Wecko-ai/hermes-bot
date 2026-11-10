export class BrowserVaultError extends Error {
  constructor(code, status = 400) {
    super(code)
    this.name = 'BrowserVaultError'
    this.code = code
    this.status = status
  }
}

export function vaultError(error, fallback = 'vault_unavailable', status = 503) {
  if (error instanceof BrowserVaultError) return error
  return new BrowserVaultError(fallback, status)
}
