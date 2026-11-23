import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { focusableElements, tabTrapIndex } from '../lib/a11y-focus'
import { useTranslation } from 'react-i18next'
import { BarChart3, Brain, ChevronRight, Cpu, KeyRound, MessageSquare, Radio, Search, SlidersHorizontal, Sparkles, UserRound, X, type LucideIcon } from 'lucide-react'
import { MemorySetting } from './MemorySetting'
import { SkillsSetting } from './SkillsSetting'
import { version } from '../../package.json'
import type { HermesClient } from '../lib/hermes'
import type { Bot, ModelOption } from '../types'
import { VaultTab } from './VaultTab'
import { chipModelLabel, modelLabel } from '../lib/model'
import { ensureScores, scoreModels, useScores } from '../lib/model-scores'
import { ModelScoreMeta, ScoresAttribution } from './ModelScore'
import { modelCost } from '../lib/free-models'
import { useAppConfig } from '../lib/app-config'
import { groupModels, ProviderTile } from './ModelPicker'
import { hiddenModelKey, updateSettings, useSettings, withModelsVisible, type DictationLanguage, type SendKey, type TextSize, type ThemeChoice } from '../lib/settings'
import { mergeHiddenModels, saveHiddenModels, saveZeroSpend, syncSharedSettings } from '../lib/shared-settings'
import type { LanguageChoice } from '../i18n'
import { chooseLocalModel, loadLocalModels, type LocalModels } from '../lib/local-chat'
import { sendTestNotification, type TestNotificationResult } from '../lib/notifications'
import { createSpeechEngine, type SpeechVoice } from '../lib/speech-engines'
import { CompactionSetting } from './CompactionSetting'
import { ApprovalsSetting } from './ApprovalsSetting'
import { UsageGlobalSection } from './UsageGlobalSection'
import { ViewEmpty } from './ViewEmpty'
import { AutoRoutingSection } from './AutoRoutingSection'
import { AUTO_FREE_MODEL_SENTINEL, AUTO_MODEL_SENTINEL, isAutoModel } from '../lib/auto-router'
import { useChatStore } from '../store/chat'

import { ChannelsWizard } from './ChannelsWizard'

export type SettingsTab = 'general' | 'chat' | 'models' | 'memory' | 'skills' | 'vault' | 'channels' | 'usage' | 'account'

