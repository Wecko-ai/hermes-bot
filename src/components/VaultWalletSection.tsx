import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { Bot } from '../types'
import { listWalletItems, removeWalletItem, saveWalletAddress, saveWalletCard, type WalletItem } from '../lib/vault-wallet'

export function VaultWalletSection({ bots }: { bots: Bot[] }) {
  const { t } = useTranslation()
  const [items, setItems] = useState<WalletItem[]>([])
  const [mode, setMode] = useState<'card' | 'address' | null>(null)
  const [error, setError] = useState('')
  const slugs = bots.filter((bot) => !bot.hidden).map((bot) => bot.slug)

  const load = () => listWalletItems().then(setItems).catch(() => setItems([]))
  useEffect(() => { load() }, [])

  const submitCard = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    try {
      await saveWalletCard({
        holder: String(data.get('holder') || ''),
        number: String(data.get('number') || ''),
        expiry: String(data.get('expiry') || ''),
        label: String(data.get('label') || ''),
        bots: slugs,
      })
      setMode(null)
      load()
    } catch {
      setError(t('vaultWallet.saveFailed'))
    }
  }

  const submitAddress = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    try {
      await saveWalletAddress({
        label: String(data.get('label') || ''),
        line1: String(data.get('line1') || ''),
        line2: String(data.get('line2') || ''),
        city: String(data.get('city') || ''),
        postal: String(data.get('postal') || ''),
        country: String(data.get('country') || ''),
        bots: slugs,
      })
      setMode(null)
      load()
    } catch {
      setError(t('vaultWallet.saveFailed'))
    }
  }

  return (
    <section className="vault-wallet-section">
      <p className="settings-note">{t('vaultWallet.note')}</p>
      <div className="vault-wallet-actions">
        <button type="button" className="settings-button" onClick={() => setMode('card')}>{t('vaultWallet.addCard')}</button>
        <button type="button" className="settings-button" onClick={() => setMode('address')}>{t('vaultWallet.addAddress')}</button>
      </div>
      {mode === 'card' && (
        <form className="vault-wallet-form" onSubmit={submitCard}>
          <label>{t('vaultWallet.label')}<input name="label" required /></label>
          <label>{t('vaultWallet.holder')}<input name="holder" required /></label>
          <label>{t('vaultWallet.number')}<input name="number" required autoComplete="off" /></label>
          <label>{t('vaultWallet.expiry')}<input name="expiry" placeholder="MM/YY" required /></label>
          <button type="submit" className="settings-button">{t('vault.save')}</button>
        </form>
      )}
      {mode === 'address' && (
        <form className="vault-wallet-form" onSubmit={submitAddress}>
          <label>{t('vaultWallet.label')}<input name="label" required /></label>
          <label>{t('vaultWallet.line1')}<input name="line1" required /></label>
          <label>{t('vaultWallet.line2')}<input name="line2" /></label>
          <label>{t('vaultWallet.city')}<input name="city" required /></label>
          <label>{t('vaultWallet.postal')}<input name="postal" required /></label>
          <label>{t('vaultWallet.country')}<input name="country" required /></label>
          <button type="submit" className="settings-button">{t('vault.save')}</button>
        </form>
      )}
      {error && <p className="settings-error">{error}</p>}
      <ul className="vault-wallet-list">
        {items.map((item) => (
          <li key={item.id}>
            {item.type === 'card'
              ? <span>{item.label} · {item.holder} ·••• {item.last4} · {item.expiry}</span>
              : <span>{item.label} · {item.line1}, {item.city}</span>}
            <button type="button" onClick={async () => { await removeWalletItem(item.id); load() }}>{t('vault.remove')}</button>
          </li>
        ))}
      </ul>
    </section>
  )
}