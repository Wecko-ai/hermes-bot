import { useEffect, useState } from 'react'
import { BarChart3 } from 'lucide-react'
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

const exact = (value: number) => value.toLocaleString('fr-FR')
const money = (value: number) => `${value.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`

function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return <div className="usage-stat" title={title}><dt>{label}</dt><dd>{value}</dd></div>
}

function tokenStat(label: string, value: number | undefined) {
  return value === undefined ? null : <Stat key={label} label={label} value={compactNumber(value)} title={`${exact(value)} tokens`} />
}

function Row({ label, value, share, title }: { label: string; value: string; share: number; title?: string }) {
  return (
    <div className="usage-row" title={title}>
      <div><span>{label}</span><strong>{value}</strong></div>
      <i><b style={{ width: `${Math.max(1.5, share * 100)}%` }} /></i>
    </div>
  )
}

/** Tous les jours de la période, y compris ceux sans activité : un trou doit se voir. */
function dayRange(history: UsageHistory) {
  const byDay = new Map(history.daily.map((item) => [item.day, item]))
  const today = new Date()
  return Array.from({ length: history.days }, (_, offset) => {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (history.days - 1 - offset))
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    const label = date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })
    return { day, label, tokens: byDay.get(day)?.tokens ?? 0, costUsd: byDay.get(day)?.costUsd ?? 0 }
  })
}

function DailyChart({ history }: { history: UsageHistory }) {
  const days = dayRange(history)
  const peak = Math.max(1, ...days.map((item) => item.tokens))
  const [hovered, setHovered] = useState<(typeof days)[number] | null>(null)
  const readout = (item: (typeof days)[number]) => `${item.label} · ${compactNumber(item.tokens)} tokens${item.costUsd ? ` · ${money(item.costUsd)}` : ''}`
  return (
    <figure className="usage-chart">
      <figcaption>{hovered ? readout(hovered) : `Tokens par jour · pic ${compactNumber(peak)}`}</figcaption>
      <div className="usage-bars" aria-hidden="true" onMouseLeave={() => setHovered(null)}>
        {days.map((item) => (
          <span key={item.day} onMouseEnter={() => setHovered(item)}>
            {item.tokens > 0 && <i style={{ height: `${Math.max(4, (item.tokens / peak) * 100)}%` }} />}
          </span>
        ))}
      </div>
      <div className="usage-axis" aria-hidden="true"><span>{days[0]?.label}</span><span>{days.at(-1)?.label}</span></div>
      <table className="visually-hidden">
        <caption>Tokens par jour</caption>
        <tbody>{days.filter((item) => item.tokens > 0).map((item) => <tr key={item.day}><th>{item.label}</th><td>{exact(item.tokens)}</td></tr>)}</tbody>
      </table>
    </figure>
  )
}

/** Compteurs lus chez Hermes sans appel de modèle : ouvrir l’onglet ne coûte rien. */
export function UsageTab({ slug, running, live, load }: UsageTabProps) {
  const [details, setDetails] = useState<UsageDetails | null>(null)
  const [loading, setLoading] = useState(true)
  // Au changement de bot, puis au début et à la fin de chaque tour.
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
  if (!usage && !history) return <section className="details-section usage-section"><p className="details-empty">Usage indisponible pour ce bot.</p></section>

  return (
    <section className="details-section usage-section">
      <div className="details-section-heading"><span>Bot Chat</span><BarChart3 size={14} /></div>
      {usage && usage.contextMax > 0 && (
        <div className="usage-context" title={`${exact(usage.contextUsed)} / ${exact(usage.contextMax)} tokens`}>
          <div><span>Contexte{usage.contextEstimated ? ' (estimé)' : ''}</span><strong>{Math.round(usage.contextPercent)} %</strong></div>
          <i role="meter" aria-label="Contexte utilisé" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(usage.contextPercent)}><b style={{ width: `${Math.min(100, usage.contextPercent)}%` }} /></i>
          <small>{compactNumber(usage.contextUsed)} / {compactNumber(usage.contextMax)} tokens</small>
        </div>
      )}
      {usage && (
        <dl className="usage-grid">
          {tokenStat('Entrée', usage.inputTokens)}
          {tokenStat('Sortie', usage.outputTokens)}
          {tokenStat('Cache lu', usage.cacheReadTokens)}
          {tokenStat('Cache écrit', usage.cacheWriteTokens)}
          {tokenStat('Raisonnement', usage.reasoningTokens)}
          {tokenStat('Total', usage.totalTokens)}
          {tokenStat('Dernier tour', usage.lastTurnTokens)}
          {usage.apiCalls !== undefined && <Stat label="Appels API" value={exact(usage.apiCalls)} />}
          {usage.compressions !== undefined && <Stat label="Compactions" value={exact(usage.compressions)} />}
          {usage.cacheHitPercent !== undefined && <Stat label="Cache réutilisé" value={`${Math.round(usage.cacheHitPercent)} %`} />}
          {usage.averageTps > 0 && <Stat label="Débit" value={`${Math.round(usage.averageTps)} tok/s`} />}
          {usage.averageLatency !== undefined && <Stat label="Latence" value={`${usage.averageLatency.toLocaleString('fr-FR')} s`} />}
          {usage.activeSubagents !== undefined && <Stat label="Sous-agents" value={exact(usage.activeSubagents)} />}
          {usage.costUsd !== undefined && <Stat label="Coût" value={money(usage.costUsd)} />}
        </dl>
      )}
      {usage?.plan && <p className="usage-note">{usage.plan.label} : {Math.round(usage.plan.usedPercent)} % utilisés{usage.plan.resetsAt ? ` · repart ${dateTime(new Date(usage.plan.resetsAt).toISOString())}` : ''}</p>}

      {context && context.categories.length > 0 && (
        <>
          <h3 className="usage-heading">Ce qui remplit le contexte{context.estimated ? ' (estimé)' : ''}</h3>
          {context.categories.map((item) => <Row key={item.id || item.label} label={item.label} value={compactNumber(item.tokens)} share={item.tokens / largestCategory} title={`${exact(item.tokens)} tokens`} />)}
        </>
      )}
      {context && context.files.length > 0 && (
        <details className="usage-files">
          <summary>Fichiers de contexte ({context.files.length})</summary>
          {context.files.map((file) => <div key={file.label}><span>{file.label}</span><strong>{file.loaded ? compactNumber(file.tokens) : 'non chargé'}</strong></div>)}
        </details>
      )}

      {history && (
        <>
          <h3 className="usage-heading">{history.days} derniers jours, tout le bot</h3>
          <dl className="usage-grid">
            <Stat label="Tokens" value={compactNumber(historyTotal)} title={`${exact(historyTotal)} tokens`} />
            {tokenStat('Cache lu', history.cacheReadTokens)}
            <Stat label="Sessions" value={exact(history.sessions)} />
            <Stat label="Appels API" value={exact(history.apiCalls)} />
            {history.costUsd > 0 && <Stat label="Coût estimé" value={money(history.costUsd)} />}
          </dl>
          {historyTotal > 0 && <DailyChart history={history} />}
          {history.models.length > 0 && <h3 className="usage-heading">Par modèle</h3>}
          {history.models.map((item) => <Row key={item.model} label={modelLabel(item.model)} value={`${compactNumber(item.tokens)}${item.costUsd ? ` · ${money(item.costUsd)}` : ''}`} share={item.tokens / largestModel} title={item.model} />)}
        </>
      )}
    </section>
  )
}
