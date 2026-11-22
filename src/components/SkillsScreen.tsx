import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { BookOpen, Search, X } from 'lucide-react'
import { focusableElements, tabTrapIndex } from '../lib/a11y-focus'
import { connectorProfiles } from '../lib/connectors'
import {
  DEMO_SKILL_TEXT, demoSkills, installHubSkill, loadHub, loadSkillText, loadSkills, setSkillEnabled, splitSkills,
  type HubSkill, type LibrarySkill,
} from '../lib/skills-library'
import type { Bot } from '../types'

interface SkillsScreenProps {
  bots: Bot[]
  focusSlug: string
  demo?: boolean
  onClose: () => void
}

function SkillLink({ href, children }: { href?: string; children?: ReactNode }) {
  if (!href || !/^https?:\/\//i.test(href)) return <span>{children}</span>
  return <a href={href} target="_blank" rel="noreferrer">{children}</a>
}

export function SkillsScreen({ bots, focusSlug, demo = false, onClose }: SkillsScreenProps) {
  const { t } = useTranslation()
  const profiles = useMemo(() => connectorProfiles(bots), [bots])
  const initial = profiles.some((bot) => bot.slug === focusSlug) ? focusSlug : profiles[0]?.slug || ''
  const [profile, setProfile] = useState(initial)
  const [skills, setSkills] = useState<LibrarySkill[]>(() => demo ? demoSkills() : [])
  const [hub, setHub] = useState<HubSkill[]>([])
  const [hubQuery, setHubQuery] = useState('')
  const [hubOpen, setHubOpen] = useState(false)
  const [loading, setLoading] = useState(!demo)
  const [unsupported, setUnsupported] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState('')
  const [filter, setFilter] = useState('')
  const [view, setView] = useState<{ name: string; content: string } | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialogRef.current?.focus()
    return () => {
      alive.current = false
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])

  const refresh = async (slug: string) => {
    if (demo) return
    setLoading(true)
    try {
      const page = await loadSkills(slug)
      if (!alive.current) return
      setSkills(page.skills)
      setUnsupported(page.unsupported)
      setError('')
    } catch (reason) {
      if (!alive.current) return
      setError(reason instanceof Error && reason.message !== 'rejected' ? reason.message : t('skillsLibrary.unavailable'))
    } finally {
      if (alive.current) setLoading(false)
    }
  }

  useEffect(() => { void refresh(profile) }, [profile, demo])

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      if (view) setView(null)
      else onClose()
      return
    }
    if (event.key !== 'Tab' || !dialogRef.current) return
    const focusable = focusableElements(dialogRef.current)
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const next = tabTrapIndex(focusable.length, active ? focusable.indexOf(active) : -1, event.shiftKey)
    if (next === null) return
    event.preventDefault()
    focusable[next]?.focus()
  }

  const needle = filter.trim().toLocaleLowerCase()
  const visible = skills.filter((skill) => !needle || `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(needle))
  const groups = splitSkills(visible)
  const botLabel = profiles.find((bot) => bot.slug === profile)?.name || profile

  const onToggle = async (skill: LibrarySkill, enabled: boolean) => {
    if (!profile) return
    setBusy(skill.name)
    try {
      if (!demo) await setSkillEnabled(skill.name, profile, enabled)
      setSkills((current) => current.map((item) => item.name === skill.name ? { ...item, enabled } : item))
    } catch (reason) {
      setNotice(reason instanceof Error && reason.message !== 'rejected' ? reason.message : t('skillsLibrary.failed'))
    } finally {
      setBusy('')
    }
  }

  const onView = async (skill: LibrarySkill) => {
    if (demo) {
      setView({ name: skill.name, content: skill.name === 'weekly-notes' ? DEMO_SKILL_TEXT : `# ${skill.name}\n\n${skill.description}\n` })
      return
    }
    setBusy(skill.name)
    try {
      setView(await loadSkillText(skill.name, profile))
    } catch (reason) {
      setNotice(reason instanceof Error && reason.message !== 'rejected' ? reason.message : t('skillsLibrary.failed'))
    } finally {
      setBusy('')
    }
  }

  const onSearchHub = async () => {
    setBusy('hub')
    setNotice('')
    try {
      if (demo) {
        setHub([{ identifier: 'official/notes/weekly-notes', name: 'weekly-notes', description: 'A weekly note.', category: 'notes', trust: 'reviewed', installed: false }])
        return
      }
      const page = await loadHub(hubQuery.trim(), profile)
      setHub(page.skills)
      setUnsupported(page.unsupported)
    } catch (reason) {
      setNotice(reason instanceof Error && reason.message !== 'rejected' ? reason.message : t('skillsLibrary.failed'))
    } finally {
      setBusy('')
    }
  }

  const onInstall = async (skill: HubSkill, target: string) => {
    setBusy(skill.identifier)
    try {
      if (!demo) await installHubSkill(skill.identifier, target)
      setNotice(t('skillsLibrary.installing', { name: skill.name }))
      setHub((current) => current.map((item) => item.identifier === skill.identifier ? { ...item, installed: true } : item))
      if (!demo) await refresh(profile)
    } catch (reason) {
      setNotice(reason instanceof Error && reason.message !== 'rejected' ? reason.message : t('skillsLibrary.failed'))
    } finally {
      setBusy('')
    }
  }

  const section = (title: string, rows: LibrarySkill[]) => (
    <section className="library-section">
      <h4>{title}</h4>
      {rows.length === 0 && <p className="settings-note">{t('skillsLibrary.empty')}</p>}
      {rows.map((skill) => (
        <div key={`${skill.scope}:${skill.name}`} className="library-bot">
          <span className="library-bot-name">{skill.name}</span>
          <span className="library-meta">{skill.description}</span>
          <span className="library-meta">{t(`skillsLibrary.provenance.${skill.provenance}`)}</span>
          <label className="library-enable">
            <input
              type="checkbox"
              role="switch"
              aria-label={t('skillsLibrary.enabled', { bot: botLabel, name: skill.name })}
              checked={skill.enabled}
              disabled={!profile || busy === skill.name}
              onChange={(event) => void onToggle(skill, event.target.checked)}
            />
          </label>
          <button type="button" className="settings-button" disabled={busy === skill.name} onClick={() => void onView(skill)}>{t('skillsLibrary.view')}</button>
        </div>
      ))}
    </section>
  )

  return (
    <div className="settings-backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="settings is-wide"
        role="dialog"
        aria-modal="true"
        aria-label={t('skillsLibrary.title')}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onKey}
      >
        <nav className="settings-nav" aria-label={t('skillsLibrary.title')}>
          <h2>{t('skillsLibrary.title')}</h2>
          <p className="settings-note">{t('skillsLibrary.intro')}</p>
        </nav>
        <section className="settings-body">
          <header className="settings-head">
            <h3><BookOpen size={16} /> {t('skillsLibrary.title')}</h3>
            <button type="button" className="plain-icon" aria-label={t('skillsLibrary.close')} onClick={onClose}><X size={16} /></button>
          </header>
          <div className="settings-content library">
            {profiles.length > 0 && (
              <label className="library-env">
                <span>{t('skillsLibrary.botPicker')}</span>
                <select aria-label={t('skillsLibrary.botPicker')} value={profile} onChange={(event) => setProfile(event.target.value)}>
                  {profiles.map((bot) => <option key={bot.slug} value={bot.slug}>{bot.name}</option>)}
                </select>
              </label>
            )}
            {profiles.length === 0 && <p className="settings-note">{t('skillsLibrary.noBot')}</p>}
            <label className="settings-search">
              <Search size={14} />
              <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={t('skillsLibrary.search')} aria-label={t('skillsLibrary.search')} />
            </label>
            {loading && <p className="settings-note">{t('skillsLibrary.loading')}</p>}
            {error && <p className="settings-note is-error" role="alert">{error}</p>}
            {unsupported && <p className="settings-note">{t('skillsLibrary.unsupported')}</p>}
            {section(t('skillsLibrary.shared'), groups.shared)}
            {profile && section(t('skillsLibrary.bot', { bot: botLabel }), groups.bot)}
            <section className="library-section">
              <h4>{t('skillsLibrary.hub')}</h4>
              <p className="settings-note">{t('skillsLibrary.hubHint')}</p>
              {!hubOpen && <button type="button" className="settings-button" onClick={() => { setHubOpen(true); void onSearchHub() }}>{t('skillsLibrary.hubOpen')}</button>}
              {hubOpen && (
                <>
                  <label className="settings-search">
                    <Search size={14} />
                    <input value={hubQuery} onChange={(event) => setHubQuery(event.target.value)} placeholder={t('skillsLibrary.hubSearch')} aria-label={t('skillsLibrary.hubSearch')} onKeyDown={(event) => { if (event.key === 'Enter') void onSearchHub() }} />
                  </label>
                  <button type="button" className="settings-button" disabled={busy === 'hub'} onClick={() => void onSearchHub()}>{t('skillsLibrary.hubSearch')}</button>
                  {hub.length === 0 && <p className="settings-note">{t('skillsLibrary.hubEmpty')}</p>}
                  {hub.map((skill) => (
                    <div key={skill.identifier} className="library-bot">
                      <span className="library-bot-name">{skill.name}</span>
                      <span className="library-meta">{skill.description}</span>
                      {skill.trust === 'reviewed' && <span className="library-meta">{t('skillsLibrary.reviewed')}</span>}
                      {skill.installed ? <span className="library-status is-connected">{t('skillsLibrary.installed')}</span> : (
                        <>
                          <button type="button" className="settings-button is-primary" disabled={busy === skill.identifier} onClick={() => void onInstall(skill, '')}>{t('skillsLibrary.installShared')}</button>
                          {profile && <button type="button" className="settings-button" disabled={busy === skill.identifier} onClick={() => void onInstall(skill, profile)}>{t('skillsLibrary.installBot', { bot: botLabel })}</button>}
                        </>
                      )}
                    </div>
                  ))}
                </>
              )}
            </section>
            {notice && <p className="settings-note" role="status">{notice}</p>}
            {view && (
              <section className="skill-sheet" aria-label={t('skillsLibrary.viewing', { name: view.name })}>
                <header>
                  <h4>{view.name}</h4>
                  <button type="button" className="settings-button" onClick={() => setView(null)}>{t('skillsLibrary.closeView')}</button>
                </header>
                {view.content ? <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: SkillLink, img: () => null }}>{view.content}</ReactMarkdown> : <p className="settings-note">{t('skillsLibrary.contentEmpty')}</p>}
              </section>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
