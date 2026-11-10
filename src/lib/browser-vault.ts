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
    } catch { /* une trame incomplète est remplacée par le prochain snapshot */ }
  }
  return () => source.close()
}

const ERRORS: Record<string, string> = {
  request_not_found: 'Cette demande a expiré.',
  request_busy: 'Cette demande est déjà en cours.',
  origin_mismatch: 'Le site affiché a changé. Remplissage refusé.',
  origin_not_found: 'Aucun identifiant enregistré pour ce site.',
  invalid_origin: 'Adresse du site invalide : https://exemple.com',
  invalid_credentials: 'Identifiant ou mot de passe invalide.',
  invalid_bots: 'Choisis au moins un bot.',
  vault_unavailable: 'Le trousseau de la machine des bots est inaccessible.',
  vault_write_failed: 'Le trousseau de la machine des bots a refusé l’écriture.',
  vault_service_unavailable: 'Le coffre de la machine des bots ne répond pas. Depuis un autre Mac, ↻ relance le tunnel.',
  login_fields_not_found: 'Aucun champ de connexion trouvé.',
  code_field_not_found: 'Aucun champ de code trouvé.',
  cdp_unavailable: 'Le Chrome des bots ne répond pas.',
}

/** Identifiant du coffre, sans mot de passe : celui-ci reste dans le trousseau de la machine des bots. */
export interface VaultEntry {
  id: string
  origin: string
  identifier: string
  /** Bots autorisés à l’utiliser ; `*` pour tous. */
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
    throw new Error(ERRORS[code] || 'Le coffre a refusé la demande.')
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

/** Sans `password`, le mot de passe enregistré est gardé. */
export async function saveVaultEntry(entry: { origin: string; identifier: string; password?: string; bots: string[] }) {
  await vaultRequest('/api/browser-vault/entries', entry)
}

export async function removeVaultEntry(origin: string) {
  await vaultRequest('/api/browser-vault/entries/remove', { origin })
}
