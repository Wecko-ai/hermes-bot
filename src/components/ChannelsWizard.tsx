import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { Bot } from '../types'
import {
  CHANNEL_GUIDES, applyChannelConfig, fetchChannelStatus, writeChannelEnv,
  type ChannelPlatform, type ChannelPlatformStatus, type ChannelProfileStatus,
} from '../lib/channels'
import { useAppConfig } from '../lib/app-config'

interface ChannelsWizardProps {
  bots: Bot[]
}

export function ChannelsWizard({ bots }: ChannelsWizardProps) {
  const { t } = useTranslation()
  const { channels } = useAppConfig()
  const roster = bots.filter((bot) => !bot.hidden)
  const [profile, setProfile] = useState(roster[0]?.slug || '')
  const [status, setStatus] = useState<ChannelProfileStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState('')
  const [envDrafts, setEnvDrafts] = useState<Record<ChannelPlatform, Record<string, string>>>({
    telegram: {},
    slack: {},
    imessage: {},
  })
  const [envBusy, setEnvBusy] = useState('')

  useEffect(() => {
    if (!profile && roster[0]) setProfile(roster[0].slug)
  }, [profile, roster])

  useEffect(() => {
    if (!profile) return
    let alive = true
    setLoading(true)
    setNotice('')
    fetchChannelStatus(profile).then((value) => {
      if (alive) setStatus(value)
    }).catch(() => {
      if (alive) setStatus(null)
    }).finally(() => {
      if (alive) setLoading(false)
    })
    return () => { alive = false }
  }, [profile])

  const presentKeys = useMemo(() => new Set(status ? status.platforms.flatMap((item) => item.present) : []), [status])

  const platformCard = (item: ChannelPlatformStatus) => {
    const guide = CHANNEL_GUIDES.find((entry) => entry.id === item.platform)
    const missingRequired = guide?.env.filter((env) => env.required && !presentKeys.has(env.name)) || []
    return (
      <article className="channels-card" key={item.platform}>
        <header>
          <h3>{t(guide?.titleKey || `channels.${item.platform}.title`)}</h3>
          <span className={item.ready ? 'channels-ok' : 'channels-warn'}>{item.ready ? t('channels.ready') : t('channels.missing')}</span>
        </header>
        <p>{t(guide?.stepsKey || `channels.${item.platform}.steps`)}</p>
        <ul className="channels-env">
          {guide?.env.map((env) => (
            <li key={env.name} className={item.present.includes(env.name) ? 'is-set' : env.required ? 'is-missing' : ''}>{env.name}</li>
          ))}
        </ul>
        {channels.wizardWrites && !item.ready && missingRequired.length > 0 && (
          <form className="channels-env-form" onSubmit={(event) => {
            event.preventDefault()
            setEnvBusy(item.platform)
            const env: Record<string, string> = {}
            for (const field of missingRequired) {
              const value = envDrafts[item.platform][field.name]?.trim()
              if (value) env[field.name] = value
            }
            void writeChannelEnv(profile, item.platform, env).then((result) => {
              setEnvBusy('')
              if (result.ok) {
                setNotice(t('channels.envSaved'))
                setEnvDrafts((current) => ({ ...current, [item.platform]: {} }))
                return fetchChannelStatus(profile).then((value) => setStatus(value))
              }
              setNotice(t('channels.envFailed'))
            })
          }}>
            {missingRequired.map((field) => (
              <label key={field.name}>
                {t('channels.envField', { name: field.name })}
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={envDrafts[item.platform][field.name] || ''}
                  onChange={(event) => setEnvDrafts((current) => ({
                    ...current,
                    [item.platform]: { ...current[item.platform], [field.name]: event.target.value },
                  }))}
                />
              </label>
            ))}
            <button type="submit" className="pill-button" disabled={envBusy === item.platform}>{t('channels.saveEnv')}</button>
          </form>
        )}
        {channels.wizardWrites && (
          <button type="button" className="pill-button" disabled={item.ready} onClick={() => {
            void applyChannelConfig(profile, item.platform).then((result) => setNotice(result.ok ? t('channels.applied') : t('channels.failed')))
          }}>{t('channels.apply')}</button>
        )}
      </article>
    )
  }

  return (
    <section className="channels-wizard">
      <Row label={t('channels.pickBot')}>
        <select value={profile} onChange={(event) => setProfile(event.target.value)}>
          {roster.map((bot) => <option key={bot.slug} value={bot.slug}>{bot.name}</option>)}
        </select>
      </Row>
      {!channels.wizardWrites && <p className="readonly-note">{t('channels.readOnly')}</p>}
      {loading && <p>{t('channels.loading')}</p>}
      {status && (
        <>
          <label className="channels-snippet-label">{t('channels.snippet')}
            <textarea readOnly value={status.snippet} rows={8} spellCheck={false} />
          </label>
          <div className="channels-grid">{status.platforms.map(platformCard)}</div>
        </>
      )}
      {notice && <p className="settings-result">{notice}</p>}
    </section>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className="settings-row"><div className="settings-row-copy"><strong>{label}</strong></div>{children}</div>
}