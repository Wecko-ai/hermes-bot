import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { compactNumber } from '../lib/model'
import { loadGlobalUsage, type GlobalUsageResponse } from '../lib/usage-global'
import type { Bot } from '../types'

interface UsageGlobalSectionProps {
  bots: Bot[]
  days?: number
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="usage-stat"><dt>{label}</dt><dd>{value}</dd></div>
}

export function UsageGlobalSection({ bots, days = 30 }: UsageGlobalSectionProps) {
  const { t } = useTranslation()
  const [data, setData] = useState<GlobalUsageResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const profiles = bots.filter((bot) => !bot.hidden).map((bot) => bot.slug)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    loadGlobalUsage(profiles, days)
      .then((next) => { if (!cancelled) { setData(next); setError(false) } })
      .catch(() => { if (!cancelled) { setData(null); setError(true) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [profiles.join(','), days])

  if (loading && !data) return <p className="settings-note">{t('usageGlobal.loading')}</p>
  if (error || !data) return <p className="settings-note">{t('usageGlobal.unavailable')}</p>

  const total = data.summary.inputTokens + data.summary.outputTokens

  return (
    <section className="usage-global-section">
      <p className="settings-note">{t('usageGlobal.hint')}</p>
      <dl className="usage-grid">
        <Stat label={t('usage.tokensLabel')} value={compactNumber(total)} />
        <Stat label={t('usage.sessions')} value={String(data.summary.sessions)} />
        <Stat label={t('usage.apiCalls')} value={String(data.summary.apiCalls)} />
      </dl>
      {data.quotas.length > 0 && (
        <>
          <h3 className="usage-heading">{t('usageGlobal.quotas')}</h3>
          {data.quotas.map((quota) => (
            <div key={quota.id} className="usage-context" title={t('usageGlobal.quotaDetail', { used: compactNumber(quota.usedTokens), limit: compactNumber(quota.tokenLimit) })}>
              <div><span>{quota.label}</span><strong>{Math.round(quota.usedPercent)} %</strong></div>
              <i role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(quota.usedPercent)}><b style={{ width: `${Math.min(100, quota.usedPercent)}%` }} /></i>
              <small>{t('usageGlobal.quotaWindow', { hours: quota.windowHours })}{quota.estimated ? ` · ${t('usageGlobal.estimated')}` : ''}</small>
            </div>
          ))}
        </>
      )}
      {data.summary.bots.length > 0 && (
        <>
          <h3 className="usage-heading">{t('usageGlobal.byBot')}</h3>
          {data.summary.bots.slice(0, 12).map((row) => (
            <div key={row.profile} className="usage-row">
              <div><span>{row.profile}</span><strong>{compactNumber(row.tokens)}</strong></div>
            </div>
          ))}
        </>
      )}
    </section>
  )
}