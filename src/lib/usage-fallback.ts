import type { SessionUsage } from '../types'

/** Compares configured model id with live stats model to surface provider fallback. */
export function usageLooksLikeFallback(configuredModel: string | undefined, usage: SessionUsage | null | undefined) {
  if (!usage?.model || !configuredModel) return false
  const normalize = (value: string) => {
    const bare = value.toLowerCase().replace(/^custom:/, '').split('/').filter(Boolean)
    return bare.length ? bare[bare.length - 1] : ''
  }
  return normalize(usage.model) !== normalize(configuredModel)
}