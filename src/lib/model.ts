import type { SessionUsage } from '../types'
import { i18n } from '../i18n'

export function modelLabel(model: string) {
  const name = model.split('/').pop() || model
  // One or two digits for the version: `-20250514` is a date, `.1` a version.
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
    ? i18n.t('models.contextPercent', { percent: Math.round(usage.contextPercent), used: compactNumber(usage.contextUsed), max: compactNumber(usage.contextMax) })
    : i18n.t('models.contextNone')
  return `${context} · ${usage?.averageTps ? Math.round(usage.averageTps) : '—'} tok/s`
}
