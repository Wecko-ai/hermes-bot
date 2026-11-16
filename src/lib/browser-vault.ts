import { i18n } from '../i18n'
import type { SsoHint } from './sso'

export interface BrowserVaultRequest {
  id: string
  kind: 'save' | 'code' | 'signup'
  bot: string
  origin: string
  /** Sign-up only: the login the bot registers (never a password). */
  identifier?: string
  /** Login only: the page offers "Continue with Google" (Apple, Microsoft), or is that provider's own page. */
  sso?: SsoHint
  /** Save only: the site already has a login; approving replaces its password and adds this bot (never a password). */
  replaces?: { identifier: string; bots: string[] }
  busy: boolean
  createdAt: string
}

/** An account a bot created without a card, under the user's setting "Create accounts without asking". */
export interface BrowserVaultNotice {
  id: string
  kind: 'auto_signup'
  bot: string
  origin: string
  /** The login registered (an e-mail, a username): never a password. */
  identifier: string
  at: string
}

const isNotice = (value: unknown): value is BrowserVaultNotice => {
  const notice = value as Partial<BrowserVaultNotice> | null
  return Boolean(notice) && notice?.kind === 'auto_signup'
    && [notice.id, notice.bot, notice.origin, notice.identifier, notice.at].every((field) => typeof field === 'string' && field.length > 0)
}

export function subscribeBrowserVaultRequests(onRequests: (requests: BrowserVaultRequest[]) => void, onNotices?: (notices: BrowserVaultNotice[]) => void) {
  const source = new EventSource('/api/browser-vault/events')
  source.onmessage = (event) => {
    try {
      const value = JSON.parse(event.data)
      if (Array.isArray(value)) onRequests(value)
    } catch { /* a partial frame is replaced by the next snapshot */ }
  }
  if (onNotices) {
    source.addEventListener('notices', (event) => {
      try {
        const value = JSON.parse((event as MessageEvent<string>).data)
        if (Array.isArray(value)) onNotices(value.filter(isNotice))
      } catch { /* the next snapshot repeats them */ }
    })
  }
  return () => source.close()
}

const SEEN_NOTICES = 'hermesbot:vault-notices-seen'

/**
 * Notices not shown yet in this app, oldest first. The ids already shown are kept (the last 50) so
 * that a reload or a second window does not repeat them; the vault itself forgets them after a day.
 */
export function takeUnseenNotices(notices: BrowserVaultNotice[], storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = globalThis.localStorage) {
  let seen: string[] = []
  try {
    const stored = JSON.parse(storage?.getItem(SEEN_NOTICES) || '[]')
    if (Array.isArray(stored)) seen = stored.filter((id): id is string => typeof id === 'string')
  } catch { /* unreadable: everything still known by the vault is shown once */ }
  const fresh = notices.filter((notice) => !seen.includes(notice.id))
  if (fresh.length) {
    try { storage?.setItem(SEEN_NOTICES, JSON.stringify([...seen, ...fresh.map((notice) => notice.id)].slice(-50))) } catch { /* shown again at the next start */ }
  }
  return fresh
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
  'entry_exists',
  'target_not_found',
  'invalid_settings',
  'settings_write_failed',
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

/** Vault settings, kept and read by the vault itself on the bots' machine. */
export interface VaultSettings {
  /** Sign-ups go through without a card; the user is told afterwards. Off by default. */
  autoSignup: boolean
}

const vaultSettings = (value: unknown): VaultSettings => ({ autoSignup: (value as Partial<VaultSettings> | null)?.autoSignup === true })

export async function getVaultSettings() {
  const result = await vaultRequest<{ settings?: VaultSettings }>('/api/browser-vault/settings')
  return vaultSettings(result.settings)
}

export async function saveVaultSettings(patch: Partial<VaultSettings>) {
  const result = await vaultRequest<{ settings?: VaultSettings }>('/api/browser-vault/settings', patch)
  return vaultSettings(result.settings)
}
