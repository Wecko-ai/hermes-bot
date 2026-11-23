import type { SessionUsage } from '../types'

/** Compares configured model id with live stats model to surface provider fallback. */
export function usageLooksLikeFallback(configuredModel: string | undefined, usage: SessionUsage | null | undefined) {
  if (!usage?.model || !configuredModel) return false
  const normalize = (value: string) => value.toLowerCase().replace(/^custom:/, '').split('/').filter(Boolean).join('/')
  return normalize(usage.model) !== normalize(configuredModel)
}