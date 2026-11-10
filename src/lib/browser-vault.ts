import { i18n } from '../i18n'

export interface BrowserVaultRequest {
  id: string
  kind: 'save' | 'code'
  bot: string
  origin: string
  busy: boolean
  createdAt: string
}

export function subscribeBrowserVaultRequests(onRequests: (requests: BrowserVaultRequest[]) => void) {
  const source = new EventSource('/api/browser-vault/events')
  source.onmessage = (event) => {
    try {
      const value = JSON.parse(event.data)
      if (Array.isArray(value)) onRequests(value)
    } catch { /* a partial frame is replaced by the next snapshot */ }
  }
  return () => source.close()
}

// Messages live in the catalog under browserVault.errors.<code>.
const ERROR_CODES = new Set([
  'request_not_found',
  'request_busy',
  'origin_mismatch',
  'origin_not_found',
  'invalid_origin',
  'invalid_credentials',
  'invalid_bots',
  'vault_unavailable',
  'vault_write_failed',
  'vault_service_unavailable',
  'admin_forbidden',
  'user_session_required',
  'login_fields_not_found',
  'code_field_not_found',
  'cdp_unavailable',
])

const errorMessage = (code: string) => i18n.t(ERROR_CODES.has(code) ? `browserVault.errors.${code}` : 'browserVault.errors.default')

/** Vault credentials, without the password: it stays in the bots machine’s keychain. */
export interface VaultEntry {
  id: string
  origin: string
  identifier: string
  /** Bots allowed to use it; `*` for all. */
  bots: string[]
  createdAt: string | null
  updatedAt: string | null
}

async function vaultRequest<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) {
    const code = typeof result.error === 'string' ? result.error : ''
    throw new Error(errorMessage(code))
  }
  return result as T
}

export async function respondBrowserVault(id: string, body: Record<string, unknown>) {
  await vaultRequest(`/api/browser-vault/requests/${encodeURIComponent(id)}`, body)
}

export async function listVaultEntries() {
  const result = await vaultRequest<{ entries?: VaultEntry[] }>('/api/browser-vault/entries')
  return Array.isArray(result.entries) ? result.entries : []
}

/** Without `password`, the saved password is kept. */
export async function saveVaultEntry(entry: { origin: string; identifier: string; password?: string; bots: string[] }) {
  await vaultRequest('/api/browser-vault/entries', entry)
}

export async function removeVaultEntry(origin: string) {
  await vaultRequest('/api/browser-vault/entries/remove', { origin })
}
