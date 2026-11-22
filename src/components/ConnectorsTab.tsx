import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Search } from 'lucide-react'
import type { Bot } from '../types'
import {
  canConnect, connectorProfiles, countStatuses, demoConnectors, disconnectConnector, installConnector,
  loadConnectors, missingEnv, openAuthorization, overlayProbes, probeConnectors, readConnectorAuth,
  setConnectorEnabled, startConnectorAuth, waitForGrant, type Connector, type ConnectorStatus,
} from '../lib/connectors'

interface ConnectorsTabProps {
  bots: Bot[]
  focusSlug: string
  demo?: boolean
}

const STATUS_ORDER: ConnectorStatus[] = ['connected', 'needs_auth', 'error', 'off', 'unknown', 'available']

function botName(bots: Bot[], profile: string) {
  return bots.find((bot) => bot.slug === profile)?.name || profile
}

export function ConnectorsTab({ bots, focusSlug, demo = false }: ConnectorsTabProps) {
  const { t } = useTranslation()
  const profiles = useMemo(() => connectorProfiles(bots), [bots])
  const profileKey = profiles.map((bot) => bot.slug).join(',')
  const [entries, setEntries] = useState<Connector[]>(() => demo ? demoConnectors(profiles) : [])
  const [unsupported, setUnsupported] = useState<string[]>([])
  const [failed, setFailed] = useState<string[]>([])
  const [diagnostics, setDiagnostics] = useState<{ name: string; message: string }[]>([])
  const [loading, setLoading] = useState(!demo)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [env, setEnv] = useState<Record<string, string>>({})
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const refresh = async () => {
    if (demo) return
    const slugs = profiles.map((bot) => bot.slug)
    if (!slugs.length) {
      setEntries([])
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const catalog = await loadConnectors(slugs)
      if (!alive.current) return
      setEntries(catalog.entries)
      setUnsupported(catalog.unsupported)
      setFailed(catalog.failed || [])
      setDiagnostics(catalog.diagnostics.map((item) => ({ name: item.name, message: item.message })))
      setError('')
      const names = catalog.entries.filter((entry) => entry.bots.some((bot) => bot.installed)).map((entry) => entry.name)
      if (names.length) {
        const probed = await probeConnectors(slugs, names)
        if (!alive.current) return
        setEntries((current) => overlayProbes(current, probed.results))
      }
    } catch (reason) {
      if (!alive.current) return
      setError(reason instanceof Error && reason.message !== 'rejected' ? reason.message : t('connectors.unavailable'))
    } finally {
      if (alive.current) setLoading(false)
    }
  }

  useEffect(() => { void refresh() }, [profileKey, demo])

  const shown = entries.filter((entry) => {
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) return true
    return `${entry.name} ${entry.description} ${entry.endpoint}`.toLocaleLowerCase().includes(needle)
  })

  const patchBot = (name: string, profile: string, patch: Partial<Connector['bots'][number]>) => {
    setEntries((current) => current.map((entry) => entry.name !== name ? entry : {
      ...entry,
      bots: entry.bots.map((bot) => bot.profile === profile ? { ...bot, ...patch } : bot),
    }))
  }

  const onConnect = async (entry: Connector, profile: string) => {
    const values = Object.fromEntries(entry.requiredEnv.map((item) => [item.name, env[`${entry.name}:${item.name}`] || '']))
    if (!entry.bots.find((bot) => bot.profile === profile)?.installed && missingEnv(entry, values).length) {
      setOpen(entry.name)
      setNotice(t('connectors.envMissing'))
      return
    }
    setBusy(`${entry.name}:${profile}`)
    setNotice('')
    try {
      if (demo) {
        patchBot(entry.name, profile, { installed: true, enabled: true, status: 'connected', error: '' })
        setNotice(t('connectors.demoNote'))
        return
      }
      const installed = entry.bots.find((bot) => bot.profile === profile)?.installed
      if (!installed) {
        const result = await installConnector(entry.name, profile, Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim())))
        setEnv((current) => {
          const next = { ...current }
          for (const item of entry.requiredEnv) delete next[`${entry.name}:${item.name}`]
          return next
        })
        if (result.background) {
          setNotice(t('connectors.installing'))
          const slugs = profiles.map((bot) => bot.slug)
          let ready = false
          for (let attempt = 0; attempt < 15 && alive.current; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 2_000))
            const catalog = await loadConnectors(slugs)
            ready = catalog.entries.some((item) => item.name === entry.name && item.bots.some((bot) => bot.profile === profile && bot.installed))
            if (ready) break
          }
          if (!ready) return
        }
      }
      if (entry.authType === 'oauth') {
        const flow = await startConnectorAuth(entry.name, profile)
        if (!flow.authorizationUrl && flow.error) {
          setNotice(flow.error)
          return
        }
        if (flow.authorizationUrl) openAuthorization(flow.authorizationUrl)
        setNotice(t('connectors.opened'))
        if (flow.flowId) {
          const done = await waitForGrant((id) => readConnectorAuth(id), flow.flowId, {
            wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            aborted: () => !alive.current,
          })
          if (done.status !== 'approved') {
            setNotice(done.error || t('connectors.failed'))
            return
          }
        }
      }
      setNotice(t('connectors.connected', { name: entry.name }))
    } catch (reason) {
      setNotice(reason instanceof Error && reason.message !== 'rejected' ? reason.message : t('connectors.failed'))
    } finally {
      if (!alive.current) return
      setBusy('')
      if (!demo) void refresh()
    }
  }

  const onToggle = async (entry: Connector, profile: string, enabled: boolean) => {
    setBusy(`${entry.name}:${profile}`)
    try {
      if (demo) {
        patchBot(entry.name, profile, { enabled, status: enabled ? 'connected' : 'off' })
        return
      }
      await setConnectorEnabled(entry.name, profile, enabled)
      patchBot(entry.name, profile, { enabled, status: enabled ? 'connected' : 'off' })
    } catch (reason) {
      setNotice(reason instanceof Error && reason.message !== 'rejected' ? reason.message : t('connectors.failed'))
    } finally {
      setBusy('')
    }
  }

  const onDisconnect = async (entry: Connector, profile: string) => {
    const name = botName(bots, profile)
    if (!window.confirm(t('connectors.disconnectConfirm', { name: entry.name, bot: name }))) return
    setBusy(`${entry.name}:${profile}`)
    try {
      if (!demo) await disconnectConnector(entry.name, profile)
      patchBot(entry.name, profile, { installed: false, enabled: false, status: 'available', error: '' })
    } catch (reason) {
      setNotice(reason instanceof Error && reason.message !== 'rejected' ? reason.message : t('connectors.failed'))
    } finally {
      setBusy('')
    }
  }

  if (!profiles.length) return <p className="settings-note">{t('connectors.noBots')}</p>

  return (
    <div className="library">
      <p className="settings-note">{t('connectors.intro')}</p>
      <label className="settings-search">
        <Search size={14} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('connectors.search')} aria-label={t('connectors.search')} />
      </label>
      {loading && <p className="settings-note">{t('connectors.loading')}</p>}
      {error && <p className="settings-note is-error" role="alert">{error}</p>}
      {unsupported.length > 0 && <p className="settings-note">{t('connectors.unsupported')}</p>}
      {failed.length > 0 && <p className="settings-note">{t('connectors.partial')}</p>}
      <div className="library-list">
        {shown.map((entry) => {
          const counts = countStatuses(entry.bots)
          const summary = STATUS_ORDER.filter((status) => counts[status] > 0 && status !== 'available').map((status) => t(`connectors.summary.${status}`, { count: counts[status] })).join(' · ')
          const target = entry.bots.find((bot) => bot.profile === focusSlug) || entry.bots[0]
          const targetKey = target ? `${entry.name}:${target.profile}` : ''
          return (
            <article key={entry.name} className="library-card">
              <div className="library-card-head">
                <button type="button" className="library-card-open" aria-expanded={open === entry.name} onClick={() => setOpen(open === entry.name ? null : entry.name)}>
                  <strong>{entry.name}</strong>
                  <span>{entry.description}</span>
                </button>
                <span className="library-meta">{entry.endpoint}</span>
                {target && canConnect(entry, target.profile) && (
                  <button type="button" className="settings-button is-primary" disabled={busy === targetKey} onClick={() => void onConnect(entry, target.profile)}>
                    {busy === targetKey ? t('connectors.connecting') : t('connectors.connect')}
                  </button>
                )}
              </div>
              <p className="library-summary">{summary || t('connectors.summary.none')} · {t(`connectors.auth.${entry.authType === 'oauth' || entry.authType === 'header' || entry.authType === 'env' ? entry.authType : 'none'}`)}</p>
              {open === entry.name && (
                <div className="library-bots">
                  {entry.postInstall && <p className="settings-note">{entry.postInstall}</p>}
                  {entry.requiredEnv.length > 0 && entry.bots.some((bot) => !bot.installed) && entry.requiredEnv.map((item) => (
                    <label key={item.name} className="library-env">
                      <span>{item.prompt || item.name}</span>
                      <input
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        aria-label={item.prompt || item.name}
                        value={env[`${entry.name}:${item.name}`] || ''}
                        onChange={(event) => setEnv((current) => ({ ...current, [`${entry.name}:${item.name}`]: event.target.value }))}
                      />
                    </label>
                  ))}
                  {entry.requiredEnv.length > 0 && <p className="settings-note">{t('connectors.envHint')}</p>}
                  {[...entry.bots].sort((a, b) => Number(b.profile === focusSlug) - Number(a.profile === focusSlug)).map((bot) => {
                    const key = `${entry.name}:${bot.profile}`
                    const label = botName(bots, bot.profile)
                    return (
                      <div key={bot.profile} className="library-bot">
                        <span className="library-bot-name">{label}</span>
                        <span className={`library-status is-${bot.status}`}>{t(`connectors.status.${bot.status}`)}</span>
                        {bot.error && <span className="library-bot-error">{bot.error}</span>}
                        <label className="library-enable">
                          <input
                            type="checkbox"
                            role="switch"
                            aria-label={t('connectors.enable', { bot: label })}
                            checked={bot.installed && bot.enabled}
                            disabled={!bot.installed || busy === key}
                            onChange={(event) => void onToggle(entry, bot.profile, event.target.checked)}
                          />
                        </label>
                        {canConnect(entry, bot.profile) && (
                          <button type="button" className="settings-button is-primary" disabled={busy === key} onClick={() => void onConnect(entry, bot.profile)}>
                            {busy === key ? t('connectors.connecting') : t('connectors.connect')}
                          </button>
                        )}
                        {bot.installed && (
                          <button type="button" className="settings-button is-danger" disabled={busy === key} onClick={() => void onDisconnect(entry, bot.profile)}>{t('connectors.disconnect')}</button>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </article>
          )
        })}
      </div>
      {!loading && shown.length === 0 && <p className="settings-note">{t('connectors.empty')}</p>}
      {diagnostics.length > 0 && (
        <ul className="library-diagnostics">
          {diagnostics.map((item) => <li key={`${item.name}:${item.message}`}>{item.name ? `${item.name}: ` : ''}{item.message}</li>)}
        </ul>
      )}
      {notice && <p className="settings-note" role="status">{notice}</p>}
    </div>
  )
}
