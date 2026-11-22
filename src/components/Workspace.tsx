import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import type { Bot, ModelOption } from '../types'
import { BotAvatar } from './BotAvatar'
import { BOT_COLORS, BOT_SHAPES, canonicalShape } from '../lib/bot-create'
import { botActionError } from '../lib/bot-actions'
import { focusableElements, tabTrapIndex } from '../lib/a11y-focus'
import { LOCAL_CHAT_SLUG } from '../lib/local-chat'
import {
  MEMORY_TYPES, changeMemory, installSkill, learnerName, loadBotSheet, loadMemory, loadSkillFile, loadSkills, publishMemory,
  profileSlugs, saveBotSheet, searchSkillHub, toggleSkill, workspaceErrorText,
  type HubSkill, type MemoryFact, type MemoryType, type PrivateMemory, type PublishRow, type SkillInfo, type ToolsetInfo,
} from '../lib/workspace'
import './Workspace.css'

function WorkspaceDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const { t } = useTranslation()
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialogRef.current?.focus()
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [])
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); return }
    if (event.key !== 'Tab' || !dialogRef.current) return
    const focusable = focusableElements(dialogRef.current)
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const next = tabTrapIndex(focusable.length, active ? focusable.indexOf(active) : -1, event.shiftKey)
    if (next === null) return
    event.preventDefault()
    focusable[next]?.focus()
  }
  return (
    <div className="settings-backdrop" onMouseDown={onClose}>
      <div ref={dialogRef} className="settings workspace-sheet" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} onMouseDown={(event) => event.stopPropagation()} onKeyDown={onKey}>
        <section className="settings-body">
          <header className="settings-head">
            <h3>{title}</h3>
            <button type="button" className="plain-icon" aria-label={t('workspace.close')} onClick={onClose}><X size={16} /></button>
          </header>
          <div className="settings-content">{children}</div>
        </section>
      </div>
    </div>
  )
}

function publishNote(rows: PublishRow[], bots: Bot[]) {
  const failed = rows.filter((row) => row.externalDir === 'failed' || row.memory === 'failed').map((row) => bots.find((bot) => bot.slug === row.slug)?.name || row.slug)
  return { ok: rows.length - failed.length, failed }
}

