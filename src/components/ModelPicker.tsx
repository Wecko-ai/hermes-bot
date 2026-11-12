import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronRight, ChevronsDownUp, ChevronsUpDown, Cpu, Search, X } from 'lucide-react'
import type { ModelOption } from '../types'
import { modelLabel } from '../lib/model'
import { providerBrand } from '../lib/providers'

interface ModelPickerProps {
  options: ModelOption[]
  current: string
  profileModel: string
  loading: boolean
  error: string
  /** Providers the gateway says cannot serve this bot (no usable key), with its reason. */
  unusable?: Record<string, string>
  initialQuery: string
  onSelect: (option: ModelOption) => void | Promise<void>
  onClose: () => void
  onManage: () => void
}

export interface ProviderGroup {
  slug: string
  name: string
  local: boolean
  logo?: string
  models: ModelOption[]
}

type Row =
  | { key: string; kind: 'group'; slug: string }
  | { key: string; kind: 'model'; slug: string; option: ModelOption }

const OPEN_GROUPS_KEY = 'hermesbot-model-groups'
const groupKey = (slug: string) => `group:${slug}`
const modelKey = (option: ModelOption) => `model:${option.provider}:${option.model}`
const tileHue = (slug: string) => [...slug].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 360, 7)
const brandOf = (option: ModelOption) => providerBrand(option.provider, option.providerName)

export function groupModels(options: ModelOption[]) {
  const map = new Map<string, ProviderGroup>()
  options.forEach((option) => {
    const brand = brandOf(option)
    const group = map.get(brand.group) ?? { slug: brand.group, name: brand.name, local: brand.local, logo: brand.logo, models: [] }
    group.models.push(option)
    map.set(brand.group, group)
  })
  return [...map.values()]
}

export function ProviderTile({ group }: { group: ProviderGroup }) {
  if (group.local) return <span className="model-group-tile is-local"><Cpu size={15} aria-hidden="true" /></span>
  if (group.logo) return <span className="model-group-tile has-logo"><img src={group.logo} alt="" draggable={false} /></span>
  return <span className="model-group-tile" style={{ '--tile-hue': tileHue(group.slug) } as CSSProperties}>{group.name.trim()[0]?.toUpperCase()}</span>
}

function readOpenGroups(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(OPEN_GROUPS_KEY) || '[]')
    return Array.isArray(saved) ? saved.filter((slug) => typeof slug === 'string') : []
  } catch {
    return []
  }
}

function saveOpenGroups(slugs: string[]) {
  try { localStorage.setItem(OPEN_GROUPS_KEY, JSON.stringify(slugs)) } catch { /* storage unavailable */ }
}

