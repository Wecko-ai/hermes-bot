import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { HermesRpcError, type HermesClient } from '../lib/hermes'
import type { Bot } from '../types'
import { installSkillFromHub, loadSkills, toggleSkill, type SkillItem } from '../lib/skills'

interface SkillsSettingProps {
  bots: Bot[]
  client: HermesClient | null
}

function SkillRow({ item, disabled, busy, onToggle }: { item: SkillItem; disabled: boolean; busy: boolean; onToggle: (enabled: boolean) => void }) {
  const { t } = useTranslation()
  return (
    <div className="skill-row">
      <div>
        <strong>{item.name || item.id}</strong>
        <span>{item.scope === 'shared' ? t('settings.skills.shared') : t('settings.skills.profile')}</span>
        {item.description && <p>{item.description}</p>}
      </div>
      <label className="settings-row">
        <input className="settings-switch" type="checkbox" role="switch" checked={!disabled} disabled={busy} onChange={(event) => onToggle(event.target.checked)} />
      </label>
    </div>
  )
}

export function SkillsSetting({ bots, client }: SkillsSettingProps) {
  const { t } = useTranslation()
  const [profile, setProfile] = useState(bots[0]?.slug || '')
  const [shared, setShared] = useState<SkillItem[]>([])
  const [owned, setOwned] = useState<SkillItem[]>([])
  const [disabled, setDisabled] = useState<string[]>([])
  const [hubCommand, setHubCommand] = useState('')
  const [hubManage, setHubManage] = useState(false)
  const [installMessage, setInstallMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [installId, setInstallId] = useState('')

  const reload = useCallback(async (slug: string) => {
    if (!slug) return
    setBusy(true)
    setError('')
    try {
      const catalog = await loadSkills(slug)
      setShared(catalog.shared)
      setOwned(catalog.profile)
      setDisabled(catalog.disabled)
      setHubCommand(catalog.hubInstallCommand)
      setHubManage(catalog.hubManage !== false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => { if (!profile && bots[0]) setProfile(bots[0].slug) }, [bots, profile])
  useEffect(() => { if (profile) void reload(profile) }, [profile, reload])

  const installFromHub = async () => {
    const id = installId.trim()
    if (!profile || !id || !client) return
    if (!window.confirm(t('settings.skills.installConfirm', { id }))) return
    setBusy(true)
    setError('')
    setInstallMessage('')
    try {
      const result = await installSkillFromHub(client, profile, id)
      setInstallMessage(t('settings.skills.installDone', { name: result.name || id }))
      await reload(profile)
    } catch (cause) {
      if (cause instanceof HermesRpcError && cause.code === -32601) {
        setHubManage(false)
        setError(t('settings.skills.installUnsupported'))
      } else setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const onToggle = async (skillId: string, enabled: boolean) => {
    if (!profile) return
    setBusy(true)
    try {
      const body = await toggleSkill(profile, skillId, enabled)
      setDisabled(body.disabled)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="skills-settings">
      <p className="settings-hint">{t('settings.skills.hint')}</p>
      <label className="settings-row">
        <span className="settings-row-copy"><strong>{t('settings.skills.bot')}</strong></span>
        <select value={profile} onChange={(event) => setProfile(event.target.value)}>
          {bots.map((bot) => <option key={bot.slug} value={bot.slug}>{bot.name}</option>)}
        </select>
      </label>
      <section>
        <h4>{t('settings.skills.sharedTitle')}</h4>
        {shared.map((item) => <SkillRow key={item.id} item={item} disabled={disabled.includes(item.id)} busy={busy} onToggle={(enabled) => void onToggle(item.id, enabled)} />)}
      </section>
      <section>
        <h4>{t('settings.skills.profileTitle')}</h4>
        {owned.map((item) => <SkillRow key={item.id} item={item} disabled={disabled.includes(item.id)} busy={busy} onToggle={(enabled) => void onToggle(item.id, enabled)} />)}
      </section>
      <div className="skills-hub">
        <h4>{t('settings.skills.installTitle')}</h4>
        <p className="settings-hint">{t('settings.skills.installHint')}</p>
        <input value={installId} onChange={(event) => setInstallId(event.target.value)} placeholder={t('settings.skills.installPlaceholder')} />
        {hubManage && client && (
          <button type="button" className="is-primary" disabled={busy || !installId.trim()} onClick={() => void installFromHub()}>
            {t('settings.skills.installButton')}
          </button>
        )}
        <code>{installId.trim() ? `hermes skills install ${installId.trim()}` : hubCommand}</code>
        {installMessage && <p className="settings-hint">{installMessage}</p>}
      </div>
      {error && <p className="settings-error" role="alert">{error}</p>}
    </div>
  )
}