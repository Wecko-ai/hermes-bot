import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SquarePen } from 'lucide-react'
import { BotSheet } from './BotDialogs'
import type { Bot } from '../types'
import type { HermesClient } from '../lib/hermes'
import { downloadTemplate, exportBotTemplate, loadBotProfile, previewBotProfile, saveBotProfile, saveBotAvatar } from '../lib/bot-profile'
import { BOT_COLORS, BOT_SHAPES, canonicalShape } from '../lib/bot-create'
import { BotAvatar, avatarShape } from './BotAvatar'

interface BotEditDialogProps {
  bot: Bot
  client: HermesClient | null
  onClose: () => void
  onSaved: () => void
  onNotice: (message: string) => void
}

export function BotEditDialog({ bot, client, onClose, onSaved, onNotice }: BotEditDialogProps) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [soul, setSoul] = useState('')
  const [previousSoul, setPreviousSoul] = useState('')
  const [toolsets, setToolsets] = useState('')
  const [modelLabel, setModelLabel] = useState('')
  const [diff, setDiff] = useState<Array<{ kind: string; text: string }>>([])
  const [showDiff, setShowDiff] = useState(false)
  const [color, setColor] = useState(bot.avatar?.color || BOT_COLORS[0].value)
  const [shape, setShape] = useState(() => canonicalShape(avatarShape(bot)) as typeof BOT_SHAPES[number])

  useEffect(() => {
    void loadBotProfile(bot.slug).then((body) => {
      setSoul(body.soul || '')
      setPreviousSoul(body.soul || '')
      setToolsets(body.toolsets.enabled.join(', '))
      setModelLabel(body.model.label || body.model.default || '')
    }).catch((error) => onNotice(error instanceof Error ? error.message : String(error)))
  }, [bot.slug, onNotice])

  const buildToolsets = () => {
    const enabled = toolsets.split(/[,\n]/).map((item) => item.trim()).filter(Boolean)
    return { enabled, disabled: [] as string[] }
  }

  const preview = async () => {
    setBusy(true)
    try {
      const body = await previewBotProfile(bot.slug, { soul, previousSoul, toolsets: buildToolsets() })
      setDiff(body.preview.soul)
      setShowDiff(true)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    setBusy(true)
    try {
      await saveBotProfile(bot.slug, { soul, previousSoul, toolsets: buildToolsets() }, true)
      if (client) await saveBotAvatar(client, bot, { color, shape })
      onSaved()
      onClose()
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const doExport = async () => {
    try {
      const data = await exportBotTemplate(bot.slug)
      downloadTemplate(`${bot.slug}-template.json`, data)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <BotSheet title={t('botEdit.title', { name: bot.name })} icon={<SquarePen size={18} />} busy={busy} onCancel={onClose} onSubmit={(event) => { event.preventDefault(); void (showDiff ? save() : preview()) }}>
      <p className="settings-hint">{t('botEdit.hint')}</p>
      <label>
        <strong>{t('botEdit.model')}</strong>
        <input value={modelLabel} readOnly />
      </label>
      <div className="bot-edit-look" aria-label={t('botEdit.look')}>
        <div className="new-bot-colors" role="radiogroup" aria-label={t('newBot.color')}>
          {BOT_COLORS.map((entry) => (
            <button key={entry.id} type="button" role="radio" aria-checked={color === entry.value} onClick={() => setColor(entry.value)}>
              <span className="new-bot-swatch" style={{ background: entry.value }} />
            </button>
          ))}
        </div>
        <div className="new-bot-shapes" role="radiogroup" aria-label={t('newBot.shape')}>
          {BOT_SHAPES.map((entry) => (
            <button key={entry} type="button" role="radio" aria-checked={shape === entry} onClick={() => setShape(entry)}>
              <BotAvatar bot={{ ...bot, avatar: { color, shape: entry } }} size={26} />
            </button>
          ))}
        </div>
      </div>
      <label>
        <strong>{t('botEdit.toolsets')}</strong>
        <input value={toolsets} onChange={(event) => setToolsets(event.target.value)} placeholder={t('botEdit.toolsetsPlaceholder')} />
      </label>
      <label>
        <strong>{t('botEdit.soul')}</strong>
        <textarea value={soul} onChange={(event) => setSoul(event.target.value)} rows={12} />
      </label>
      {showDiff && (
        <pre className="bot-edit-diff" aria-label={t('botEdit.diff')}>
          {diff.map((line, index) => (
            <div key={index} className={line.kind === 'add' ? 'diff-add' : line.kind === 'remove' ? 'diff-remove' : ''}>{line.text || ' '}</div>
          ))}
        </pre>
      )}
      <div className="bot-edit-actions">
        <button type="button" disabled={busy} onClick={() => void doExport()}>{t('botEdit.export')}</button>
        <button type="button" disabled={busy} onClick={() => setShowDiff(false)}>{t('botEdit.back')}</button>
      </div>
      <p className="settings-hint">{showDiff ? t('botEdit.confirmHint') : t('botEdit.previewHint')}</p>
    </BotSheet>
  )
}