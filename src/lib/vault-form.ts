export type VaultFormFieldKind = 'text' | 'card' | 'address'

export interface VaultFormField {
  key: string
  kind: VaultFormFieldKind
  label: string
  optional?: boolean
}

export interface VaultFormBlock {
  id: string
  title: string
  fields: VaultFormField[]
}

export const VAULT_FORM_FENCE = 'hermes-vault-form'

const BLOCK = /```hermes-vault-form\n([\s\S]*?)```/g

function parseField(line: string): VaultFormField | null {
  const match = /^-\s+key:\s*(\w+)\s+kind:\s*(\w+)\s+label:\s*(.+?)(?:\s+optional:\s*true)?\s*$/i.exec(line.trim())
  if (!match) return null
  const kind = match[2].toLowerCase()
  if (kind !== 'text' && kind !== 'card' && kind !== 'address') return null
  return { key: match[1], kind, label: match[3].trim(), optional: /optional:\s*true/i.test(line) }
}

/** Parses a secure vault form block from a bot message (public contract in skills/vault-secure-form). */
export function parseVaultFormBlocks(text: string): VaultFormBlock[] {
  const blocks: VaultFormBlock[] = []
  for (const match of text.matchAll(BLOCK)) {
    const lines = match[1].split('\n').map((line) => line.trim()).filter(Boolean)
    const id = lines.find((line) => line.startsWith('id:'))?.slice(3).trim() || ''
    const title = lines.find((line) => line.startsWith('title:'))?.slice(6).trim() || ''
    const fields = lines.filter((line) => line.startsWith('- key:')).map(parseField).filter((field): field is VaultFormField => Boolean(field))
    if (id && title && fields.length) blocks.push({ id, title, fields })
  }
  return blocks
}

export function vaultFormAcknowledgement(title: string, refs: { ref: string }[]) {
  const list = refs.map((item) => item.ref).join(', ')
  return `[HermesBot vault] Secure form "${title}" stored. Refs: ${list}. Raw values never leave the vault.`
}