import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, X } from 'lucide-react'
import type { Bot } from '../types'
import { BotAvatar } from './BotAvatar'
import './NewRoomDialog.css'

const MIN_BOTS = 2
const MAX_BOTS = 6
const MAX_NAME = 200

interface NewRoomDialogProps {
  bots: Bot[]
  connected: boolean
  onCreate: (draft: { name: string; bots: Bot[] }) => Promise<void>
  onClose: () => void
}

function errorText(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return fallback
}

/** A room groups existing visible bots. Creating it only makes the room; the first message starts the bots. */
export function NewRoomDialog({ bots, connected, onCreate, onClose }: NewRoomDialogProps) {
  const { t } = useTranslation()
  const titleId = useId()
  const introId = useId()
  const nameHintId = useId()
  const botsLabelId = useId()
  const selectionHintId = useId()
  const countId = useId()
  const [name, setName] = useState('')
  const [query, setQuery] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const flight = useRef(false)
  const dialogRef = useRef<HTMLFormElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const opener = useRef<HTMLElement | null>(null)

  useEffect(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    nameRef.current?.focus()
    return () => {
      const back = opener.current
      if (back?.isConnected) setTimeout(() => back.focus({ preventScroll: true }), 0)
    }
  }, [])

  const availableBots = useMemo(() => {
    const seen = new Set<string>()
    return bots.filter((bot) => {
      if (bot.hidden || seen.has(bot.slug)) return false
      seen.add(bot.slug)
      return true
    })
  }, [bots])

  const filteredBots = useMemo(() => {
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
    if (words.length === 0) return availableBots
    return availableBots.filter((bot) => {
      const haystack = `${bot.name} ${bot.role} ${bot.section}`.toLocaleLowerCase()
      return words.every((word) => haystack.includes(word))
    })
  }, [availableBots, query])

  const selectedBots = useMemo(() => availableBots.filter((bot) => selectedIds.has(bot.slug)), [availableBots, selectedIds])
  const cleanName = name.trim()
  const validCount = selectedBots.length >= MIN_BOTS && selectedBots.length <= MAX_BOTS
  const canCreate = Boolean(cleanName) && validCount && connected && !busy
  const atLimit = selectedBots.length >= MAX_BOTS

  const close = () => {
    if (!busy) onClose()
  }

  const toggle = (bot: Bot) => {
    if (busy) return
    setError('')
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(bot.slug)) next.delete(bot.slug)
      else if (selectedBots.length < MAX_BOTS) next.add(bot.slug)
      return next
    })
  }

  const create = async () => {
    if (flight.current || !canCreate) return
    flight.current = true
    setBusy(true)
    setError('')
    try {
      await onCreate({ name: cleanName, bots: selectedBots })
    } catch (failure) {
      setError(errorText(failure, t('newRoom.createFailed')))
      setBusy(false)
    } finally {
      flight.current = false
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    void create()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    if (event.key !== 'Tab') return
    const dialog = dialogRef.current
    if (!dialog) return
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'))
    if (focusable.length === 0) {
      event.preventDefault()
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const active = document.activeElement
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault()
      first.focus()
    }
  }

  const nameIssue = name.length > 0 && !cleanName

  return (
    <div className="request-scrim new-room-scrim" role="presentation" onKeyDown={onKeyDown} onPointerDown={(event) => { if (event.target === event.currentTarget) close() }}>
      <form ref={dialogRef} className="request-sheet new-room-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={introId} autoComplete="off" onSubmit={submit}>
        <header className="new-room-header">
          <h2 id={titleId}>{t('newRoom.title')}</h2>
          <p id={introId}>{t('newRoom.intro')}</p>
        </header>

        <div className="new-room-name">
          <label htmlFor={`${nameHintId}-input`}>{t('newRoom.nameLabel')}</label>
          <input
            id={`${nameHintId}-input`}
            ref={nameRef}
            value={name}
            maxLength={MAX_NAME}
            placeholder={t('newRoom.namePlaceholder')}
            spellCheck={false}
            required
            aria-invalid={nameIssue}
            aria-describedby={nameHintId}
            disabled={busy}
            onChange={(event) => { setName(event.target.value); setError('') }}
          />
          <p id={nameHintId} className={`new-room-hint${nameIssue ? ' is-issue' : ''}`} aria-live="polite">
            {nameIssue ? t('newRoom.nameRequired') : t('newRoom.nameHint')}
          </p>
        </div>

        <section className="new-room-picker" aria-labelledby={botsLabelId} aria-describedby={selectionHintId}>
          <div className="new-room-picker-head">
            <h3 id={botsLabelId}>{t('newRoom.botsLabel')}</h3>
            <span id={countId} className="new-room-count" aria-live="polite">{t('newRoom.selectedCount', { count: selectedBots.length })}</span>
          </div>
          <p id={selectionHintId} className="new-room-hint">{t('newRoom.selectionHint')}</p>
          <div className="new-room-search">
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              value={query}
              placeholder={t('newRoom.searchPlaceholder')}
              aria-label={t('newRoom.searchLabel')}
              disabled={busy}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query && <button type="button" aria-label={t('newRoom.clearSearch')} title={t('newRoom.clearSearch')} disabled={busy} onClick={() => setQuery('')}><X size={13} aria-hidden="true" /></button>}
          </div>

          {filteredBots.length > 0 ? (
            <ul className="new-room-bot-list" aria-describedby={countId}>
              {filteredBots.map((bot) => {
                const selected = selectedIds.has(bot.slug)
                const disabled = busy || (!selected && atLimit)
                return (
                  <li key={bot.slug}>
                    <label className={`new-room-bot${selected ? ' is-selected' : ''}${disabled ? ' is-disabled' : ''}`}>
                      <input type="checkbox" checked={selected} disabled={disabled} onChange={() => toggle(bot)} />
                      <BotAvatar bot={bot} size={34} />
                      <span className="new-room-bot-copy">
                        <strong>{bot.name}</strong>
                        <span>{bot.role || t('newRoom.noRole')}</span>
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="new-room-empty" role="status">{query.trim() ? t('newRoom.noResults') : t('newRoom.noBots')}</p>
          )}
        </section>

        {error && <p className="request-error" role="alert">{error}</p>}
        {!connected && <p className="request-error" role="status">{t('newRoom.offline')}</p>}
        <div className="request-actions">
          <button type="button" onClick={close} disabled={busy}>{t('newRoom.cancel')}</button>
          <button type="submit" className="is-primary" disabled={!canCreate} aria-busy={busy}>{busy ? t('newRoom.creating') : t('newRoom.create')}</button>
        </div>
        <p className="new-room-turn-note">{t('newRoom.turnNote')}</p>
      </form>
    </div>
  )
}
