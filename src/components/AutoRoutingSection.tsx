import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { loadAutoRoutingLog, type AutoRoutingLogResponse } from '../lib/auto-router'
import { modelLabel } from '../lib/model'
import { useAppConfig } from '../lib/app-config'

export function AutoRoutingSection({ days = 7 }: { days?: number }) {
  const { t } = useTranslation()
  const autoRouter = useAppConfig().autoRouter
  const enabled = autoRouter?.enabled === true
  const [data, setData] = useState<AutoRoutingLogResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!enabled) return () => {}
    let cancelled = false
    setLoading(true)
    loadAutoRoutingLog(days)
      .then((next) => { if (!cancelled) { setData(next); setError(false) } })
      .catch(() => { if (!cancelled) { setData(null); setError(true) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [enabled, days])

  if (!enabled) return null
  if (loading && !data) return <p className="settings-note">{t('autoRouter.loading')}</p>
  if (error || !data) return <p className="settings-note">{t('autoRouter.unavailable')}</p>

  return (
    <section className="usage-auto-router-section">
      <h3 className="usage-heading">{t('autoRouter.title')}</h3>
      <p className="settings-note">{t('autoRouter.hint')}</p>
      {autoRouter?.tablePath && (
        <p className="settings-note"><span className="settings-label">{t('autoRouter.tablePath')}</span> <code className="settings-path">{autoRouter.tablePath}</code></p>
      )}
      <dl className="usage-grid">
        <div className="usage-stat"><dt>{t('autoRouter.routed')}</dt><dd>{data.summary.total}</dd></div>
        <div className="usage-stat"><dt>{t('autoRouter.fallbacks')}</dt><dd>{data.summary.fallbacks}</dd></div>
        <div className="usage-stat"><dt>{t('autoRouter.estimatedCost')}</dt><dd>{data.summary.costUsd.toFixed(4)}</dd></div>
      </dl>
      {data.summary.byModel.length > 0 && (
        <div className="usage-auto-router-table">
          {data.summary.byModel.slice(0, 12).map((row) => (
            <div key={row.model} className="usage-row">
              <div><span title={row.model}>{modelLabel(row.model)}</span><strong>{row.count}{row.errors ? ` · ${row.errors} err` : ''}</strong></div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}