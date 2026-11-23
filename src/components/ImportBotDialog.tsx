import { useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Upload } from 'lucide-react'
import type { Bot } from '../types'
import type { HermesClient } from '../lib/hermes'
import { BotSheet } from './BotDialogs'
import {
  BOT_COLORS,
  BOT_SHAPES,
  PROFILE_NAME_MAX,
  canonicalShape,
  createdBotEntry,
  leastUsed,
  loadProfileNames,
  profileNameFrom,
  profileNameIssue,
  type BotDraft,
  type KnownProfiles,
} from '../lib/bot-create'
import { BotAvatar, avatarColor, avatarShape } from './BotAvatar'
import { createBotFromTemplate, validateBotTemplate } from '../lib/bot-import'
import { botCreateErrorText, BotCreateError } from '../lib/bot-create'

type ColorId = (typeof BOT_COLORS)[number]['id']

interface ImportBotDialogProps {
  bots: Bot[]
  client: HermesClient | null
  connected: boolean
  onClose: () => void
  onCreated: (draft: BotDraft) => Promise<void>
}

export function ImportBotDialog({ bots, client, connected, onClose, onCreated }: ImportBotDialogProps) {
  const { t } = useTranslation()
  const fileRef = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [known, setKnown] = useState<KnownProfiles | null>(null)
  const [previewSoul, setPreviewSoul] = useState('')
  const [toolsets, setToolsets] = useState('')
  const [imported, setImported] = useState<Awaited<ReturnType<typeof validateBotTemplate>> | null>(null)
  const [colorId, setColorId] = useState<ColorId>(() => {
    const value = leastUsed(BOT_COLORS.map((color) => color.value), bots.map(avatarColor))
    return BOT_COLORS.find((color) => color.value === value)!.id
  })
  const [shape, setShape] = useState(() => leastUsed(BOT_SHAPES, bots.map((bot) => canonicalShape(avatarShape(bot)))))

  const clean = title.replace(/\s+/g, ' ').trim()
  const slug = profileNameFrom(clean)
  const taken = useMemo(() => new Set([...bots.map((bot) => bot.slug), ...(known?.taken ?? [])]), [bots, known])
  const issue = !clean ? null : profileNameIssue(slug, { taken, removed: known?.removed ?? new Set() })
  const color = BOT_COLORS.find((entry) => entry.id === colorId)!.value

  const pickFile = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    setError('')
    try {
      const parsed = await validateBotTemplate(file)
      setImported(parsed)
      setPreviewSoul(parsed.soul.slice(0, 240))
      const enabled = (parsed.configBody?.config?.toolsets as { enabled?: string[] } | undefined)?.enabled || []
      setToolsets(enabled.join(', '))
      const suggested = parsed.suggestedTitle || file.name.replace(/\.json$/i, '')
      setTitle(suggested)
      if (typeof parsed.card?.color === 'string') {
        const match = BOT_COLORS.find((entry) => entry.value.toLowerCase() === String(parsed.card?.color).toLowerCase())
        if (match) setColorId(match.id)
      }
      if (typeof parsed.card?.shape === 'string' && BOT_SHAPES.includes(canonicalShape(String(parsed.card.shape)) as typeof BOT_SHAPES[number])) {
        setShape(canonicalShape(String(parsed.card.shape)) as typeof BOT_SHAPES[number])
      }
      if (client) void loadProfileNames(client).then(setKnown).catch(() => undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const create = async (event: FormEvent) => {
    event.preventDefault()
    if (!client || !connected || !imported || issue || !clean) return
    if (!window.confirm(t('botImport.confirmCreate', { name: clean }))) return
    setBusy(true)
    setError('')
    try {
      const draft: BotDraft = { title: clean, slug, color, shape }
      await createBotFromTemplate(client, draft, {
        soul: imported.soul,
        configBody: imported.configBody,
        card: imported.card,
      })
      await onCreated(draft)
      onClose()
    } catch (cause) {
      setError(cause instanceof BotCreateError ? botCreateErrorText(cause, slug) : String(cause))
      setBusy(false)
    }
  }

  const previewBot = createdBotEntry({ title: clean || t('botImport.title'), slug: slug || 'new-bot', color, shape })
  const hintId = useId()

  return (
    <BotSheet title={t('botImport.title')} icon={<Upload size={18} />} busy={busy} onCancel={onClose} onSubmit={create}>
      <p className="settings-hint">{t('botImport.hint')}</p>
      <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(event) => void pickFile(event.target.files?.[0])} />
      <button type="button" className="secondary" disabled={busy} onClick={() => fileRef.current?.click()}>{t('botImport.chooseFile')}</button>
      {imported && (
        <>
          <pre className="bot-edit-diff bot-import-preview" aria-label={t('botImport.preview')}>{previewSoul}{previewSoul.length < imported.soul.length ? '…' : ''}</pre>
          {toolsets && <p className="settings-hint">{t('botImport.toolsets', { list: toolsets })}</p>}
          <label>
            <strong>{t('newBot.nameLabel')}</strong>
            <input value={title} maxLength={PROFILE_NAME_MAX} aria-invalid={Boolean(issue)} aria-describedby={hintId} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <p id={hintId} className={`new-bot-hint${issue ? ' is-issue' : ''}`}>{issue ? t(`newBot.issues.${issue}`, { slug }) : slug ? t('newBot.profileHint', { slug }) : ' '}</p>
          <div className="new-bot-preview">
            <BotAvatar bot={previewBot} size={48} />
            <div className="new-bot-colors" role="radiogroup" aria-label={t('newBot.color')}>
              {BOT_COLORS.map((entry) => (
                <button key={entry.id} type="button" role="radio" aria-checked={colorId === entry.id} onClick={() => setColorId(entry.id)}>
                  <span className="new-bot-swatch" style={{ background: entry.value }} />
                </button>
              ))}
            </div>
            <div className="new-bot-shapes" role="radiogroup" aria-label={t('newBot.shape')}>
              {BOT_SHAPES.map((entry) => (
                <button key={entry} type="button" role="radio" aria-checked={shape === entry} onClick={() => setShape(entry)}>
                  <BotAvatar bot={{ ...previewBot, avatar: { shape: entry, color } }} size={26} />
                </button>
              ))}
            </div>
          </div>
        </>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      {!connected && <p className="form-error">{t('newBot.offline')}</p>}
      <p className="settings-hint">{imported ? t('botImport.createHint') : t('botImport.fileHint')}</p>
      {imported && (
        <div className="request-actions">
          <button type="button" onClick={onClose} disabled={busy}>{t('newBot.cancel')}</button>
          <button type="submit" className="is-primary" disabled={busy || !clean || Boolean(issue) || !connected}>{busy ? t('newBot.creating') : t('botImport.create')}</button>
        </div>
      )}
    </BotSheet>
  )
}