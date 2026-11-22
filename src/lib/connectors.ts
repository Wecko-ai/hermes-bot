import type { Bot } from '../types'

export type ConnectorStatus = 'connected' | 'needs_auth' | 'error' | 'off' | 'available' | 'unknown'

export interface ConnectorBotState {
  profile: string
  installed: boolean
  enabled: boolean
  status: ConnectorStatus
  error: string
}

export interface ConnectorEnvPrompt {
  name: string
  prompt: string
  required: boolean
}

export interface Connector {
  name: string
  description: string
  authType: string
  transport: string
  endpoint: string
  requiredEnv: ConnectorEnvPrompt[]
  postInstall: string
  bots: ConnectorBotState[]
}

export interface ConnectorCatalog {
  entries: Connector[]
  unsupported: string[]
  failed: string[]
  diagnostics: { name: string; kind: string; message: string }[]
}

const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/

export function connectorProfiles(bots: Bot[]) {
  return bots.filter((bot) => PROFILE_ID.test(bot.slug))
}

export function countStatuses(bots: ConnectorBotState[]) {
  const counts: Record<ConnectorStatus, number> = { connected: 0, needs_auth: 0, error: 0, off: 0, available: 0, unknown: 0 }
  for (const bot of bots) counts[bot.status] += 1
  return counts
}

/** What Connect has to do. A stored sign-in is never part of the plan: Hermes keeps it. */
export function connectSteps(entry: Connector, profile: string): Array<'install' | 'oauth'> {
  const bot = entry.bots.find((item) => item.profile === profile)
  const steps: Array<'install' | 'oauth'> = []
  if (!bot?.installed) steps.push('install')
  if (entry.authType === 'oauth' && bot?.status !== 'connected' && bot?.status !== 'off') steps.push('oauth')
  return steps
}

export function canConnect(entry: Connector, profile: string) {
  const bot = entry.bots.find((item) => item.profile === profile)
  if (!bot) return false
  if (!bot.installed) return true
  return entry.authType === 'oauth' && (bot.status === 'needs_auth' || bot.status === 'error')
}

export function missingEnv(entry: Connector, values: Record<string, string>) {
  return entry.requiredEnv.filter((item) => item.required && !values[item.name]?.trim()).map((item) => item.name)
}

export function overlayProbes(entries: Connector[], results: Record<string, Record<string, { status: ConnectorStatus; error: string }>>): Connector[] {
  return entries.map((entry) => ({
    ...entry,
    bots: entry.bots.map((bot) => {
      const next = results[bot.profile]?.[entry.name]
      if (!next) return bot
      return { ...bot, status: next.status, error: next.error }
    }),
  }))
}

export function openAuthorization(url: string) {
  if (!/^https?:\/\//i.test(url)) return false
  window.open(url, '_blank', 'noopener,noreferrer')
  return true
}

export async function waitForGrant(
  read: (flowId: string) => Promise<{ status: string; error: string }>,
  flowId: string,
  options: { attempts?: number; wait: (ms: number) => Promise<void>; aborted?: () => boolean },
) {
  const attempts = options.attempts ?? 90
  let last = { status: 'starting', error: '' }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (options.aborted?.()) return { status: 'error', error: '' }
    last = await read(flowId)
    if (last.status === 'approved' || last.status === 'error') return last
    await options.wait(2_000)
  }
  return last.status === 'approved' ? last : { status: 'error', error: last.error }
}

async function send<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(typeof body.message === 'string' && body.message ? body.message : 'rejected') as Error & { code?: string }
    error.code = typeof body.error === 'string' ? body.error : 'rejected'
    throw error
  }
  return body as T
}

export function loadConnectors(profiles: string[]) {
  const query = new URLSearchParams({ profiles: profiles.join(',') })
  return send<ConnectorCatalog>(`/api/connectors?${query}`)
}

export function installConnector(name: string, profile: string, env: Record<string, string>) {
  const payload: { name: string; profile: string; enable: boolean; env?: Record<string, string> } = { name, profile, enable: true }
  if (Object.keys(env).length) payload.env = env
  return send<{ ok: boolean; background: boolean }>('/api/connectors/install', { method: 'POST', body: JSON.stringify(payload) })
}

export function startConnectorAuth(name: string, profile: string) {
  return send<{ flowId: string; status: string; authorizationUrl: string; error: string }>('/api/connectors/auth', {
    method: 'POST', body: JSON.stringify({ name, profile }),
  })
}

export function readConnectorAuth(flowId: string) {
  return send<{ status: string; error: string }>(`/api/connectors/oauth/${encodeURIComponent(flowId)}`)
}

export function setConnectorEnabled(name: string, profile: string, enabled: boolean) {
  return send<{ ok: boolean }>('/api/connectors/enabled', { method: 'PUT', body: JSON.stringify({ name, profile, enabled }) })
}

export function disconnectConnector(name: string, profile: string) {
  const query = new URLSearchParams({ name, profile })
  return send<{ ok: boolean }>(`/api/connectors?${query}`, { method: 'DELETE' })
}

export function probeConnectors(profiles: string[], names: string[]) {
  return send<{ results: Record<string, Record<string, { status: ConnectorStatus; error: string }>> }>('/api/connectors/status', {
    method: 'POST', body: JSON.stringify({ profiles, names }),
  })
}

/** Fictional catalog for the visual demo. Nothing is installed and no page opens. */
export function demoConnectors(bots: Bot[]): Connector[] {
  const profiles = connectorProfiles(bots).map((bot) => bot.slug)
  const state = (profile: string, installed: boolean, enabled: boolean, status: ConnectorStatus): ConnectorBotState => ({
    profile, installed, enabled, status, error: status === 'error' ? 'The service did not answer.' : '',
  })
  const botsFor = (pick: (profile: string) => ConnectorBotState) => profiles.map(pick)
  return [
    {
      name: 'harbor', description: 'A mailbox the bot can read.', authType: 'oauth', transport: 'http', endpoint: 'mcp.example.test',
      requiredEnv: [], postInstall: '', bots: botsFor((profile) => profile === 'orion'
        ? state(profile, true, true, 'needs_auth')
        : state(profile, profile === 'nova', profile === 'nova', profile === 'nova' ? 'connected' : 'available')),
    },
    {
      name: 'ledger', description: 'A notebook of figures.', authType: 'none', transport: 'stdio', endpoint: 'ledger',
      requiredEnv: [], postInstall: '', bots: botsFor((profile) => state(profile, profile !== 'sage', profile === 'nova', profile === 'nova' ? 'connected' : profile === 'sage' ? 'available' : 'off')),
    },
  ]
}
