import type { SessionUsage } from '../types'

export function modelLabel(model: string) {
  const name = model.split('/').pop() || model
  // Un ou deux chiffres pour la version : `-20250514` est une date, `.1` une version.
  const claude = name.match(/^claude-([a-z]+)-(\d+)(?:[-.](\d{1,2})(?!\d))?/i)
  const kimiPro = name.match(/^k(\d+(?:\.\d+)?)-pro$/i)
  if (kimiPro) return `K${kimiPro[1]} Pro`
  if (!claude) return name
  return `${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`
}

export function compactNumber(value: number) {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`
  return String(Math.round(value))
}

export function formatUsage(usage: SessionUsage | null) {
  const context = usage?.contextMax
    ? `Contexte ${Math.round(usage.contextPercent)} % (${compactNumber(usage.contextUsed)}/${compactNumber(usage.contextMax)})`
    : 'Contexte —'
  return `${context} · ${usage?.averageTps ? Math.round(usage.averageTps) : '—'} tok/s`
}
