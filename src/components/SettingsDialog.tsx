import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, Cpu, KeyRound, MessageSquare, Search, SlidersHorizontal, UserRound, X, type LucideIcon } from 'lucide-react'
import { version } from '../../package.json'
import type { Bot, ModelOption } from '../types'
import { VaultTab } from './VaultTab'
import { modelLabel } from '../lib/model'
import { groupModels, ProviderTile } from './ModelPicker'
import { hiddenModelKey, updateSettings, useSettings, withModelsVisible, type SendKey, type TextSize, type ThemeChoice } from '../lib/settings'

export type SettingsTab = 'general' | 'chat' | 'models' | 'vault' | 'account'

const TABS: { id: SettingsTab; label: string; icon: LucideIcon }[] = [
  { id: 'general', label: 'Général', icon: SlidersHorizontal },
  { id: 'chat', label: 'Conversations', icon: MessageSquare },
  { id: 'models', label: 'Modèles', icon: Cpu },
  { id: 'vault', label: 'Coffre', icon: KeyRound },
  { id: 'account', label: 'Compte', icon: UserRound },
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
  /** Noms des bots et choix des bots autorisés dans le coffre. */
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
  const settings = useSettings()
  return (
    <>
      <Row label="Thème">
        <Segments<ThemeChoice> label="Thème" value={settings.theme} options={[{ id: 'system', label: 'Système' }, { id: 'light', label: 'Clair' }, { id: 'dark', label: 'Sombre' }]} onChange={onChooseTheme} />
      </Row>
      <Row label="Taille du texte" hint="Messages et zone de saisie">
        <Segments<TextSize> label="Taille du texte" value={settings.textSize} options={[{ id: 'small', label: 'Petite' }, { id: 'normal', label: 'Normale' }, { id: 'large', label: 'Grande' }]} onChange={(textSize) => updateSettings({ textSize })} />
      </Row>
      <Toggle label="Réduire les animations" hint="Avatars fixes, le statut reste écrit. Le réglage de macOS s’applique aussi." checked={settings.reduceMotion} onChange={(reduceMotion) => updateSettings({ reduceMotion })} />
    </>
  )
}

function ChatTab() {
  const settings = useSettings()
  return (
    <>
      <Row label="Envoyer un message avec">
        <Segments<SendKey> label="Envoyer un message avec" value={settings.sendKey} options={[{ id: 'enter', label: 'Entrée' }, { id: 'cmd-enter', label: '⌘ Entrée' }]} onChange={(sendKey) => updateSettings({ sendKey })} />
      </Row>
      <Toggle label="Afficher le contexte et le débit" hint="Sous la zone de saisie" checked={settings.showUsage} onChange={(showUsage) => updateSettings({ showUsage })} />
      <Row label="Classer les bots">
        <Segments<'groups' | 'activity'> label="Classer les bots" value={settings.activitySort ? 'activity' : 'groups'} options={[{ id: 'groups', label: 'Groupes' }, { id: 'activity', label: 'Activité' }]} onChange={(sort) => updateSettings({ activitySort: sort === 'activity' })} />
      </Row>
      <Toggle label="Afficher les bots cachés" checked={settings.showHidden} onChange={(showHidden) => updateSettings({ showHidden })} />
    </>
  )
}

function ModelsTab({ models, modelsLoading, modelsError, onLoadModels }: Pick<SettingsDialogProps, 'models' | 'modelsLoading' | 'modelsError' | 'onLoadModels'>) {
  const { hiddenModels } = useSettings()
  const [query, setQuery] = useState('')
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set())
  // Une seule lecture à l’ouverture de l’onglet : la liste vient de la gateway.
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
      <p className="settings-note">Choisis les modèles proposés dans le sélecteur, sur ce Mac et pour tous les bots. Le modèle actif et celui du profil restent toujours proposés.</p>
      <div className="settings-model-tools">
        <div className="settings-search">
          <Search size={14} />
          <input value={query} placeholder="Rechercher un modèle" aria-label="Rechercher dans les modèles" onChange={(event) => setQuery(event.target.value)} />
          {query && <button type="button" aria-label="Effacer la recherche" onClick={() => setQuery('')}><X size={13} /></button>}
        </div>
        {models.length > 0 && <span className="settings-count">{visibleCount} sur {models.length}</span>}
        {hidden.size > 0 && models.length > 0 && <button type="button" className="settings-button" onClick={() => setVisible(models, true)}>Tout afficher</button>}
      </div>
      {modelsLoading && models.length === 0 && <p className="settings-note">Chargement des modèles…</p>}
      {modelsError && <p className="settings-note is-error">{modelsError} <button type="button" className="settings-link" onClick={onLoadModels}>Réessayer</button></p>}
      {!modelsLoading && !modelsError && filtered.length === 0 && <p className="settings-note">Aucun modèle trouvé.</p>}
      <div className="settings-model-groups">
        {groups.map((group) => {
          const open = searching || openGroups.has(group.slug)
          const shown = group.models.filter((option) => !hidden.has(hiddenModelKey(option))).length
          const label = `Proposer les modèles ${group.name}`
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
  return (
    <>
      <Row label="Connexion à Hermes" hint={reconnecting ? 'Reconnexion…' : connected ? 'Connecté' : 'Déconnecté'}>
        <button type="button" className="settings-button" disabled={reconnecting} onClick={onReconnect}>Reconnecter</button>
      </Row>
      <Row label="Session" hint="Oublie les identifiants enregistrés sur ce Mac">
        <button type="button" className="settings-button is-danger" onClick={onLogout}>Se déconnecter</button>
      </Row>
      <Row label="Version"><span className="settings-value">HermesBot {version}</span></Row>
    </>
  )
}

/** Réglages de l’app, propres à ce Mac. Rien ici n’écrit dans un profil Hermes. */
export function SettingsDialog(props: SettingsDialogProps) {
  const { tab, onSelectTab, onClose } = props
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => dialogRef.current?.focus(), [])
  const title = TABS.find((item) => item.id === tab)?.label
  return (
    <div className="settings-backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="settings"
        role="dialog"
        aria-modal="true"
        aria-label="Réglages"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}
      >
        <nav className="settings-nav" aria-label="Sections des réglages">
          <h2>Réglages</h2>
          {TABS.map((item) => (
            <button key={item.id} type="button" className={item.id === tab ? 'is-active' : ''} aria-current={item.id === tab ? 'page' : undefined} onClick={() => onSelectTab(item.id)}>
              <item.icon size={15} />{item.label}
            </button>
          ))}
        </nav>
        <section className="settings-body">
          <header className="settings-head">
            <h3>{title}</h3>
            <button type="button" className="plain-icon" aria-label="Fermer les réglages" onClick={onClose}><X size={16} /></button>
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
