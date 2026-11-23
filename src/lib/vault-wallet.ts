export interface WalletCard {
  id: string
  type: 'card'
  label: string
  holder: string
  last4: string
  expiry: string
  bots: string[]
}

export interface WalletAddress {
  id: string
  type: 'address'
  label: string
  line1: string
  line2?: string
  city: string
  region?: string
  postal: string
  country: string
  bots: string[]
}

export type WalletItem = WalletCard | WalletAddress

async function walletRequest<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'vault_wallet_failed')
  return result as T
}

export async function listWalletItems() {
  const result = await walletRequest<{ items?: WalletItem[] }>('/api/browser-vault/wallet')
  return Array.isArray(result.items) ? result.items : []
}

export async function saveWalletCard(entry: { holder: string; number: string; expiry: string; label: string; bots: string[] }) {
  await walletRequest('/api/browser-vault/wallet/card', entry)
}

export async function saveWalletAddress(entry: { label: string; line1: string; line2?: string; city: string; region?: string; postal: string; country: string; bots: string[] }) {
  await walletRequest('/api/browser-vault/wallet/address', entry)
}

export async function removeWalletItem(id: string) {
  await walletRequest('/api/browser-vault/wallet/remove', { id })
}

export async function submitSecureVaultForm(fields: Record<string, unknown>[], bots: string[]) {
  const result = await walletRequest<{ refs?: { ref: string }[] }>('/api/browser-vault/wallet/secure-form', { fields, bots })
  return Array.isArray(result.refs) ? result.refs : []
}