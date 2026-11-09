import type { SessionUsage } from '../types'

export function modelLabel(model: string) {
  const name = model.split('/').pop() || model
  const claude = name.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?/i)
  if (!claude) return name
  return `${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`
}

function compact(value: number) {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`
  return String(Math.round(value))
}

export function formatUsage(usage: SessionUsage | null) {
  const context = usage?.contextMax
    ? `Contexte ${Math.round(usage.contextPercent)} % (${compact(usage.contextUsed)}/${compact(usage.contextMax)})`
    : 'Contexte —'
  return `${context} · ${usage?.averageTps ? Math.round(usage.averageTps) : '—'} tok/s`
}
