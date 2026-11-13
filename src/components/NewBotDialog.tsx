import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { RotateCw, X } from 'lucide-react'
import type { Bot } from '../types'
import { BotAvatar, avatarColor, avatarShape } from './BotAvatar'
import {
  BOT_COLORS, BOT_SHAPES, BotCreateError, botCreateErrorText, canonicalShape, createdBotEntry, leastUsed, PROFILE_NAME_MAX,
  profileNameFrom, profileNameIssue, type BotDraft, type KnownProfiles, type ProfileNameIssue,
} from '../lib/bot-create'
import './NewBotDialog.css'

type ColorId = (typeof BOT_COLORS)[number]['id']
type ShapeId = (typeof BOT_SHAPES)[number]
const COLOR_IDS = BOT_COLORS.map((color) => color.id)
const colorValue = (id: ColorId) => BOT_COLORS.find((color) => color.id === id)!.value
const NAME_ISSUES = new Set<string>(['invalid', 'reserved', 'taken', 'removed'])

interface NewBotDialogProps {
  /** The roster on screen: names already taken, looks already used. */
  bots: Bot[]
  /** Hermes answers (or the demo runs): Create is possible. */
  connected: boolean
  /** Every profile Hermes holds now, hidden ones included; null in the demo. */
  loadKnown: (() => Promise<KnownProfiles>) | null
  /** Creates the bot and opens its chat; rejects with a `BotCreateError` when the profile was not created. */
  onCreate: (draft: BotDraft) => Promise<void>
  onClose: () => void
}

