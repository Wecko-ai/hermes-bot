import type { SessionUsage } from '../types'
import { i18n } from '../i18n'
import { DOTTED_PREFIX, prettyModelName } from './model-names'

export function modelLabel(model: string) {
  if (/^hermesbot[:/](delegate|oyakata|chef-qwen)$/i.test(model.trim())) return 'Delegate'
  const name = (model.split('/').pop() || model).replace(DOTTED_PREFIX, '')
  // One or two digits for the version: `-20250514` is a date, `.1` a version.
  const claude = name.match(/^claude-([a-z]+)-(\d+)(?:[-.](\d{1,2})(?!\d))?/i)
  if (claude) return `${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`
  return prettyModelName(model)
}

/** The composer's chip: a model served through the Cursor subscription says so, next to the same model's API route. */
export function chipModelLabel(model: string) {
  return /^cursor\//i.test(model) ? `${modelLabel(model)} · Cursor` : modelLabel(model)
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
  const tps = usage?.averageTps ?? 0
  if (!(tps > 0)) return context
  return `${context} · ${Math.round(tps)} tok/s`
}
