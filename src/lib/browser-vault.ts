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
  vault_unavailable: 'Le chiffrement macOS est indisponible.',
  vault_corrupt: 'Le coffre est illisible. Aucune entrée n’a été écrasée.',
  login_fields_not_found: 'Aucun champ de connexion trouvé.',
  code_field_not_found: 'Aucun champ de code trouvé.',
  cdp_unavailable: 'Le Chrome des bots ne répond pas.',
}

export async function respondBrowserVault(id: string, body: Record<string, unknown>) {
  const response = await fetch(`/api/browser-vault/requests/${encodeURIComponent(id)}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) {
    const code = typeof result.error === 'string' ? result.error : ''
    throw new Error(ERRORS[code] || 'Le coffre a refusé la demande.')
  }
}
