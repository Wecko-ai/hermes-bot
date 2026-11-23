import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { HermesClient } from '../lib/hermes'

/** Read-only `approvals.mode` from the gateway. The app never writes it. */
export function ApprovalsSetting({ client, connected }: { client?: HermesClient | null; connected: boolean }) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<string | null>(null)

  useEffect(() => {
    if (!connected || !client) {
      setMode(null)
      return
    }
    let cancelled = false
    void client.request('config.get', { key: 'approvals.mode' })
      .then((result: unknown) => {
        if (cancelled) return
        const value = typeof result === 'object' && result && typeof (result as { value?: unknown }).value === 'string'
          ? (result as { value: string }).value
          : ''
        setMode(value || null)
      })
      .catch(() => { if (!cancelled) setMode(null) })
    return () => { cancelled = true }
  }, [client, connected])

  const readout = !connected
    ? t('settings.approvalsMode.offline')
    : mode
      ? t(`settings.approvalsMode.values.${mode}`, { defaultValue: mode })
      : t('settings.approvalsMode.unknown')

  return (
    <div className="settings-row">
      <div className="settings-row-copy">
        <strong>{t('settings.approvalsMode.label')}</strong>
        <span>{t('settings.approvalsMode.hint')}</span>
      </div>
      <span className="settings-readonly" aria-live="polite">{readout}</span>
    </div>
  )
}