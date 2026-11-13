import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, Cpu, KeyRound, MessageSquare, Search, SlidersHorizontal, UserRound, X, type LucideIcon } from 'lucide-react'
import { version } from '../../package.json'
import type { Bot, ModelOption } from '../types'
import { VaultTab } from './VaultTab'
import { modelLabel } from '../lib/model'
import { groupModels, ProviderTile } from './ModelPicker'
import { hiddenModelKey, updateSettings, useSettings, withModelsVisible, type SendKey, type TextSize, type ThemeChoice } from '../lib/settings'
import type { LanguageChoice } from '../i18n'
import { chooseLocalModel, loadLocalModels, localModelLabel, type LocalModels } from '../lib/local-chat'
import { sendTestNotification, type TestNotificationResult } from '../lib/notifications'

export type SettingsTab = 'general' | 'chat' | 'models' | 'vault' | 'account'

const TABS: { id: SettingsTab; icon: LucideIcon }[] = [
  { id: 'general', icon: SlidersHorizontal },
  { id: 'chat', icon: MessageSquare },
  { id: 'models', icon: Cpu },
  { id: 'vault', icon: KeyRound },
  { id: 'account', icon: UserRound },
]

interface SettingsDialogProps {
  tab: SettingsTab
  onSelectTab: (tab: SettingsTab) => void
  onClose: () => void
  onChooseTheme: (theme: ThemeChoice, origin?: { x: number; y: number }) => void
  models: ModelOption[]
  modelsLoading: boolean
  modelsError: string
  onLoadModels: () => void
  connected: boolean
  reconnecting: boolean
  onReconnect: () => void
  onLogout: () => void
  /** Bot names and the choice of bots allowed in the vault. */
  bots: Bot[]
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-row-copy"><strong>{label}</strong>{hint && <span>{hint}</span>}</div>
      {children}
    </div>
  )
}

function Segments<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { id: T; label: string }[]; onChange: (value: T, origin: { x: number; y: number }) => void }) {
  return (
    <div className="settings-segments" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button key={option.id} type="button" role="radio" aria-checked={option.id === value} className={option.id === value ? 'is-active' : ''} onClick={(event) => onChange(option.id, { x: event.clientX, y: event.clientY })}>{option.label}</button>
      ))}
    </div>
  )
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="settings-row">
      <span className="settings-row-copy"><strong>{label}</strong>{hint && <span>{hint}</span>}</span>
      <input className="settings-switch" type="checkbox" role="switch" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  )
}

function GeneralTab({ onChooseTheme }: Pick<SettingsDialogProps, 'onChooseTheme'>) {
  const { t } = useTranslation()
  const settings = useSettings()
  return (
    <>
      <Row label={t('settings.language')}>
        <Segments<LanguageChoice> label={t('settings.language')} value={settings.language} options={[{ id: 'system', label: t('settings.languageOptions.system') }, { id: 'en', label: t('settings.languageOptions.en') }, { id: 'fr', label: t('settings.languageOptions.fr') }]} onChange={(language) => updateSettings({ language })} />
      </Row>
      <Row label={t('settings.theme')}>
        <Segments<ThemeChoice> label={t('settings.theme')} value={settings.theme} options={[{ id: 'system', label: t('settings.themeOptions.system') }, { id: 'light', label: t('settings.themeOptions.light') }, { id: 'dark', label: t('settings.themeOptions.dark') }]} onChange={onChooseTheme} />
      </Row>
      <Row label={t('settings.textSize')} hint={t('settings.textSizeHint')}>
        <Segments<TextSize> label={t('settings.textSize')} value={settings.textSize} options={[{ id: 'small', label: t('settings.textSizeOptions.small') }, { id: 'normal', label: t('settings.textSizeOptions.normal') }, { id: 'large', label: t('settings.textSizeOptions.large') }]} onChange={(textSize) => updateSettings({ textSize })} />
      </Row>
      <Toggle label={t('settings.reduceMotion')} hint={t('settings.reduceMotionHint')} checked={settings.reduceMotion} onChange={(reduceMotion) => updateSettings({ reduceMotion })} />
      <Toggle label={t('settings.notifications')} hint={t('settings.notificationsHint')} checked={settings.notifications} onChange={(notifications) => {
        updateSettings({ notifications })
        if (notifications && typeof Notification !== 'undefined' && Notification.permission === 'default') void Notification.requestPermission()
      }} />
      <NotificationTest />
    </>
  )
}

