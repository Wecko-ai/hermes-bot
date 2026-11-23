import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppConfig } from '../lib/app-config'
import { parseVaultFormBlocks, vaultFormAcknowledgement, VAULT_FORM_FENCE, type VaultFormBlock } from '../lib/vault-form'
import { submitSecureVaultForm } from '../lib/vault-wallet'

interface SecureVaultFormCardProps {
  block: VaultFormBlock
  bot: string
  onDone: (refs: { ref: string }[]) => void
}

export function SecureVaultFormCard({ block, bot, onDone }: SecureVaultFormCardProps) {
  const { t } = useTranslation()
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    for (const field of block.fields) {
      if (!field.optional && !values[field.key]?.trim()) {
        setError(t('secureVault.missing', { label: field.label }))
        return
      }
    }
    setBusy(true)
    setError('')
    try {
      const fields = block.fields.map((field) => ({
        key: field.key,
        kind: field.kind,
        label: field.label,
        value: values[field.key],
        ...(field.kind === 'card' ? { holder: values[`${field.key}:holder`] || 'Cardholder', expiry: values[`${field.key}:expiry`] || '01/99' } : {}),
      }))
      const refs = await submitSecureVaultForm(fields, [bot])
      onDone(refs)
    } catch {
      setError(t('secureVault.failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="request-card secure-vault-card" onSubmit={submit}>
      <h3>{block.title}</h3>
      <p className="settings-note">{t('secureVault.note')}</p>
      {block.fields.map((field) => (
        <label key={field.key}>
          <span>{field.label}{field.optional ? ` (${t('secureVault.optional')})` : ''}</span>
          {field.kind === 'card' ? (
            <>
              <input type="text" autoComplete="off" inputMode="numeric" placeholder={t('secureVault.cardNumber')} value={values[field.key] || ''} onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))} />
              <input type="text" autoComplete="off" placeholder={t('secureVault.cardHolder')} value={values[`${field.key}:holder`] || ''} onChange={(event) => setValues((current) => ({ ...current, [`${field.key}:holder`]: event.target.value }))} />
              <input type="text" autoComplete="off" placeholder={t('secureVault.cardExpiry')} value={values[`${field.key}:expiry`] || ''} onChange={(event) => setValues((current) => ({ ...current, [`${field.key}:expiry`]: event.target.value }))} />
            </>
          ) : (
            <input type={field.kind === 'text' ? 'text' : 'text'} autoComplete="off" value={values[field.key] || ''} onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))} />
          )}
        </label>
      ))}
      {error && <p className="settings-error">{error}</p>}
      <button type="submit" className="settings-button" disabled={busy}>{busy ? t('secureVault.saving') : t('secureVault.submit')}</button>
    </form>
  )
}

export function VaultFormBlock({ source, profile, streaming, onDone }: { source: string; profile: string; streaming?: boolean; onDone: (message: string) => void }) {
  const config = useAppConfig()
  const block = parseVaultFormBlocks(`\`\`\`${VAULT_FORM_FENCE}\n${source}\n\`\`\``)[0]
  if (!config.features.vaultWallet || streaming || !block) return null
  return <SecureVaultFormCard block={block} bot={profile} onDone={(refs) => onDone(vaultFormAcknowledgement(block.title, refs))} />
}