import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { HermesRpcError, type HermesClient } from '../lib/hermes'
import {
  addConnectorPreset,
  connectorApiKeyCli,
  connectorApiKeyState,
  loadConnectorCatalog,
  loadConnectorStatuses,
  pollConnectorOAuth,
  removeConnector,
  setConnectorApiKey,
  startConnectorOAuth,
  type ConnectorCatalogEntry,
  type ConnectorStatus,
} from '../lib/connectors'

interface ConnectorsTabProps {
  profile: string
  client: HermesClient | null
  enabled: boolean
}

function statusLabel(row: ConnectorStatus, t: (key: string) => string) {
  if (row.status === 'connected') return t('connectors.status.connected')
  if (row.status === 'failed') return t('connectors.status.error')
  if (row.oauthNeeded && row.oauthTokensPresent === false) return t('connectors.status.needsAuth')
  if (row.status === 'configured') return t('connectors.status.configured')
  return t('connectors.status.available')
}

export function ConnectorsTab({ profile, client, enabled }: ConnectorsTabProps) {
  const { t } = useTranslation()
  const [catalog, setCatalog] = useState<ConnectorCatalogEntry[]>([])
  const [rows, setRows] = useState<ConnectorStatus[]>([])
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [apiDraft, setApiDraft] = useState<Record<string, string>>({})
  const [apiBusy, setApiBusy] = useState('')
  const [unsupportedApi, setUnsupportedApi] = useState(false)

  const refresh = useCallback(async () => {
    if (!enabled) return
    setError('')
    try {
      const [entries, statuses] = await Promise.all([
        loadConnectorCatalog(),
        client ? loadConnectorStatuses(client, profile) : Promise.resolve([]),
      ])
      setCatalog(entries)
      if (client) {
        const enriched = await Promise.all(statuses.map(async (row) => {
          if (row.oauthNeeded || row.envKeys.length === 0 || row.status === 'catalog') return row
          const apiKeyState = await connectorApiKeyState(client, profile, row.name, false)
          return { ...row, apiKeyState }
        }))
        setRows(enriched)
      } else setRows(statuses)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('connectors.error.generic'))
    }
  }, [client, enabled, profile, t])

  useEffect(() => { void refresh() }, [refresh])

  const list = useMemo(() => {
    const lower = query.trim().toLowerCase()
    const merged = new Map<string, ConnectorCatalogEntry & { status?: ConnectorStatus }>()
    for (const entry of catalog) merged.set(entry.name, { ...entry })
    for (const row of rows) {
      const current = merged.get(row.name) || { name: row.name, description: row.name, auth: row.oauthNeeded ? 'oauth' : 'none', requires: row.envKeys }
      merged.set(row.name, { ...current, status: row })
    }
    return [...merged.values()]
      .filter((entry) => !lower || entry.name.toLowerCase().includes(lower) || entry.description.toLowerCase().includes(lower))
      .sort((left, right) => left.name.localeCompare(right.name))
  }, [catalog, query, rows])

  const connect = async (name: string, needsInstall: boolean, authType: string) => {
    if (!client || !window.confirm(t('connectors.confirmConnect', { name }))) return
    setBusy(name)
    setMessage('')
    setError('')
    try {
      if (needsInstall) await addConnectorPreset(client, profile, name)
      if (authType !== 'oauth') {
        setMessage(t('connectors.connected', { name }))
        await refresh()
        return
      }
      const flow = await startConnectorOAuth(client, profile, name)
      if (flow.auth_url) window.open(flow.auth_url, '_blank', 'noopener,noreferrer')
      if (!flow.session_id) throw new Error(t('connectors.error.oauthStart'))
      for (let attempt = 0; attempt < 120; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000))
        const poll = await pollConnectorOAuth(client, profile, name, flow.session_id)
        if (poll.status === 'approved') {
          setMessage(t('connectors.connected', { name }))
          break
        }
        if (poll.status === 'error') throw new Error(poll.error || t('connectors.error.oauthPoll'))
      }
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('connectors.error.generic'))
    } finally {
      setBusy('')
    }
  }

  const saveApiKey = async (name: string, envVar: string) => {
    if (!client || !window.confirm(t('connectors.confirmApiKey', { name }))) return
    const value = apiDraft[name] || ''
    if (!value.trim()) {
      setError(t('connectors.apiKeyRequired'))
      return
    }
    setApiBusy(name)
    setError('')
    setMessage('')
    try {
      await setConnectorApiKey(client, profile, name, value.trim(), envVar)
      setApiDraft((current) => ({ ...current, [name]: '' }))
      setUnsupportedApi(false)
      setMessage(t('connectors.apiKeySaved', { name }))
      await refresh()
    } catch (cause) {
      const offline = cause instanceof HermesRpcError && cause.code === -32601
      if (offline) setUnsupportedApi(true)
      setError(cause instanceof Error ? cause.message : t('connectors.error.generic'))
    } finally {
      setApiBusy('')
    }
  }

  const disconnect = async (name: string) => {
    if (!client || !window.confirm(t('connectors.confirmRemove', { name }))) return
    setBusy(name)
    setError('')
    try {
      await removeConnector(client, profile, name)
      setMessage(t('connectors.removed', { name }))
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('connectors.error.generic'))
    } finally {
      setBusy('')
    }
  }

  if (!enabled) return <p className="details-empty">{t('connectors.disabled')}</p>

  return (
    <section className="details-section connectors-section">
      <div className="details-section-heading">
        <span>{t('details.tabs.connectors')}</span>
      </div>
      <input className="connectors-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('connectors.search')} />
      {message && <p className="routine-test-report">{message}</p>}
      {error && <p className="form-error">{error}</p>}
      {list.length === 0 && <p className="details-empty">{t('connectors.empty')}</p>}
      <div className="connectors-list">
        {list.map((entry) => {
          const status = entry.status
          const configured = status && status.status !== 'catalog'
          const needsAuth = status && status.oauthNeeded && status.oauthTokensPresent !== true
          const apiKeys = entry.requires
          const needsApiKey = entry.auth !== 'oauth' && apiKeys.length > 0
          const primaryEnv = apiKeys[0] || ''
          const keyState = status?.apiKeyState
          return (
            <article className="connector-row" key={entry.name}>
              <div>
                <h3>{entry.name}</h3>
                <p>{entry.description}</p>
                {status && <p className="connector-status">{statusLabel(status, t)}</p>}
                {needsApiKey && configured && (
                  <p className="connector-env">
                    {keyState === 'set' ? t('connectors.apiKeySet') : keyState === 'missing' ? t('connectors.apiKeyMissing') : t('connectors.apiKeyUnknown')}
                    {primaryEnv ? ` (${primaryEnv})` : ''}
                  </p>
                )}
                {needsApiKey && !configured && apiKeys.length > 0 && (
                  <p className="connector-env">{t('connectors.envKeys', { keys: apiKeys.join(', ') })}</p>
                )}
                {configured && needsApiKey && !unsupportedApi && (
                  <label className="connector-key-form">
                    <span className="sr-only">{t('connectors.apiKeyLabel', { name: entry.name })}</span>
                    <input
                      type="password"
                      autoComplete="off"
                      value={apiDraft[entry.name] || ''}
                      disabled={apiBusy === entry.name}
                      placeholder={t('connectors.apiKeyPlaceholder')}
                      onChange={(event) => setApiDraft((current) => ({ ...current, [entry.name]: event.target.value }))}
                    />
                    <button type="button" disabled={apiBusy === entry.name || !client} onClick={() => void saveApiKey(entry.name, primaryEnv)}>
                      {t('connectors.apiKeySave')}
                    </button>
                  </label>
                )}
                {configured && needsApiKey && unsupportedApi && primaryEnv && (
                  <code className="connector-cli">{connectorApiKeyCli(profile, entry.name, primaryEnv)}</code>
                )}
              </div>
              <div className="connector-actions">
                {configured ? (
                  <button type="button" className="secondary" disabled={busy === entry.name} onClick={() => void disconnect(entry.name)}>{t('connectors.remove')}</button>
                ) : (
                  <button type="button" disabled={busy === entry.name || !client} onClick={() => void connect(entry.name, true, entry.auth)}>{t('connectors.connect')}</button>
                )}
                {configured && needsAuth && (
                  <button type="button" disabled={busy === entry.name || !client} onClick={() => void connect(entry.name, false, entry.auth)}>{t('connectors.reauth')}</button>
                )}
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}