import { useEffect, useState } from 'react'
import { BarChart3 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { i18n, locale } from '../i18n'
import type { ContextBreakdown, SessionUsage, UsageHistory } from '../types'
import { compactNumber, modelLabel } from '../lib/model'
import { mergeUsage } from '../lib/hermes'
import { dateTime } from '../lib/time'

export interface UsageDetails {
  usage: SessionUsage | null
  context: ContextBreakdown | null
  history: UsageHistory | null
}

interface UsageTabProps {
  slug: string
  running: boolean
  live: SessionUsage | null
  load: () => Promise<UsageDetails>
}

const exact = (value: number) => value.toLocaleString(locale())
const money = (value: number) => i18n.t('usage.money', { value: value.toLocaleString(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }) })
const tokensTitle = (value: number) => i18n.t('usage.tokens', { value: exact(value) })

function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return <div className="usage-stat" title={title}><dt>{label}</dt><dd>{value}</dd></div>
}

function tokenStat(label: string, value: number | undefined) {
  return value === undefined ? null : <Stat key={label} label={label} value={compactNumber(value)} title={tokensTitle(value)} />
}

function Row({ label, value, share, title }: { label: string; value: string; share: number; title?: string }) {
  return (
    <div className="usage-row" title={title}>
      <div><span>{label}</span><strong>{value}</strong></div>
      <i><b style={{ width: `${Math.max(1.5, share * 100)}%` }} /></i>
    </div>
  )
}

/** Every day of the period, including those without activity: a gap should show. */
function dayRange(history: UsageHistory) {
  const byDay = new Map(history.daily.map((item) => [item.day, item]))
  const today = new Date()
  return Array.from({ length: history.days }, (_, offset) => {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (history.days - 1 - offset))
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    const label = date.toLocaleDateString(locale(), { day: 'numeric', month: 'short' })
    return { day, label, tokens: byDay.get(day)?.tokens ?? 0, costUsd: byDay.get(day)?.costUsd ?? 0 }
  })
}

function DailyChart({ history }: { history: UsageHistory }) {
  const { t } = useTranslation()
  const days = dayRange(history)
  const peak = Math.max(1, ...days.map((item) => item.tokens))
  const [hovered, setHovered] = useState<(typeof days)[number] | null>(null)
  const readout = (item: (typeof days)[number]) => `${item.label} · ${t('usage.tokens', { value: compactNumber(item.tokens) })}${item.costUsd ? ` · ${money(item.costUsd)}` : ''}`
  return (
    <figure className="usage-chart">
      <figcaption>{hovered ? readout(hovered) : t('usage.tokensPerDayPeak', { peak: compactNumber(peak) })}</figcaption>
      <div className="usage-bars" aria-hidden="true" onMouseLeave={() => setHovered(null)}>
        {days.map((item) => (
          <span key={item.day} onMouseEnter={() => setHovered(item)}>
            {item.tokens > 0 && <i style={{ height: `${Math.max(4, (item.tokens / peak) * 100)}%` }} />}
          </span>
        ))}
      </div>
      <div className="usage-axis" aria-hidden="true"><span>{days[0]?.label}</span><span>{days.at(-1)?.label}</span></div>
      <table className="visually-hidden">
        <caption>{t('usage.tokensPerDay')}</caption>
        <tbody>{days.filter((item) => item.tokens > 0).map((item) => <tr key={item.day}><th>{item.label}</th><td>{exact(item.tokens)}</td></tr>)}</tbody>
      </table>
    </figure>
  )
}