/** A row of choices with the keyboard of a radio group: arrows move the choice, Tab leaves the row. */
function Choices<T extends string>({ label, options, value, onChange, labelOf, render, className }: {
  label: string
  options: readonly T[]
  value: T
  onChange: (value: T) => void
  labelOf: (value: T) => string
  render: (value: T) => ReactNode
  className: string
}) {
  const id = useId()
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const move = (event: KeyboardEvent, at: number) => {
    const step = ({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Record<string, number>)[event.key]
    const next = step ? (at + step + options.length) % options.length : event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : -1
    if (next < 0) return
    event.preventDefault()
    onChange(options[next])
    refs.current[next]?.focus()
  }
  return (
    <div className="new-bot-field">
      <span className="new-bot-label" id={id}>{label}</span>
      <div className={className} role="radiogroup" aria-labelledby={id}>
        {options.map((option, at) => (
          <button
            key={option}
            ref={(element) => { refs.current[at] = element }}
            type="button"
            role="radio"
            aria-checked={option === value}
            aria-label={labelOf(option)}
            title={labelOf(option)}
            tabIndex={option === value ? 0 : -1}
            data-value={option}
            onClick={() => onChange(option)}
            onKeyDown={(event) => move(event, at)}
          >
            {render(option)}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * New bot, in two steps: its name (and the Hermes profile name derived from it), then its look. Create makes the
 * profile and its card; the app then opens the bot's chat, where it introduces itself.
 */
export function NewBotDialog({ bots, connected, loadKnown, onCreate, onClose }: NewBotDialogProps) {
  const { t } = useTranslation()
  const titleId = useId()
  const stepId = useId()
  const hintId = useId()
  const [step, setStep] = useState<0 | 1>(0)
  const [title, setTitle] = useState('')
  // The look the existing bots use least, so the new one stands out in the list.
  const [colorId, setColorId] = useState<ColorId>(() => {
    const value = leastUsed(BOT_COLORS.map((color) => color.value), bots.map(avatarColor))
    return BOT_COLORS.find((color) => color.value === value)!.id
  })
  const [shape, setShape] = useState<ShapeId>(() => leastUsed(BOT_SHAPES, bots.map((bot) => canonicalShape(avatarShape(bot)))))
  const [known, setKnown] = useState<KnownProfiles | null>(null)
  // A name the gateway refused although nothing on screen knew it (another app created it meanwhile).
  const [refusedName, setRefusedName] = useState<{ slug: string; issue: ProfileNameIssue } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const flight = useRef(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const lookRef = useRef<HTMLDivElement>(null)
  const opener = useRef<Element | null>(null)
  useEffect(() => { opener.current = document.activeElement }, [])

  useEffect(() => {
    let current = true
    loadKnown?.().then((value) => { if (current) setKnown(value) }).catch(() => { /* the roster on screen still says what is taken */ })
    return () => { current = false }
  }, [loadKnown])

  const clean = title.replace(/\s+/g, ' ').trim()
  const slug = profileNameFrom(clean)
  const taken = useMemo(() => new Set([...bots.map((bot) => bot.slug), ...(known?.taken ?? [])]), [bots, known])
  const issue = !clean ? null : refusedName?.slug === slug ? refusedName.issue : profileNameIssue(slug, { taken, removed: known?.removed ?? new Set() })
  const canNext = Boolean(clean) && !issue
  const color = colorValue(colorId)

  // Keyboard focus follows the step: the name field, then the chosen color.
  useEffect(() => {
    if (step === 0) nameRef.current?.focus()
    else lookRef.current?.querySelector<HTMLElement>('[role=radio][aria-checked=true]')?.focus()
  }, [step])

  const close = () => {
    if (busy) return
    const back = opener.current
    onClose()
    if (back instanceof HTMLElement) setTimeout(() => back.focus({ preventScroll: true }), 0)
  }

  const create = async () => {
    if (flight.current || !canNext || !connected) return
    flight.current = true
    setBusy(true)
    setError('')
    try {
      await onCreate({ title: clean, slug, color, shape })
    } catch (failure) {
      if (failure instanceof BotCreateError && NAME_ISSUES.has(failure.reason)) {
        setRefusedName({ slug, issue: failure.reason as ProfileNameIssue })
        setStep(0)
      } else setError(botCreateErrorText(failure, slug))
      setBusy(false)
    } finally {
      flight.current = false
    }
  }

  const advance = () => {
    if (busy) return
    if (step === 1) void create()
    else if (canNext) {
      setError('')
      setStep(1)
    }
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    advance()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      close()
      return
    }
    // Enter moves on from anywhere in the dialog, a choice of color or shape included.
    if (event.key === 'Enter' && !event.nativeEvent.isComposing && (event.target as HTMLElement).getAttribute('role') === 'radio') {
      event.preventDefault()
      advance()
    }
  }

  const previewBot = createdBotEntry({ title: clean || t('newBot.title'), slug: slug || 'new-bot', color, shape })
  const stepName = step === 0 ? t('newBot.stepName') : t('newBot.stepLook')

  return (
    <div className="request-scrim new-bot-scrim" role="presentation" onKeyDown={onKeyDown} onPointerDown={(event) => { if (event.target === event.currentTarget) close() }}>
      <form className="request-sheet new-bot-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={stepId} autoComplete="off" onSubmit={submit}>
        <header className="new-bot-header">
          <h2 id={titleId}>{t('newBot.title')}</h2>
          <p id={stepId} className="new-bot-step">
            <span className="new-bot-dots" aria-hidden="true"><i className={step === 0 ? 'is-current' : 'is-done'} /><i className={step === 1 ? 'is-current' : ''} /></span>
            {t('newBot.step', { current: step + 1 })} · {stepName}
          </p>
        </header>

        {step === 0 ? (
          <div className="new-bot-pane" key="name">
            <label>
              {t('newBot.nameLabel')}
              <input
                ref={nameRef}
                value={title}
                maxLength={PROFILE_NAME_MAX}
                placeholder={t('newBot.namePlaceholder')}
                spellCheck={false}
                aria-invalid={Boolean(issue)}
                aria-describedby={hintId}
                disabled={busy}
                onChange={(event) => { setTitle(event.target.value); setError('') }}
              />
            </label>
            <p id={hintId} className={`new-bot-hint${issue ? ' is-issue' : ''}`} aria-live="polite">
              {issue ? t(`newBot.issues.${issue}`, { slug }) : slug ? t('newBot.profileHint', { slug }) : ' '}
            </p>
          </div>
        ) : (
          <div className="new-bot-pane" key="look" ref={lookRef}>
            <div className="new-bot-preview" aria-label={t('newBot.preview')} role="group">
              <BotAvatar bot={previewBot} size={56} />
              <div className="new-bot-preview-copy">
                <strong>{clean}</strong>
                <span>{t('newBot.profileHint', { slug })}</span>
              </div>
            </div>
            <Choices
              label={t('newBot.color')}
              className="new-bot-colors"
              options={COLOR_IDS}
              value={colorId}
              onChange={setColorId}
              labelOf={(id) => t(`newBot.colors.${id}`)}
              render={(id) => <span className="new-bot-swatch" style={{ background: colorValue(id) }} />}
            />
            <Choices
              label={t('newBot.shape')}
              className="new-bot-shapes"
              options={BOT_SHAPES}
              value={shape}
              onChange={setShape}
              labelOf={(id) => t(`newBot.shapes.${id}`)}
              render={(id) => <span aria-hidden="true"><BotAvatar bot={{ ...previewBot, avatar: { shape: id, color } }} size={26} /></span>}
            />
          </div>
        )}

        {error && <p className="request-error" role="alert">{error}</p>}
        {!connected && <p className="request-error" role="status">{t('newBot.offline')}</p>}
        <div className="request-actions">
          {step === 0
            ? <button type="button" onClick={close} disabled={busy}>{t('newBot.cancel')}</button>
            : <button type="button" onClick={() => setStep(0)} disabled={busy}>{t('newBot.back')}</button>}
          {step === 0
            ? <button type="submit" className="is-primary" disabled={!canNext}>{t('newBot.next')}</button>
            : <button type="submit" className="is-primary" disabled={busy || !canNext || !connected} aria-busy={busy}>{busy ? t('newBot.creating') : t('newBot.create')}</button>}
        </div>
        {step === 1 && <p className="new-bot-kickoff">{t('newBot.kickoffNote', { name: clean })}</p>}
      </form>
    </div>
  )
}

/** A bot just created whose chat Hermes cannot open yet: the reason, and a way to try again. */
export function NewBotRetry({ name, onRetry, onClose }: { name: string; onRetry: () => void; onClose: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="toast new-bot-retry" role="alert">
      <span>{t('newBot.notReady', { name })}</span>
      <button type="button" className="new-bot-retry-action" onClick={onRetry}><RotateCw size={13} />{t('newBot.retry')}</button>
      <button type="button" className="new-bot-retry-close" aria-label={t('app.close')} onClick={onClose}><X size={15} /></button>
    </div>
  )
}