const DEMO_FACTS: MemoryFact[] = [
  { id: 'fdemo1', type: 'user', text: 'Prefers short answers.', learnedBy: 'user', createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z' },
  { id: 'fdemo2', type: 'behavior', text: 'Ask before sending a message to someone else.', learnedBy: 'user', createdAt: '2026-11-02T10:00:00.000Z', updatedAt: '2026-11-02T10:00:00.000Z' },
  { id: 'fdemo3', type: 'people', text: 'Northwind is a fictional client.', learnedBy: 'nova', createdAt: '2026-11-03T10:00:00.000Z', updatedAt: '2026-11-03T10:00:00.000Z' },
  { id: 'fdemo4', type: 'workstream', text: 'The launch checklist lives in the launch folder.', learnedBy: 'orion', createdAt: '2026-11-04T10:00:00.000Z', updatedAt: '2026-11-04T10:00:00.000Z' },
]

const DEMO_PRIVATE: PrivateMemory[] = [
  { profile: 'orion', store: 'memory', text: 'The office printer is on the second floor.' },
]

export function MemoryScreen({ bots, demo, onClose }: { bots: Bot[]; demo: boolean; onClose: () => void }) {
  const { t } = useTranslation()
  const [type, setType] = useState<MemoryType>('user')
  const [facts, setFacts] = useState<MemoryFact[]>(demo ? DEMO_FACTS : [])
  const [learned, setLearned] = useState<PrivateMemory[]>(demo ? DEMO_PRIVATE : [])
  const [hindsight, setHindsight] = useState<{ names: string; banks: { name: string; bank: string }[] } | null>(null)
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(!demo)
  const [busy, setBusy] = useState(false)
  const slugs = profileSlugs(bots)
  const slugKey = slugs.join(',')

  useEffect(() => {
    if (demo) return
    let live = true
    setLoading(true)
    loadMemory(slugs).then(async (view) => {
      if (!live) return
      setFacts(view.facts)
      setLearned(view.learned)
      const active = view.providers.filter((item) => item.active)
      if (active.length) {
        setHindsight({
          names: active.map((item) => bots.find((bot) => bot.slug === item.profile)?.name || item.profile).join(', '),
          banks: active.filter((item) => item.bank).map((item) => ({ name: bots.find((bot) => bot.slug === item.profile)?.name || item.profile, bank: item.bank })),
        })
      }
      setLoading(false)
      if (slugs.length) {
        const published = await publishMemory(slugs)
        if (live) notePublish(published.profiles, true)
      }
    }).catch((reason: unknown) => { if (live) { setError(workspaceErrorText(reason)); setLoading(false) } })
    return () => { live = false }
  }, [demo, slugKey])

  const shown = facts.filter((fact) => fact.type === type)
  const notePublish = (rows: PublishRow[], quiet = false) => {
    const note = publishNote(rows, bots)
    const changed = rows.some((row) => row.externalDir === 'added' || row.memory === 'digest' || row.memory === 'pointer')
    if (note.failed.length) setStatus(t('workspace.publishFailed', { names: note.failed.join(', ') }))
    else if (!quiet || changed) setStatus(t('workspace.published', { count: note.ok }))
  }
  const run = async (task: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try { await task() } catch (reason) { setError(workspaceErrorText(reason)) } finally { setBusy(false) }
  }
  const add = () => run(async () => {
    const text = draft.trim()
    if (!text) return
    if (demo) {
      setFacts((current) => [...current, { id: `fdemo${current.length + 1}`, type, text, learnedBy: 'user', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }])
      setDraft('')
      return
    }
    const result = await changeMemory({ action: 'add', profiles: slugs, type, text, learnedBy: 'user' })
    setFacts(result.facts)
    setDraft('')
    notePublish(result.published.profiles)
  })
  const saveEdit = (fact: MemoryFact) => run(async () => {
    const text = editText.trim()
    if (!text) return
    if (demo) {
      setFacts((current) => current.map((item) => item.id === fact.id ? { ...item, text } : item))
      setEditing(null)
      return
    }
    const result = await changeMemory({ action: 'update', profiles: slugs, id: fact.id, text })
    setFacts(result.facts)
    setEditing(null)
    notePublish(result.published.profiles)
  })
  const forget = (fact: MemoryFact) => run(async () => {
    if (demo) { setFacts((current) => current.filter((item) => item.id !== fact.id)); return }
    const result = await changeMemory({ action: 'forget', profiles: slugs, id: fact.id })
    setFacts(result.facts)
    notePublish(result.published.profiles)
  })
  const share = (entry: PrivateMemory) => run(async () => {
    if (demo) {
      setFacts((current) => [...current, { id: `fdemo${current.length + 1}`, type, text: entry.text, learnedBy: entry.profile, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }])
      return
    }
    const result = await changeMemory({ action: 'share', profiles: slugs, type, text: entry.text, learnedBy: entry.profile })
    setFacts(result.facts)
    notePublish(result.published.profiles)
  })

  return (
    <WorkspaceDialog title={t('workspace.memoryTitle')} onClose={onClose}>
      {demo && <p className="settings-note">{t('workspace.demoNote')}</p>}
      <p className="settings-note">{t('workspace.filesNote')}</p>
      {hindsight && <p className="settings-note">{t('workspace.hindsight', { names: hindsight.names })} {hindsight.banks.map((item) => t('workspace.hindsightBank', item)).join(' ')}</p>}
      {error && <p className="settings-error">{error}</p>}
      <div className="workspace-tabs" role="tablist">
        {MEMORY_TYPES.map((item) => (
          <button key={item} type="button" role="tab" aria-selected={item === type} className={item === type ? 'is-active' : ''} onClick={() => setType(item)}>{t(`workspace.types.${item}`)}</button>
        ))}
      </div>
      {loading ? <p className="workspace-empty">{t('workspace.loading')}</p> : shown.length === 0 ? <p className="workspace-empty">{t('workspace.emptyType')}</p> : shown.map((fact) => (
        <div className="workspace-fact" key={fact.id}>
          {editing === fact.id ? (
            <input className="workspace-field" value={editText} aria-label={t('workspace.edit')} onChange={(event) => setEditText(event.target.value)} />
          ) : (
            <p>{fact.text}<span className="workspace-meta">{t('workspace.learnedBy', { name: learnerName(fact.learnedBy, bots) })}</span></p>
          )}
          <span className="workspace-actions">
            {editing === fact.id ? (
              <>
                <button type="button" className="settings-button" disabled={busy} onClick={() => saveEdit(fact)}>{t('workspace.save')}</button>
                <button type="button" className="settings-button" onClick={() => setEditing(null)}>{t('workspace.cancel')}</button>
              </>
            ) : (
              <>
                <button type="button" className="settings-button" onClick={() => { setEditing(fact.id); setEditText(fact.text) }}>{t('workspace.edit')}</button>
                <button type="button" className="settings-button" disabled={busy} onClick={() => forget(fact)}>{t('workspace.forget')}</button>
              </>
            )}
          </span>
        </div>
      ))}
      <form className="workspace-compose" onSubmit={(event) => { event.preventDefault(); void add() }}>
        <input value={draft} placeholder={t('workspace.factPlaceholder')} aria-label={t('workspace.factPlaceholder')} onChange={(event) => setDraft(event.target.value)} />
        <button type="submit" className="settings-button is-primary" disabled={busy || !draft.trim()}>{t('workspace.add')}</button>
      </form>
      {status && <p className="settings-note">{status}</p>}
      <section className="workspace-section">
        <h4>{t('workspace.privateTitle')}</h4>
        {learned.length === 0 ? <p className="workspace-empty">{t('workspace.privateEmpty')}</p> : learned.map((entry, index) => (
          <div className="workspace-fact" key={`${entry.profile}-${entry.store}-${index}`}>
            <p>{entry.text}<span className="workspace-meta">{t(entry.store === 'user' ? 'workspace.privateUser' : 'workspace.privateMemory', { name: learnerName(entry.profile, bots) })}</span></p>
            <button type="button" className="settings-button" disabled={busy} onClick={() => share(entry)}>{t('workspace.share')}</button>
          </div>
        ))}
      </section>
    </WorkspaceDialog>
  )
}

const DEMO_SKILLS: Record<string, SkillInfo[]> = {
  shared: [
    { name: 'mail-approval', description: 'Show an email draft and send only the approved fields.', category: 'email', enabled: true, scope: 'shared', path: '', provenance: 'local' },
    { name: 'browser-vault', description: 'Ask the user before typing a saved login.', category: 'browser', enabled: true, scope: 'shared', path: '', provenance: 'local' },
  ],
}

function demoSkills(profile: string): SkillInfo[] {
  return [
    ...DEMO_SKILLS.shared.map((skill) => ({ ...skill, enabled: profile !== 'orion' || skill.name !== 'browser-vault' })),
    { name: 'launch-notes', description: 'How this bot keeps the launch checklist.', category: '', enabled: true, scope: 'profile', path: '', provenance: 'local' },
  ]
}

export function SkillsScreen({ bots, demo, initialProfile, onClose }: { bots: Bot[]; demo: boolean; initialProfile: string; onClose: () => void }) {
  const { t } = useTranslation()
  const profiles = bots.filter((bot) => bot.slug !== LOCAL_CHAT_SLUG)
  const [profile, setProfile] = useState(profiles.some((bot) => bot.slug === initialProfile) ? initialProfile : profiles[0]?.slug || '')
  const [skills, setSkills] = useState<SkillInfo[]>(demo ? demoSkills(profile) : [])
  const [supported, setSupported] = useState(true)
  const [filter, setFilter] = useState('')
  const [file, setFile] = useState<{ name: string; text: string } | null>(null)
  const [hubQuery, setHubQuery] = useState('')
  const [hub, setHub] = useState<{ supported: boolean; results: HubSkill[] }>({ supported: true, results: [] })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(!demo)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (demo) { setSkills(demoSkills(profile)); setSupported(true); return }
    if (!profile) return
    let live = true
    setLoading(true)
    setFile(null)
    loadSkills(profile).then((result) => {
      if (!live) return
      setSupported(result.supported)
      setSkills(result.skills)
      setLoading(false)
    }).catch((reason: unknown) => { if (live) { setError(workspaceErrorText(reason)); setLoading(false) } })
    return () => { live = false }
  }, [demo, profile])

  const needle = filter.trim().toLocaleLowerCase()
  const visible = skills.filter((skill) => !needle || `${skill.name} ${skill.description} ${skill.category}`.toLocaleLowerCase().includes(needle))
  const groups = [
    { id: 'shared', title: t('workspace.sharedLibrary'), items: visible.filter((skill) => skill.scope !== 'profile') },
    { id: 'profile', title: t('workspace.profileSkills'), items: visible.filter((skill) => skill.scope === 'profile') },
  ]
  const run = async (task: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try { await task() } catch (reason) { setError(workspaceErrorText(reason)) } finally { setBusy(false) }
  }

  return (
    <WorkspaceDialog title={t('workspace.skillsTitle')} onClose={onClose}>
      {demo && <p className="settings-note">{t('workspace.demoNote')}</p>}
      <p className="settings-note">{t('workspace.skillsNote')}</p>
      {error && <p className="settings-error">{error}</p>}
      <label className="workspace-label">{t('workspace.botLabel')}
        <select className="workspace-select" value={profile} onChange={(event) => setProfile(event.target.value)}>
          {profiles.map((bot) => <option key={bot.slug} value={bot.slug}>{bot.name}</option>)}
        </select>
      </label>
      <div className="settings-search"><input value={filter} placeholder={t('workspace.search')} aria-label={t('workspace.search')} onChange={(event) => setFilter(event.target.value)} /></div>
      {file ? (
        <section className="workspace-section">
          <button type="button" className="settings-button" onClick={() => setFile(null)}>{t('workspace.back')}</button>
          <h4>{file.name}</h4>
          <pre className="workspace-skill">{file.text}</pre>
        </section>
      ) : loading ? <p className="workspace-empty">{t('workspace.loading')}</p> : !supported ? <p className="workspace-empty">{t('workspace.skillsUnsupported')}</p> : (
        groups.map((group) => (
          <section className="workspace-section" key={group.id}>
            <h4>{group.title}</h4>
            {group.items.length === 0 ? <p className="workspace-empty">{t('workspace.skillsEmpty')}</p> : group.items.map((skill) => (
              <div className="workspace-row" key={`${skill.scope}-${skill.name}`}>
                <label className="workspace-row-copy">
                  <strong>{skill.name}</strong>
                  {skill.description && <span>{skill.description}</span>}
                </label>
                <button type="button" className="settings-button" onClick={() => run(async () => {
                  if (demo) { setFile({ name: skill.name, text: `# ${skill.name}\n\n${skill.description}\n` }); return }
                  const body = await loadSkillFile(profile, skill.name)
                  setFile({ name: body.name, text: body.text })
                })}>{t('workspace.view')}</button>
                <input className="settings-switch" type="checkbox" role="switch" checked={skill.enabled} disabled={busy} aria-label={`${t('workspace.enable')} ${skill.name}`} onChange={(event) => {
                  const enabled = event.target.checked
                  void run(async () => {
                    if (demo) { setSkills((current) => current.map((item) => item.name === skill.name ? { ...item, enabled } : item)); return }
                    await toggleSkill(profile, skill.name, enabled)
                    setSkills((current) => current.map((item) => item.name === skill.name ? { ...item, enabled } : item))
                  })
                }} />
              </div>
            ))}
          </section>
        ))
      )}
      <section className="workspace-section">
        <h4>{t('workspace.hubTitle')}</h4>
        {hub.supported === false && <p className="workspace-empty">{t('workspace.hubUnsupported')}</p>}
        <form className="workspace-hub" onSubmit={(event) => {
          event.preventDefault()
          void run(async () => {
            if (demo) {
              setHub({ supported: true, results: hubQuery.trim() ? [{ name: 'example-skill', identifier: 'official/example-skill', description: 'An example skill from the hub.', source: 'official', installed: false }] : [] })
              return
            }
            const result = await searchSkillHub(profile, hubQuery)
            setHub({ supported: result.supported, results: result.results })
          })
        }}>
          <input className="workspace-field" value={hubQuery} placeholder={t('workspace.hubPlaceholder')} aria-label={t('workspace.hubPlaceholder')} onChange={(event) => setHubQuery(event.target.value)} />
          <button type="submit" className="settings-button" disabled={busy || !hubQuery.trim()}>{t('workspace.search')}</button>
        </form>
        {hub.results.length === 0 && hub.supported && hubQuery.trim() && !busy ? <p className="workspace-empty">{t('workspace.hubEmpty')}</p> : hub.results.map((item) => (
          <div className="workspace-row" key={item.identifier}>
            <div className="workspace-row-copy"><strong>{item.name}</strong>{item.description && <span>{item.description}</span>}</div>
            {item.installed ? <span className="settings-value">{t('workspace.hubInstalled')}</span> : (
              <button type="button" className="settings-button is-primary" disabled={busy} onClick={() => run(async () => {
                if (demo) {
                  setHub((current) => ({ ...current, results: current.results.map((row) => row.identifier === item.identifier ? { ...row, installed: true } : row) }))
                  return
                }
                const result = await installSkill(profile, item.identifier)
                if (!result.supported) { setHub((current) => ({ ...current, supported: false })); return }
                if (!result.ok) { setError(result.detail || workspaceErrorText(new Error('workspace_failed'))); return }
                setHub((current) => ({ ...current, results: current.results.map((row) => row.identifier === item.identifier ? { ...row, installed: true } : row) }))
                const listed = await loadSkills(profile)
                setSkills(listed.skills)
              })}>{busy ? t('workspace.installing') : t('workspace.install')}</button>
            )}
          </div>
        ))}
      </section>
    </WorkspaceDialog>
  )
}