export function ModelPicker({ options, current, profileModel, loading, error, unusable = {}, initialQuery, onSelect, onClose, onManage }: ModelPickerProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState(initialQuery)
  const [openGroups, setOpenGroups] = useState(readOpenGroups)
  // The active model's group always opens on arrival: it is only folded for this opening.
  const [currentFolded, setCurrentFolded] = useState(false)
  const [activeKey, setActiveKey] = useState('')
  const [pendingKey, setPendingKey] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const revealedRef = useRef(false)
  useEffect(() => inputRef.current?.focus(), [])

  const searching = query.trim().length > 0

  const filtered = useMemo(() => {
    const words = query.toLocaleLowerCase('fr').split(/[\s/_-]+/).filter(Boolean)
    return options.filter((option) => {
      const text = `${option.model} ${modelLabel(option.model)} ${option.providerName} ${brandOf(option).name}`.toLocaleLowerCase('fr').replace(/[/_-]+/g, ' ')
      return words.every((word) => text.includes(word))
    })
  }, [options, query])

  const groups = useMemo(() => groupModels(filtered), [filtered])

  const currentOption = useMemo(() => options.find((option) => option.model === current), [options, current])
  const currentSlug = currentOption ? brandOf(currentOption).group : ''
  const isOpen = (slug: string) => searching || (slug === currentSlug ? !currentFolded : openGroups.includes(slug))

  // While searching everything is expanded: the arrows only walk through models.
  const rows = useMemo<Row[]>(() => groups.flatMap((group) => {
    const open = searching || (group.slug === currentSlug ? !currentFolded : openGroups.includes(group.slug))
    const models: Row[] = open ? group.models.map((option) => ({ key: modelKey(option), kind: 'model', slug: group.slug, option })) : []
    return searching ? models : [{ key: groupKey(group.slug), kind: 'group', slug: group.slug }, ...models]
  }), [groups, searching, currentSlug, currentFolded, openGroups])

  const activeIndex = (() => {
    const chosen = rows.findIndex((row) => row.key === activeKey)
    if (chosen >= 0) return chosen
    const onCurrent = rows.findIndex((row) => row.kind === 'model' && row.option.model === current)
    return !searching && onCurrent >= 0 ? onCurrent : 0
  })()
  const active: Row | undefined = rows[activeIndex]

  useLayoutEffect(() => {
    if (revealedRef.current || searching || options.length === 0) return
    revealedRef.current = true
    listRef.current?.querySelector('.model-option.is-current')?.scrollIntoView({ block: 'nearest' })
  }, [options.length, searching])

  const setGroupOpen = (slug: string, open: boolean) => {
    if (slug === currentSlug) {
      setCurrentFolded(!open)
      return
    }
    const next = open ? [...new Set([...openGroups, slug])] : openGroups.filter((item) => item !== slug)
    setOpenGroups(next)
    saveOpenGroups(next)
  }

  const allOpen = groups.length > 0 && groups.every((group) => isOpen(group.slug))
  const toggleAll = () => {
    const next = allOpen ? [] : groups.map((group) => group.slug)
    setOpenGroups(next)
    saveOpenGroups(next)
    setCurrentFolded(allOpen)
  }

  const choose = (option: ModelOption) => {
    if (pendingKey) return
    if (option.model === current && option.provider === currentOption?.provider) {
      onClose()
      return
    }
    setPendingKey(modelKey(option))
    Promise.resolve(onSelect(option)).finally(() => setPendingKey(''))
  }

  const move = (delta: number) => {
    if (rows.length === 0) return
    const next = rows[(activeIndex + delta + rows.length) % rows.length]
    setActiveKey(next.key)
    listRef.current?.querySelector(`[data-row="${CSS.escape(next.key)}"]`)?.scrollIntoView({ block: 'nearest' })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') onClose()
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      move(event.key === 'ArrowDown' ? 1 : -1)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (active?.kind === 'model') choose(active.option)
      if (active?.kind === 'group') setGroupOpen(active.slug, !isOpen(active.slug))
    } else if (!searching && active && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      // Empty field here: the side arrows have no cursor to move.
      event.preventDefault()
      setGroupOpen(active.slug, event.key === 'ArrowRight')
      setActiveKey(groupKey(active.slug))
    }
  }

  return (
    <>
      <button className="model-picker-scrim" aria-label={t('models.closePicker')} onClick={onClose} />
      <div className="model-picker" role="dialog" aria-label={t('models.choose')}>
        <div className="model-picker-search">
          <Search size={15} />
          <input
            ref={inputRef}
            value={query}
            placeholder={t('models.search')}
            aria-label={t('models.search')}
            aria-controls="model-picker-list"
            onChange={(event) => { setQuery(event.target.value); setActiveKey('') }}
            onKeyDown={onKeyDown}
          />
          {query && <button className="model-picker-tool" aria-label={t('models.clearSearch')} title={t('models.clear')} onClick={() => { setQuery(''); inputRef.current?.focus() }}><X size={14} /></button>}
          {!searching && groups.length > 1 && (
            <button className="model-picker-tool" aria-label={allOpen ? t('models.collapseAll') : t('models.expandAll')} title={allOpen ? t('models.collapseAll') : t('models.expandAll')} onClick={toggleAll}>
              {allOpen ? <ChevronsDownUp size={15} /> : <ChevronsUpDown size={15} />}
            </button>
          )}
        </div>
        <div className="model-picker-list" id="model-picker-list" ref={listRef}>
          {loading && options.length === 0 && <div className="model-picker-skeleton" aria-label={t('models.loading')}><span /><span /><span /><span /></div>}
          {error && <p className="model-picker-note is-error">{error}</p>}
          {!loading && !error && filtered.length === 0 && <p className="model-picker-note">{t('models.none')}</p>}
          {groups.map((group) => {
            const open = isOpen(group.slug)
            const bodyId = `model-group-${group.slug}`
            const headKey = groupKey(group.slug)
            return (
              <section key={group.slug} className={`model-group ${open ? 'is-open' : ''}`}>
                <button
                  className={`model-group-head ${active?.key === headKey ? 'is-active' : ''}`}
                  data-row={headKey}
                  aria-expanded={open}
                  aria-controls={bodyId}
                  disabled={searching}
                  tabIndex={-1}
                  onMouseMove={() => setActiveKey(headKey)}
                  onClick={() => { setGroupOpen(group.slug, !open); inputRef.current?.focus() }}
                >
                  <ChevronRight className="model-group-chevron" size={14} />
                  <ProviderTile group={group} />
                  <span className="model-group-name">{group.name}</span>
                  {!open && group.slug === currentSlug && <span className="model-group-current">{modelLabel(current)}</span>}
                  <span className="model-group-count">{group.models.length}</span>
                </button>
                <div className="model-group-body" id={bodyId} inert={!open}>
                  <div className="model-group-inner">
                    {group.models.map((option) => {
                      const key = modelKey(option)
                      const isCurrent = option.model === current
                      const issue = unusable[option.provider]
                      return (
                        <button
                          key={key}
                          className={`model-option ${isCurrent ? 'is-current' : ''} ${active?.key === key ? 'is-active' : ''} ${pendingKey === key ? 'is-pending' : ''} ${issue ? 'is-unusable' : ''}`}
                          data-model={option.model}
                          data-row={key}
                          title={issue ? `${option.model} · ${issue}` : option.model}
                          tabIndex={-1}
                          onMouseMove={() => setActiveKey(key)}
                          onClick={() => choose(option)}
                        >
                          <span className="model-option-name">{modelLabel(option.model)}</span>
                          {option.tag && <span className="model-option-tag is-plan">{option.tag}</span>}
                          {issue && <span className="model-option-tag is-unusable">{t('models.noKey')}</span>}
                          {option.model === profileModel && <span className="model-option-tag">{t('models.profile')}</span>}
                          {option.inputPrice && option.outputPrice && <span className="model-option-price">{option.inputPrice} / {option.outputPrice}</span>}
                          {isCurrent && <Check className="model-option-check" size={15} />}
                        </button>
                      )
                    })}
                  </div>
                </div>
              </section>
            )
          })}
        </div>
        <div className="model-picker-footer">
          <span>{t('models.thisConversation')}<button type="button" className="model-picker-manage" onClick={onManage}>{t('models.manage')}</button></span>
          <span className="model-picker-keys" aria-hidden="true"><kbd>↑</kbd><kbd>↓</kbd><i>{t('models.navigate')}</i><kbd>←</kbd><kbd>→</kbd><i>{t('models.fold')}</i><kbd>↵</kbd><i>{t('models.pick')}</i></span>
        </div>
      </div>
    </>
  )
}