/** Counters read from Hermes without any model call: opening the tab costs nothing. */
export function UsageTab({ slug, running, live, load }: UsageTabProps) {
  const { t } = useTranslation()
  const [details, setDetails] = useState<UsageDetails | null>(null)
  const [loading, setLoading] = useState(true)
  // When the bot changes, then at the start and end of each turn.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    load().then((next) => { if (!cancelled) setDetails(next) }).catch(() => { if (!cancelled) setDetails(null) }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [slug, running])
  const usage = mergeUsage(details?.usage ?? null, live)
  const context = details?.context
  const history = details?.history
  const largestCategory = Math.max(1, ...(context?.categories.map((item) => item.tokens) ?? []))
  const largestModel = Math.max(1, ...(history?.models.map((item) => item.tokens) ?? []))
  const historyTotal = (history?.inputTokens ?? 0) + (history?.outputTokens ?? 0)

  if (loading && !details && !live) return <section className="details-section usage-section"><div className="routine-loading"><span /><span /><span /></div></section>
  if (!usage && !history) return <section className="details-section usage-section"><p className="details-empty">{t('usage.unavailable')}</p></section>

  return (
    <section className="details-section usage-section">
      <div className="details-section-heading"><span>{t('usage.heading')}</span><BarChart3 size={14} /></div>
      {usage && usage.contextMax > 0 && (
        <div className="usage-context" title={t('usage.contextTokens', { used: exact(usage.contextUsed), max: exact(usage.contextMax) })}>
          <div><span>{usage.contextEstimated ? t('usage.contextEstimated') : t('usage.context')}</span><strong>{Math.round(usage.contextPercent)} %</strong></div>
          <i role="meter" aria-label={t('usage.contextUsed')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(usage.contextPercent)}><b style={{ width: `${Math.min(100, usage.contextPercent)}%` }} /></i>
          <small>{t('usage.contextTokens', { used: compactNumber(usage.contextUsed), max: compactNumber(usage.contextMax) })}</small>
        </div>
      )}
      {usage && (
        <dl className="usage-grid">
          {tokenStat(t('usage.input'), usage.inputTokens)}
          {tokenStat(t('usage.output'), usage.outputTokens)}
          {tokenStat(t('usage.cacheRead'), usage.cacheReadTokens)}
          {tokenStat(t('usage.cacheWrite'), usage.cacheWriteTokens)}
          {tokenStat(t('usage.reasoning'), usage.reasoningTokens)}
          {tokenStat(t('usage.total'), usage.totalTokens)}
          {tokenStat(t('usage.lastTurn'), usage.lastTurnTokens)}
          {usage.apiCalls !== undefined && <Stat label={t('usage.apiCalls')} value={exact(usage.apiCalls)} />}
          {usage.compressions !== undefined && <Stat label={t('usage.compressions')} value={exact(usage.compressions)} />}
          {usage.cacheHitPercent !== undefined && <Stat label={t('usage.cacheHit')} value={`${Math.round(usage.cacheHitPercent)} %`} />}
          {usage.averageTps > 0 && <Stat label={t('usage.throughput')} value={`${Math.round(usage.averageTps)} tok/s`} />}
          {usage.averageLatency !== undefined && <Stat label={t('usage.latency')} value={`${usage.averageLatency.toLocaleString(locale())} s`} />}
          {usage.activeSubagents !== undefined && <Stat label={t('usage.subagents')} value={exact(usage.activeSubagents)} />}
          {usage.costUsd !== undefined && <Stat label={t('usage.cost')} value={money(usage.costUsd)} />}
        </dl>
      )}
      {usage?.plan && <p className="usage-note">{t('usage.planUsed', { label: usage.plan.label, percent: Math.round(usage.plan.usedPercent) })}{usage.plan.resetsAt ? t('usage.planResets', { date: dateTime(new Date(usage.plan.resetsAt).toISOString()) }) : ''}</p>}

      {context && context.categories.length > 0 && (
        <>
          <h3 className="usage-heading">{context.estimated ? t('usage.fillsContextEstimated') : t('usage.fillsContext')}</h3>
          {context.categories.map((item) => <Row key={item.id || item.label} label={item.label} value={compactNumber(item.tokens)} share={item.tokens / largestCategory} title={tokensTitle(item.tokens)} />)}
        </>
      )}
      {context && context.files.length > 0 && (
        <details className="usage-files">
          <summary>{t('usage.contextFiles', { count: context.files.length })}</summary>
          {context.files.map((file) => <div key={file.label}><span>{file.label}</span><strong>{file.loaded ? compactNumber(file.tokens) : t('usage.notLoaded')}</strong></div>)}
        </details>
      )}

      {history && (
        <>
          <h3 className="usage-heading">{t('usage.lastDays', { days: history.days })}</h3>
          <dl className="usage-grid">
            <Stat label={t('usage.tokensLabel')} value={compactNumber(historyTotal)} title={tokensTitle(historyTotal)} />
            {tokenStat(t('usage.cacheRead'), history.cacheReadTokens)}
            <Stat label={t('usage.sessions')} value={exact(history.sessions)} />
            <Stat label={t('usage.apiCalls')} value={exact(history.apiCalls)} />
            {history.costUsd > 0 && <Stat label={t('usage.estimatedCost')} value={money(history.costUsd)} />}
          </dl>
          {historyTotal > 0 && <DailyChart history={history} />}
          {history.models.length > 0 && <h3 className="usage-heading">{t('usage.byModel')}</h3>}
          {history.models.map((item) => <Row key={item.model} label={modelLabel(item.model)} value={`${compactNumber(item.tokens)}${item.costUsd ? ` · ${money(item.costUsd)}` : ''}`} share={item.tokens / largestModel} title={item.model} />)}
        </>
      )}
    </section>
  )
}
