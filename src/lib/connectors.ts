import { i18n } from '../i18n'
import type { HermesClient } from './hermes'

export interface ConnectorCatalogEntry {
  name: string
  description: string
  auth: string
  requires: string[]
}

export interface ConnectorStatus {
  name: string
  status: string
  oauthNeeded: boolean
  oauthTokensPresent: boolean | null
  envKeys: string[]
  /** When known, API-key connectors are set or still missing (never exposes the value). */
  apiKeyState?: 'set' | 'missing' | 'unknown'
}

async function fetchCatalog(): Promise<ConnectorCatalogEntry[]> {
  const response = await fetch('/api/connectors/catalog', { credentials: 'same-origin' })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : i18n.t('connectors.error.generic'))
  return Array.isArray(body.servers) ? body.servers : []
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown) {
  return typeof value === 'string' ? value : ''
}

export async function loadConnectorCatalog(): Promise<ConnectorCatalogEntry[]> {
  return fetchCatalog()
}

export async function loadConnectorStatuses(client: HermesClient, profile: string): Promise<ConnectorStatus[]> {
  const [list, status, catalog] = await Promise.all([
    client.request<{ servers?: unknown[] }>('mcp.servers.list', { profile }).catch(() => ({ servers: [] })),
    client.request<{ servers?: unknown[] }>('mcp.servers.status', { profile }).catch(() => ({ servers: [] })),
    fetchCatalog().catch(() => []),
  ])
  const configured = new Map((list.servers || []).map((entry) => {
    const row = asObject(entry)
    return [text(row.name), row]
  }))
  const runtime = new Map((status.servers || []).map((entry) => {
    const row = asObject(entry)
    return [text(row.name), text(row.status) || 'configured']
  }))
  const rows = new Map<string, ConnectorStatus>()
  for (const server of catalog) {
    const summary = configured.get(server.name)
    const envKeys = Array.isArray(summary?.env) ? summary.env.filter((item): item is string => typeof item === 'string') : server.requires
    rows.set(server.name, {
      name: server.name,
      status: runtime.get(server.name) || (summary ? 'configured' : 'catalog'),
      oauthNeeded: server.auth === 'oauth',
      oauthTokensPresent: summary?.oauth_tokens_present === true ? true : summary?.oauth_tokens_present === false ? false : null,
      envKeys,
    })
  }
  for (const [name, summary] of configured) {
    if (rows.has(name)) continue
    rows.set(name, {
      name,
      status: runtime.get(name) || 'configured',
      oauthNeeded: text(summary.auth) === 'oauth',
      oauthTokensPresent: summary.oauth_tokens_present === true ? true : summary.oauth_tokens_present === false ? false : null,
      envKeys: Array.isArray(summary.env) ? summary.env.filter((item): item is string => typeof item === 'string') : [],
    })
  }
  return [...rows.values()].sort((left, right) => left.name.localeCompare(right.name))
}

export async function addConnectorPreset(client: HermesClient, profile: string, name: string) {
  return client.request('mcp.servers.add', { profile, name, preset: name })
}

export async function startConnectorOAuth(client: HermesClient, profile: string, name: string) {
  return client.request<{ auth_url?: string; session_id?: string }>('mcp.servers.oauth.start', { profile, name })
}

export async function pollConnectorOAuth(client: HermesClient, profile: string, name: string, sessionId: string) {
  return client.request<{ status?: string; error?: string }>('mcp.servers.oauth.poll', { profile, name, session_id: sessionId })
}

export async function removeConnector(client: HermesClient, profile: string, name: string) {
  return client.request('mcp.servers.remove', { profile, name })
}

/** Store a connector credential via the gateway (one-shot RPC; the app never keeps the value). */
export async function setConnectorApiKey(client: HermesClient, profile: string, name: string, value: string, envVar?: string) {
  const params: Record<string, string> = { profile, name, value }
  if (envVar) params.env_var = envVar
  return client.request<{ ok?: boolean; env_var?: string }>('mcp.servers.set_api_key', params)
}

/** Probe a connector without logging secrets; `ok: true` implies required keys are present. */
export async function probeConnector(client: HermesClient, profile: string, name: string) {
  return client.request<{ ok?: boolean; oauth_needed?: boolean; oauth_tokens_present?: boolean | null }>('mcp.servers.test', { profile, name }, 20_000)
}

export async function connectorApiKeyState(client: HermesClient, profile: string, name: string, oauthNeeded: boolean): Promise<'set' | 'missing' | 'unknown'> {
  if (oauthNeeded) return 'unknown'
  try {
    const probe = await probeConnector(client, profile, name)
    if (probe.ok === true) return 'set'
    if (probe.oauth_needed && probe.oauth_tokens_present === false) return 'missing'
    return 'missing'
  } catch {
    return 'unknown'
  }
}

/** Hermes CLI when the gateway RPC is unavailable (placeholders only). */
export function connectorApiKeyCli(profile: string, name: string, envVar: string) {
  return `hermes -p ${profile} mcp set-api-key ${name} --env ${envVar}`
}