const DEMO_TOOLSETS: ToolsetInfo[] = [
  { name: 'terminal', label: 'Terminal', description: 'Run commands on this Mac.', enabled: true, tools: [] },
  { name: 'web', label: 'Web', description: 'Search and open pages.', enabled: true, tools: [] },
  { name: 'files', label: 'Files', description: 'Read and write files.', enabled: false, tools: [] },
]

export function BotSheet({ bot, models, demo, onSaveIdentity, onClose }: {
  bot: Bot
  models: ModelOption[]
  demo: boolean
  onSaveIdentity: (bot: Bot, draft: { title: string; color: string; shape: string }) => Promise<void>
  onClose: () => void
}) {
  const { t } = useTranslation()
  const titleId = useId()
  const [title, setTitle] = useState(bot.name)
  const [color, setColor] = useState(bot.avatar?.color || BOT_COLORS[0].value)
  const [shape, setShape] = useState(canonicalShape(bot.avatar?.shape || 'blob'))
  const [persona, setPersona] = useState(demo ? `You are ${bot.name}. Keep replies short and say what you are doing.` : '')
  const [model, setModel] = useState(bot.model || '')
  const [provider, setProvider] = useState('')
  const [toolsets, setToolsets] = useState<ToolsetInfo[]>(demo ? DEMO_TOOLSETS : [])
  const [editable, setEditable] = useState(demo)
  const [supported, setSupported] = useState(demo)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(!demo)
  const [busy, setBusy] = useState(false)
  const preview = { ...bot, name: title || bot.name, avatar: { shape, color } }

  useEffect(() => {
    if (demo) return
    let live = true
    loadBotSheet(bot.slug).then((sheet) => {
      if (!live) return
      setPersona(sheet.persona)
      setModel(sheet.model || bot.model)
      setProvider(sheet.provider)
      setToolsets(sheet.toolsets)
      setEditable(sheet.toolsetsEditable)
      setSupported(sheet.toolsetsSupported || sheet.toolsets.length > 0)
      setLoading(false)
    }).catch((reason: unknown) => { if (live) { setError(workspaceErrorText(reason)); setLoading(false) } })
    return () => { live = false }
  }, [bot.slug, demo])

  const choices = models.some((option) => option.model === model && option.provider === provider) || !model
    ? models
    : [{ model, provider, providerName: provider || model }, ...models]

  return (
    <WorkspaceDialog title={bot.name} onClose={onClose}>
      <p className="settings-note">{t('workspace.sheetNote')}</p>
      {demo && <p className="settings-note">{t('workspace.demoNote')}</p>}
      {error && <p className="settings-error">{error}</p>}
      {loading ? <p className="workspace-empty">{t('workspace.loading')}</p> : (
        <form onSubmit={(event) => {
          event.preventDefault()
          setBusy(true)
          setError('')
          setStatus('')
          const task = (async () => {
            await onSaveIdentity(bot, { title: title.trim(), color, shape })
            if (!demo) {
              const saved = await saveBotSheet({
                profile: bot.slug,
                persona,
                model,
                provider,
                ...(editable ? { toolsets: toolsets.map((item) => ({ name: item.name, enabled: item.enabled })) } : {}),
              })
              if (saved.saved.toolsetsPartial) setStatus(t('workspace.toolsetsPartial'))
              else setStatus(t('workspace.saved'))
            } else setStatus(t('workspace.saved'))
          })()
          task.catch((reason: unknown) => setError(reason instanceof Error && reason.name === 'BotManageError' ? botActionError(reason) : workspaceErrorText(reason)))
            .finally(() => setBusy(false))
        }}>
          <label className="workspace-label" htmlFor={titleId}>{t('workspace.name')}
            <input id={titleId} className="workspace-field" value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <p className="settings-note">{t('workspace.slug')}: {bot.slug}</p>
          <div className="workspace-label">{t('workspace.avatar')}
            <span className="workspace-colors" role="radiogroup" aria-label={t('workspace.avatar')}>
              {BOT_COLORS.map((item) => (
                <button key={item.id} type="button" role="radio" aria-checked={color === item.value} aria-label={item.id} className={color === item.value ? 'is-active' : ''} style={{ background: item.value }} onClick={() => setColor(item.value)} />
              ))}
            </span>
            <span className="workspace-shapes" role="radiogroup" aria-label={t('workspace.avatar')}>
              {BOT_SHAPES.map((item) => (
                <button key={item} type="button" role="radio" aria-checked={shape === item} aria-label={item} className={shape === item ? 'is-active' : ''} onClick={() => setShape(item)}>
                  <BotAvatar bot={{ ...preview, avatar: { shape: item, color } }} size={22} />
                </button>
              ))}
            </span>
          </div>
          <label className="workspace-label">{t('workspace.persona')}
            <textarea className="workspace-persona" value={persona} placeholder={t('workspace.personaPlaceholder')} onChange={(event) => setPersona(event.target.value)} />
          </label>
          <label className="workspace-label">{t('workspace.model')}
            <select className="workspace-select" value={`${provider}\n${model}`} onChange={(event) => {
              const [nextProvider, nextModel] = event.target.value.split('\n')
              setProvider(nextProvider)
              setModel(nextModel)
            }}>
              {choices.map((option) => (
                <option key={`${option.provider}/${option.model}`} value={`${option.provider}\n${option.model}`}>
                  {option.provider && option.providerName && option.providerName !== option.model ? `${option.providerName} · ${option.model}` : option.model}
                </option>
              ))}
            </select>
          </label>
          <section className="workspace-section">
            <h4>{t('workspace.toolsets')}</h4>
            {!supported && <p className="workspace-empty">{t('workspace.toolsetsUnsupported')}</p>}
            {supported && !editable && <p className="workspace-empty">{t('workspace.toolsetsReadOnly')}</p>}
            {toolsets.map((item) => (
              <label className="workspace-row" key={item.name}>
                <span className="workspace-row-copy"><strong>{item.label}</strong>{item.description && <span>{item.description}</span>}</span>
                <input className="settings-switch" type="checkbox" role="switch" checked={item.enabled} disabled={!editable || busy} aria-label={item.label} onChange={(event) => {
                  const enabled = event.target.checked
                  setToolsets((current) => current.map((row) => row.name === item.name ? { ...row, enabled } : row))
                }} />
              </label>
            ))}
          </section>
          {status && <p className="settings-note">{status}</p>}
          <div className="workspace-compose">
            <button type="submit" className="settings-button is-primary" disabled={busy || !title.trim()}>{busy ? t('workspace.saving') : t('workspace.save')}</button>
            <button type="button" className="settings-button" onClick={onClose}>{t('workspace.cancel')}</button>
          </div>
        </form>
      )}
    </WorkspaceDialog>
  )
}
