import type { UsageQuotaConfig } from './app-config'

export interface UsageQuotaGauge extends UsageQuotaConfig {
  usedTokens: number
  usedPercent: number
  resetsAt: number | null
  estimated: boolean
}

export interface GlobalUsageSummary {
  days: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  reasoningTokens: number
  costUsd: number
  sessions: number
  apiCalls: number
  bots: { profile: string; tokens: number; inputTokens: number; outputTokens: number; costUsd: number; sessions: number; apiCalls: number }[]
  daily: { day: string; tokens: number; costUsd: number }[]
  models: { model: string; tokens: number; costUsd: number }[]
}

export interface GlobalUsageResponse {
  summary: GlobalUsageSummary
  quotas: UsageQuotaGauge[]
}

export async function loadGlobalUsage(profiles: string[], days = 30): Promise<GlobalUsageResponse> {
  const response = await fetch(`/api/usage/global?${new URLSearchParams({
    days: String(days),
    profiles: profiles.join(','),
  })}`, { credentials: 'same-origin' })
  if (!response.ok) throw new Error('usage_global_unavailable')
  return response.json() as Promise<GlobalUsageResponse>
}