const BASE_TABS: { id: SettingsTab; icon: LucideIcon }[] = [
  { id: 'general', icon: SlidersHorizontal },
  { id: 'chat', icon: MessageSquare },
  { id: 'models', icon: Cpu },
  { id: 'memory', icon: Brain },
  { id: 'skills', icon: Sparkles },
  { id: 'vault', icon: KeyRound },
  { id: 'channels', icon: Radio },
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
  client?: HermesClient | null
  reconnecting: boolean
  onReconnect: () => void
  onLogout: () => void
  /** Bot names and the choice of bots allowed in the vault. */
  bots: Bot[]
  /** Local models already known (the visual demo): the Conversations tab then reads no list. */
  localModels?: LocalModels | null
  /** Visual demo: no gateway to share the hidden models with, the save stays in this window. */
  demo?: boolean
  /** The open bot's model window and name: says what the compaction gauge means in tokens. */
  compactionContext?: { contextMax: number; modelName: string } | null
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

function Toggle({ label, hint, checked, disabled = false, onChange }: { label: string; hint?: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="settings-row">
      <span className="settings-row-copy"><strong>{label}</strong>{hint && <span>{hint}</span>}</span>
      <input className="settings-switch" type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
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

function ChatTab({ localModels, bots, demo, compactionContext, client, connected }: { localModels?: LocalModels | null; bots: Bot[]; demo: boolean; compactionContext?: SettingsDialogProps['compactionContext']; client?: HermesClient | null; connected: boolean }) {
  const { t } = useTranslation()
  const settings = useSettings()
  const autoRouter = useAppConfig().autoRouter
  const [loaded, setLoaded] = useState<LocalModels | null>(null)
  // Models given by the app (the visual demo): Ollama is not asked.
  useEffect(() => { if (localModels === undefined) void loadLocalModels().then(setLoaded) }, [localModels])
  const local = localModels === undefined ? loaded : localModels
  const localModel = chooseLocalModel(local, settings.localModel)
  return (
    <>
      <Row label={t('settings.sendWith')}>
        <Segments<SendKey> label={t('settings.sendWith')} value={settings.sendKey} options={[{ id: 'enter', label: t('settings.sendKeys.enter') }, { id: 'cmd-enter', label: t('settings.sendKeys.cmdEnter') }]} onChange={(sendKey) => updateSettings({ sendKey })} />
      </Row>
      <Row label={t('settings.dictationLanguage')} hint={t('settings.dictationLanguageHint')}>
        <Segments<DictationLanguage> label={t('settings.dictationLanguage')} value={settings.dictationLanguage} options={[{ id: 'interface', label: t('settings.dictationLanguageOptions.interface') }, { id: 'fr', label: t('settings.languageOptions.fr') }, { id: 'en', label: t('settings.languageOptions.en') }]} onChange={(dictationLanguage) => updateSettings({ dictationLanguage })} />
      </Row>
      <Toggle label={t('settings.showUsage')} hint={t('settings.showUsageHint')} checked={settings.showUsage} onChange={(showUsage) => updateSettings({ showUsage })} />
      {autoRouter?.enabled && (
        <Toggle
          label={t('settings.autoModel')}
          hint={t('settings.autoModelHint')}
          checked={settings.useAutoModel || useChatStore.getState().chatModel === AUTO_MODEL_SENTINEL}
          onChange={(useAutoModel) => {
            updateSettings(useAutoModel ? { useAutoModel, useAutoFreeModel: false } : { useAutoModel })
            const store = useChatStore.getState()
            if (useAutoModel) store.setChatModel(AUTO_MODEL_SENTINEL)
            else if (isAutoModel(store.chatModel)) store.setChatModel(store.activeChat?.model || '')
          }}
        />
      )}
      {autoRouter?.enabled && (
        <Toggle
          label={t('settings.autoFreeModel')}
          hint={t('settings.autoFreeModelHint')}
          checked={settings.useAutoFreeModel || useChatStore.getState().chatModel === AUTO_FREE_MODEL_SENTINEL}
          onChange={(useAutoFreeModel) => {
            updateSettings(useAutoFreeModel ? { useAutoFreeModel, useAutoModel: false } : { useAutoFreeModel })
            const store = useChatStore.getState()
            if (useAutoFreeModel) store.setChatModel(AUTO_FREE_MODEL_SENTINEL)
            else if (store.chatModel === AUTO_FREE_MODEL_SENTINEL) store.setChatModel(store.activeChat?.model || '')
          }}
        />
      )}
      <Toggle label={t('settings.caveman')} hint={t('settings.cavemanHint')} checked={settings.caveman} onChange={(caveman) => updateSettings({ caveman })} />
      <Toggle label={t('settings.backgroundTask')} hint={t('settings.backgroundTaskHint')} checked={settings.backgroundTask} onChange={(backgroundTask) => updateSettings({ backgroundTask })} />
      <Toggle label={t('settings.toneCharter')} hint={t('settings.toneCharterHint')} checked={settings.toneCharter} onChange={(toneCharter) => updateSettings({ toneCharter })} />
      <Toggle label={t('settings.progressInThread')} hint={t('settings.progressInThreadHint')} checked={settings.progressInThread} onChange={(progressInThread) => updateSettings({ progressInThread })} />
      {!demo && <ApprovalsSetting client={client} connected={connected} />}
      <CompactionSetting slugs={bots.map((bot) => bot.slug)} context={compactionContext} demo={demo} />
      <VoiceSettings />
      <Row label={t('settings.sortBots')}>
        <Segments<'groups' | 'activity'> label={t('settings.sortBots')} value={settings.activitySort ? 'activity' : 'groups'} options={[{ id: 'groups', label: t('settings.sortOptions.groups') }, { id: 'activity', label: t('settings.sortOptions.activity') }]} onChange={(sort) => updateSettings({ activitySort: sort === 'activity' })} />
      </Row>
      <Toggle label={t('settings.showHidden')} checked={settings.showHidden} onChange={(showHidden) => updateSettings({ showHidden })} />
      {local?.available && local.models.length > 0 && (
        <Row label={t('settings.localModel')} hint={t('settings.localModelHint')}>
          <select className="settings-select" aria-label={t('settings.localModel')} value={localModel} onChange={(event) => updateSettings({ localModel: event.target.value })}>
            {local.models.map((model) => <option key={model} value={model}>{model}</option>)}
          </select>
        </Row>
      )}
      <ChatGuide />
    </>
  )
}

const DEMO_SETTINGS = new URLSearchParams(location.search).get('demo') === '1'

/** Voice mode: the voice of each language, the rate, the steps. "Test" speaks locally (free). */
function VoiceSettings() {
  const { t } = useTranslation()
  const settings = useSettings()
  const engine = useMemo(() => createSpeechEngine({ demo: DEMO_SETTINGS }), [])
  const [voices, setVoices] = useState<SpeechVoice[]>([])
  const testId = useRef(1)
  useEffect(() => { if (engine) void engine.voices().then(setVoices) }, [engine])
  if (!engine) return null
  const label = (voice: SpeechVoice) => {
    const quality = voice.quality === 'default' ? '' : t(`voice.settings.quality.${voice.quality}`)
    return `${voice.name} (${voice.language})${quality ? ` · ${quality}` : ''}`
  }
  const picker = (language: 'fr' | 'en') => {
    const key = language === 'fr' ? 'voiceFr' : 'voiceEn'
    const value = settings[key]
    const choices = voices.filter((voice) => voice.language.toLowerCase().startsWith(language))
    const test = () => {
      const voice = choices.find((item) => item.id === value)
      void engine.stop().then(() => engine.say({ id: testId.current++, text: t(language === 'fr' ? 'voice.settings.testFr' : 'voice.settings.testEn'), voice: value || undefined, language: voice?.language || (language === 'fr' ? 'fr-FR' : 'en-GB'), rate: settings.voiceRate }))
    }
    return (
      <Row label={t(language === 'fr' ? 'voice.settings.voiceFr' : 'voice.settings.voiceEn')}>
        <span className="settings-inline">
          <select className="settings-select" aria-label={t(language === 'fr' ? 'voice.settings.voiceFr' : 'voice.settings.voiceEn')} value={value} onChange={(event) => updateSettings({ [key]: event.target.value })}>
            <option value="">{t('voice.settings.systemVoice')}</option>
            {choices.map((voice) => <option key={voice.id} value={voice.id}>{label(voice)}</option>)}
          </select>
          <button type="button" className="settings-button" onClick={test}>{t('voice.settings.test')}</button>
        </span>
      </Row>
    )
  }
  return (
    <>
      <h3 className="settings-subheading">{t('voice.settings.title')}</h3>
      {picker('fr')}
      {picker('en')}
      <Row label={t('voice.settings.rate')} hint={t('voice.settings.voicesHint')}>
        <span className="settings-inline">
          <input type="range" className="settings-range" aria-label={t('voice.settings.rate')} min={0.6} max={1.6} step={0.05} value={settings.voiceRate} onChange={(event) => updateSettings({ voiceRate: Number(event.target.value) })} />
          <output className="settings-range-value">{settings.voiceRate.toFixed(2)}×</output>
        </span>
      </Row>
      <Toggle label={t('voice.settings.handsFree')} hint={t('voice.settings.handsFreeHint')} checked={settings.voiceHandsFree} onChange={(voiceHandsFree) => updateSettings({ voiceHandsFree })} />
      <Toggle label={t('voice.settings.steps')} hint={t('voice.settings.stepsHint')} checked={settings.voiceSteps} onChange={(voiceSteps) => updateSettings({ voiceSteps })} />
    </>
  )
}

const sameKeys = (a: string[], b: string[]) => {
  if (a.length !== b.length) return false
  const keys = new Set(a)
  return b.every((key) => keys.has(key))
}

type SaveStatus = '' | 'saved' | 'failed'

/**
 * The hidden-models editor's draft. Checkboxes only change the draft; the Save button writes it (merged
 * onto the gateway's latest copy). Held by the dialog: switching tabs keeps unsaved edits.
 */
function useHiddenModelsDraft(demo: boolean) {
  const { hiddenModels } = useSettings()
  const [baseline, setBaseline] = useState(hiddenModels)
  const [draft, setDraft] = useState(hiddenModels)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<SaveStatus>('')
  const dirty = !sameKeys(baseline, draft)
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty

  // The saved list changed (read back from the gateway): an untouched draft follows it.
  useEffect(() => {
    if (dirtyRef.current) return
    setBaseline(hiddenModels)
    setDraft(hiddenModels)
  }, [hiddenModels])

  const setVisible = (options: ModelOption[], visible: boolean) => {
    setDraft((current) => withModelsVisible(current, options, visible))
    setStatus('')
  }
  const discard = () => {
    setDraft(baseline)
    setStatus('')
  }
  const save = async () => {
    if (saving || !dirty) return
    setSaving(true)
    const sent = draft
    const result = await saveHiddenModels(baseline, sent, { local: demo })
    setSaving(false)
    if (!result.ok) {
      setStatus('failed')
      return
    }
    setBaseline(result.hiddenModels)
    // A box ticked while the save was on its way stays a change to save.
    setDraft((current) => current === sent ? result.hiddenModels : mergeHiddenModels(result.hiddenModels, sent, current))
    setStatus('saved')
  }
  return { draft, dirty, dirtyRef, saving, status, setVisible, discard, save }
}

type ModelsDraft = ReturnType<typeof useHiddenModelsDraft>

/** LLM Stats source, freshness and quota. Keys are configured outside the app. */
function ScoresSection() {
  const { t } = useTranslation()
  const scores = useScores()
  useEffect(() => { void ensureScores() }, [])
  const state = scores.keySource === 'command' ? t('settings.scores.commandState')
    : scores.keySource === 'keychain' ? t('settings.scores.keychainState')
      : scores.keySource === 'env' ? t('settings.scores.envState')
        : scores.models.length > 0 ? t('settings.scores.snapshotState') : t('settings.scores.missing')
  const quota = scores.quota?.remaining !== null && scores.quota?.remaining !== undefined && scores.quota.limit !== null && scores.quota.limit !== undefined
    ? t('settings.scores.quota', { remaining: scores.quota.remaining, limit: scores.quota.limit }) : ''
  return (
    <section className="settings-scores" aria-label={t('settings.scores.title')}>
      <h3 className="settings-scores-title">{t('settings.scores.title')}</h3>
      <p className="settings-note">{t('settings.scores.hint')}</p>
      <p className="settings-note" data-testid="scores-state">{state}{scores.updatedAt && scores.models.length > 0 ? ` ${t('settings.scores.updated', { date: new Date(scores.updatedAt).toLocaleDateString() })}` : ''}</p>
      {quota && <p className="settings-note" data-testid="scores-quota">{quota}</p>}
      {scores.error && <p className="settings-note is-error">{t(`settings.scores.error.${scores.error}`, { defaultValue: t('settings.scores.error.upstream_failed') })}</p>}
      <p className="settings-note"><ScoresAttribution /></p>
    </section>
  )
}

function ModelsTab({ models, modelsLoading, modelsError, onLoadModels, demo, draft: editor }: Pick<SettingsDialogProps, 'models' | 'modelsLoading' | 'modelsError' | 'onLoadModels'> & { demo: boolean; draft: ModelsDraft }) {
  const { t } = useTranslation()
  const { freeMode } = useSettings()
  const { ui } = useAppConfig()
  const [zeroSpendBusy, setZeroSpendBusy] = useState(false)
  const [zeroSpendFailed, setZeroSpendFailed] = useState(false)
  const [query, setQuery] = useState('')
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set())
  const scores = useScores()
  const scored = useMemo(() => scoreModels(models, scores), [models, scores])
  // A single read when the tab opens: the models from the gateway, the hidden list from its shared file.
  const loadRef = useRef(onLoadModels)
  useEffect(() => {
    loadRef.current()
    if (!demo) void syncSharedSettings()
  }, [demo])

  const hidden = useMemo(() => new Set(editor.draft), [editor.draft])
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

  const setVisible = editor.setVisible
  const toggleGroup = (slug: string) => setOpenGroups((current) => {
    const next = new Set(current)
    if (!next.delete(slug)) next.add(slug)
    return next
  })
  const changeZeroSpend = async (zeroSpend: boolean) => {
    if (zeroSpendBusy || zeroSpend === freeMode) return
    if (!zeroSpend && !window.confirm(t('settings.zeroSpendDisableConfirm'))) return
    setZeroSpendBusy(true)
    setZeroSpendFailed(false)
    const saved = await saveZeroSpend(zeroSpend, { local: demo })
    setZeroSpendBusy(false)
    setZeroSpendFailed(!saved)
  }

  return (
    <>
      <Toggle label={t('settings.freeMode')} hint={t('settings.freeModeHint')} checked={freeMode} disabled={zeroSpendBusy} onChange={(zeroSpend) => void changeZeroSpend(zeroSpend)} />
      {zeroSpendFailed && <p className="settings-note is-error" role="alert">{t('settings.zeroSpendSaveFailed')}</p>}
      <p className="settings-note">{t('settings.modelsNote')}</p>
      <ScoresSection />
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
      {!modelsLoading && !modelsError && filtered.length === 0 && (
        <ViewEmpty variant="inline" className="settings-models-empty" description={t('settings.noModel')} role="status" />
      )}
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
                  <span className="settings-model-label">{chipModelLabel(option.model)}</span>
                  <code>{option.model}</code>
                  <ModelScoreMeta info={scored.get(`${option.provider}:${option.model}`)} />
                  {option.tag && <span className="model-option-tag is-plan">{option.tag}</span>}
                  {modelCost(option, ui.subscriptionProviders) === 'free' && <span className="model-option-tag is-free">{t('settings.freeTag')}</span>}
                  {modelCost(option, ui.subscriptionProviders) === 'subscription' && <span className="model-option-tag is-plan">{t('settings.subscriptionTag')}</span>}
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

/** Save and discard of the model choices. Shown on every tab while an edit is unsaved. */
function ModelsSaveBar({ draft }: { draft: ModelsDraft }) {
  const { t } = useTranslation()
  const message = draft.saving ? t('settings.modelsSaving')
    : draft.status === 'failed' ? t('settings.modelsSaveFailed')
      : draft.dirty ? t('settings.modelsUnsaved')
        : draft.status === 'saved' ? t('settings.modelsSaved') : ''
  return (
    <footer className="settings-footer">
      <span className={`settings-footer-status ${draft.status === 'failed' ? 'is-error' : ''}`} role="status">{message}</span>
      <button type="button" className="settings-button" disabled={!draft.dirty || draft.saving} onClick={draft.discard}>{t('settings.modelsDiscard')}</button>
      <button type="button" className="settings-button is-primary" disabled={!draft.dirty || draft.saving} onClick={() => void draft.save()}>{t('settings.modelsSave')}</button>
    </footer>
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

/** App settings, specific to this Mac. Only the compaction block writes into the Hermes profiles, on its Save button. */
function UsageTab({ bots }: { bots: Bot[] }) {
  const { t } = useTranslation()
  return (
    <>
      <p className="settings-note">{t('usageGlobal.settingsIntro')}</p>
      <UsageGlobalSection bots={bots} />
      <AutoRoutingSection />
    </>
  )
}

export function SettingsDialog(props: SettingsDialogProps) {
  const { t } = useTranslation()
  const { tab, onSelectTab } = props
  const demo = props.demo === true
  const { features } = useAppConfig()
  const tabs = features.usageGlobal
    ? [...BASE_TABS.filter((item) => item.id !== 'account'), { id: 'usage' as const, icon: BarChart3 }, ...BASE_TABS.filter((item) => item.id === 'account')]
    : BASE_TABS
  const modelsDraft = useHiddenModelsDraft(demo)
  // Unsaved model choices are never dropped without asking.
  const onClose = () => {
    if (modelsDraft.dirtyRef.current && !window.confirm(t('settings.modelsDiscardConfirm'))) return
    props.onClose()
  }
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement && document.activeElement !== dialogRef.current ? document.activeElement : null
    dialogRef.current?.focus()
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [])
  const onDialogKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onClose()
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
        onKeyDown={onDialogKey}
      >
        <nav className="settings-nav" aria-label={t('settings.sections')}>
          <h2>{t('settings.title')}</h2>
          {tabs.map((item) => (
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
            {tab === 'chat' && <ChatTab localModels={props.localModels} bots={props.bots} demo={demo} compactionContext={props.compactionContext} client={props.client} connected={props.connected} />}
            {tab === 'models' && <ModelsTab models={props.models} modelsLoading={props.modelsLoading} modelsError={props.modelsError} onLoadModels={props.onLoadModels} demo={demo} draft={modelsDraft} />}
            {tab === 'memory' && <MemorySetting />}
            {tab === 'skills' && <SkillsSetting bots={props.bots} client={props.client ?? null} />}
            {tab === 'vault' && <VaultTab bots={props.bots} />}
            {tab === 'usage' && features.usageGlobal && <UsageTab bots={props.bots} />}
            {tab === 'channels' && <ChannelsWizard bots={props.bots} />}
            {tab === 'account' && <AccountTab connected={props.connected} reconnecting={props.reconnecting} onReconnect={props.onReconnect} onLogout={props.onLogout} />}
          </div>
          {(tab === 'models' || modelsDraft.dirty) && <ModelsSaveBar draft={modelsDraft} />}
        </section>
      </div>
    </div>
  )
}