function ChatGuide() {
  const { t } = useTranslation()
  const { sendKey } = useSettings()
  const enter = t('settings.sendKeys.enter')
  const items: Array<{ id: string; keys: string[]; text: string }> = [
    { id: 'send', keys: sendKey === 'enter' ? [enter] : ['⌘', enter], text: t('settings.guide.send') },
    { id: 'newline', keys: sendKey === 'enter' ? [t('settings.guide.shift'), enter] : [enter], text: t('settings.guide.newline') },
    { id: 'mention', keys: ['@'], text: t('settings.guide.mention') },
    { id: 'model', keys: ['/model'], text: t('settings.guide.model') },
    { id: 'brain', keys: [t('modes.brain.label')], text: t('settings.guide.brain') },
    { id: 'plan', keys: [t('modes.plan.label')], text: t('settings.guide.plan') },
    { id: 'exec', keys: [t('modes.exec.label')], text: t('settings.guide.exec') },
    { id: 'delivery', keys: [t('delivery.wait.label'), t('delivery.queue.label'), t('delivery.priority.label')], text: t('settings.guide.delivery') },
    { id: 'files', keys: ['+'], text: t('settings.guide.files') },
    { id: 'mic', keys: [t('composer.dictate')], text: t('settings.guide.mic') },
    { id: 'search', keys: ['⌘', 'F'], text: t('settings.guide.search') },
    { id: 'quote', keys: ['⌘', 'L'], text: t('settings.guide.quote') },
    { id: 'palette', keys: ['⌘', 'K'], text: t('settings.guide.palette') },
    { id: 'bots', keys: ['⌥', '↑ / ↓'], text: t('settings.guide.bots') },
    { id: 'composer', keys: ['⌘', 'I'], text: t('settings.guide.composer') },
    { id: 'settings', keys: ['⌘', ','], text: t('settings.guide.settings') },
  ]
  return (
    <section className="chat-guide" aria-labelledby="chat-guide-title">
      <h4 id="chat-guide-title">{t('settings.guide.title')}</h4>
      <dl>
        {items.map((item) => (
          <div key={item.id} className="chat-guide-item">
            <dt>{item.keys.map((key) => <kbd key={key}>{key}</kbd>)}</dt>
            <dd>{item.text}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

/** Sends a notification like the app's and says what macOS did with it. */
function NotificationTest() {
  const { t } = useTranslation()
  const [result, setResult] = useState<TestNotificationResult | 'pending' | null>(null)
  const send = () => {
    setResult('pending')
    void sendTestNotification({
      title: 'HermesBot',
      body: t('settings.notificationsTestBody'),
      onClick: () => { void window.hermesBot?.focusWindow?.(); window.focus() },
    }).then(setResult)
  }
  const hint = result && result !== 'pending' ? t(`settings.notificationsTestResult.${result}`) : t('settings.notificationsTestHint')
  return (
    <Row label={t('settings.notificationsTest')} hint={hint}>
      <button type="button" className="settings-button" disabled={result === 'pending'} onClick={send}>{t('settings.notificationsTestSend')}</button>
    </Row>
  )
}

function ChatTab() {
  const { t } = useTranslation()
  const settings = useSettings()
  const [local, setLocal] = useState<LocalModels | null>(null)
  useEffect(() => { void loadLocalModels().then(setLocal) }, [])
  const localModel = chooseLocalModel(local, settings.localModel)
  return (
    <>
      <Row label={t('settings.sendWith')}>
        <Segments<SendKey> label={t('settings.sendWith')} value={settings.sendKey} options={[{ id: 'enter', label: t('settings.sendKeys.enter') }, { id: 'cmd-enter', label: t('settings.sendKeys.cmdEnter') }]} onChange={(sendKey) => updateSettings({ sendKey })} />
      </Row>
      <Toggle label={t('settings.showUsage')} hint={t('settings.showUsageHint')} checked={settings.showUsage} onChange={(showUsage) => updateSettings({ showUsage })} />
      <Toggle label={t('settings.caveman')} hint={t('settings.cavemanHint')} checked={settings.caveman} onChange={(caveman) => updateSettings({ caveman })} />
      <Row label={t('settings.sortBots')}>
        <Segments<'groups' | 'activity'> label={t('settings.sortBots')} value={settings.activitySort ? 'activity' : 'groups'} options={[{ id: 'groups', label: t('settings.sortOptions.groups') }, { id: 'activity', label: t('settings.sortOptions.activity') }]} onChange={(sort) => updateSettings({ activitySort: sort === 'activity' })} />
      </Row>
      <Toggle label={t('settings.showHidden')} checked={settings.showHidden} onChange={(showHidden) => updateSettings({ showHidden })} />
      {local?.available && local.models.length > 0 && (
        <Row label={t('settings.localModel')} hint={t('settings.localModelHint')}>
          <select className="settings-select" aria-label={t('settings.localModel')} value={localModel} onChange={(event) => updateSettings({ localModel: event.target.value })}>
            {local.models.map((model) => <option key={model} value={model}>{localModelLabel(model)}</option>)}
          </select>
        </Row>
      )}
      <ChatGuide />
    </>
  )
}

function ModelsTab({ models, modelsLoading, modelsError, onLoadModels }: Pick<SettingsDialogProps, 'models' | 'modelsLoading' | 'modelsError' | 'onLoadModels'>) {
  const { t } = useTranslation()
  const { hiddenModels } = useSettings()
  const [query, setQuery] = useState('')
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set())
  // A single read when the tab opens: the list comes from the gateway.
  const loadRef = useRef(onLoadModels)
  useEffect(() => { loadRef.current() }, [])

  const hidden = useMemo(() => new Set(hiddenModels), [hiddenModels])
  const searching = query.trim().length > 0
  const filtered = useMemo(() => {
    const words = query.toLocaleLowerCase('fr').split(/[\s/_-]+/).filter(Boolean)
    return models.filter((option) => {
      const text = `${option.model} ${modelLabel(option.model)} ${option.providerName}`.toLocaleLowerCase('fr').replace(/[/_-]+/g, ' ')
      return words.every((word) => text.includes(word))
    })
  }, [models, query])
  const groups = useMemo(() => groupModels(filtered), [filtered])
  const visibleCount = models.filter((option) => !hidden.has(hiddenModelKey(option))).length

  const setVisible = (options: ModelOption[], visible: boolean) => updateSettings({ hiddenModels: withModelsVisible(hiddenModels, options, visible) })
  const toggleGroup = (slug: string) => setOpenGroups((current) => {
    const next = new Set(current)
    if (!next.delete(slug)) next.add(slug)
    return next
  })

  return (
    <>
      <p className="settings-note">{t('settings.modelsNote')}</p>
      <div className="settings-model-tools">
        <div className="settings-search">
          <Search size={14} />
          <input value={query} placeholder={t('settings.searchModel')} aria-label={t('settings.searchInModels')} onChange={(event) => setQuery(event.target.value)} />
          {query && <button type="button" aria-label={t('settings.clearSearch')} onClick={() => setQuery('')}><X size={13} /></button>}
        </div>
        {models.length > 0 && <span className="settings-count">{t('settings.countOf', { shown: visibleCount, total: models.length })}</span>}
        {hidden.size > 0 && models.length > 0 && <button type="button" className="settings-button" onClick={() => setVisible(models, true)}>{t('settings.showAll')}</button>}
      </div>
      {modelsLoading && models.length === 0 && <p className="settings-note">{t('settings.loadingModels')}</p>}
      {modelsError && <p className="settings-note is-error">{modelsError} <button type="button" className="settings-link" onClick={onLoadModels}>{t('settings.retry')}</button></p>}
      {!modelsLoading && !modelsError && filtered.length === 0 && <p className="settings-note">{t('settings.noModel')}</p>}
      <div className="settings-model-groups">
        {groups.map((group) => {
          const open = searching || openGroups.has(group.slug)
          const shown = group.models.filter((option) => !hidden.has(hiddenModelKey(option))).length
          const label = t('settings.offerProvider', { name: group.name })
          return (
            <section key={group.slug} className="settings-model-group">
              <div className="settings-model-head">
                <button type="button" className="settings-model-toggle" aria-expanded={open} disabled={searching} onClick={() => toggleGroup(group.slug)}>
                  <ChevronRight className={open ? 'is-open' : ''} size={13} />
                  <ProviderTile group={group} />
                  <span className="settings-model-name">{group.name}</span>
                  <span className="settings-count">{shown}/{group.models.length}</span>
                </button>
                <input
                  type="checkbox"
                  aria-label={label}
                  title={label}
                  checked={shown === group.models.length}
                  ref={(element) => { if (element) element.indeterminate = shown > 0 && shown < group.models.length }}
                  onChange={(event) => setVisible(group.models, event.target.checked)}
                />
              </div>
              {open && group.models.map((option) => (
                <label key={hiddenModelKey(option)} className="settings-model" data-model={option.model}>
                  <input type="checkbox" checked={!hidden.has(hiddenModelKey(option))} onChange={(event) => setVisible([option], event.target.checked)} />
                  <span className="settings-model-label">{modelLabel(option.model)}</span>
                  <code>{option.model}</code>
                  {option.tag && <span className="model-option-tag is-plan">{option.tag}</span>}
                  {option.inputPrice && option.outputPrice && <span className="model-option-price">{option.inputPrice} / {option.outputPrice}</span>}
                </label>
              ))}
            </section>
          )
        })}
      </div>
    </>
  )
}

function AccountTab({ connected, reconnecting, onReconnect, onLogout }: Pick<SettingsDialogProps, 'connected' | 'reconnecting' | 'onReconnect' | 'onLogout'>) {
  const { t } = useTranslation()
  return (
    <>
      <Row label={t('settings.connection')} hint={reconnecting ? t('settings.reconnecting') : connected ? t('settings.connected') : t('settings.disconnected')}>
        <button type="button" className="settings-button" disabled={reconnecting} onClick={onReconnect}>{t('settings.reconnect')}</button>
      </Row>
      <Row label={t('settings.session')} hint={t('settings.sessionHint')}>
        <button type="button" className="settings-button is-danger" onClick={onLogout}>{t('settings.logout')}</button>
      </Row>
      <Row label={t('settings.version')}><span className="settings-value">HermesBot {version}</span></Row>
    </>
  )
}

/** App settings, specific to this Mac. Nothing here writes to a Hermes profile. */
export function SettingsDialog(props: SettingsDialogProps) {
  const { t } = useTranslation()
  const { tab, onSelectTab, onClose } = props
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => dialogRef.current?.focus(), [])
  const title = t(`settings.tabs.${tab}`)
  return (
    <div className="settings-backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="settings"
        role="dialog"
        aria-modal="true"
        aria-label={t('settings.title')}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}
      >
        <nav className="settings-nav" aria-label={t('settings.sections')}>
          <h2>{t('settings.title')}</h2>
          {TABS.map((item) => (
            <button key={item.id} type="button" className={item.id === tab ? 'is-active' : ''} aria-current={item.id === tab ? 'page' : undefined} onClick={() => onSelectTab(item.id)}>
              <item.icon size={15} />{t(`settings.tabs.${item.id}`)}
            </button>
          ))}
        </nav>
        <section className="settings-body">
          <header className="settings-head">
            <h3>{title}</h3>
            <button type="button" className="plain-icon" aria-label={t('settings.close')} onClick={onClose}><X size={16} /></button>
          </header>
          <div className="settings-content">
            {tab === 'general' && <GeneralTab onChooseTheme={props.onChooseTheme} />}
            {tab === 'chat' && <ChatTab />}
            {tab === 'models' && <ModelsTab models={props.models} modelsLoading={props.modelsLoading} modelsError={props.modelsError} onLoadModels={props.onLoadModels} />}
            {tab === 'vault' && <VaultTab bots={props.bots} />}
            {tab === 'account' && <AccountTab connected={props.connected} reconnecting={props.reconnecting} onReconnect={props.onReconnect} onLogout={props.onLogout} />}
          </div>
        </section>
      </div>
    </div>
  )
}
