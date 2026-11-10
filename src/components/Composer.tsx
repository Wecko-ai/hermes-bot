import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from 'react'
import { ArrowUp, ChevronDown, FileText, Film, Gauge, Mic, Music, Plus, Square, X } from 'lucide-react'
import type { Bot, SessionUsage } from '../types'
import { formatUsage } from '../lib/model'
import { defaultPrompt, filterAttachments, formatBytes, toAttachment, type PendingAttachment } from '../lib/attachments'
import { mentionOptions, mentionTokenAt, type MentionOption, type MentionToken } from '../lib/mentions'
import { CHAT_MODES, loadModes, modePlaceholder, saveModes, type ChatMode } from '../lib/modes'
import { DELIVERY_MODES, deliveryPlaceholder, loadDraft, saveDraft, type DeliveryMode } from '../lib/delivery'
import { useSettings } from '../lib/settings'
import { BotAvatar } from './BotAvatar'

export interface ComposerHandle {
  addFiles: (files: File[]) => void
  focus: () => void
  /** Cite un passage du fil au début du brouillon. */
  quote: (text: string) => void
}

interface ComposerProps {
  ref?: Ref<ComposerHandle>
  /** Chat local : du texte seulement, ni fichiers, ni modes, ni choix du modèle. */
  minimal?: boolean
  bot: Bot
  bots: Bot[]
  running: boolean
  disabled: boolean
  focusSignal: number
  /** `false` : rien n’est parti, le brouillon et ses fichiers reviennent dans le composer. `delivery` : seulement pendant un tour. */
  onSend: (text: string, attachments: PendingAttachment[], mode: ChatMode, delivery?: DeliveryMode) => Promise<boolean> | boolean | void
  onStop: () => void
  onNotice: (text: string) => void
  modelLabel: string
  onOpenModels: (query: string) => void
  usage: SessionUsage | null
  showUsage: boolean
  onToggleUsage: () => void
}

interface Draft {
  text: string
  attachments: PendingAttachment[]
}

function FileIcon({ name }: { name: string }) {
  if (/\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(name)) return <Film size={15} />
  if (/\.(mp3|m4a|wav|ogg|opus|flac|aac)$/i.test(name)) return <Music size={15} />
  return <FileText size={15} />
}

const releasePreviews = (attachments: PendingAttachment[]) => attachments.forEach((item) => { if (item.previewUrl) URL.revokeObjectURL(item.previewUrl) })

export function Composer({ ref, minimal = false, bot, bots, running, disabled, focusSignal, onSend, onStop, onNotice, modelLabel, onOpenModels, usage, showUsage, onToggleUsage }: ComposerProps) {
  const { sendKey } = useSettings()
  const [text, setText] = useState(() => loadDraft(bot.slug))
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const recognitionRef = useRef<any>(null)
  const [listening, setListening] = useState(false)
  const [mention, setMention] = useState<MentionToken | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [modes, setModes] = useState(loadModes)
  const mode = modes[bot.slug] ?? 'exec'
  // Pendant un tour : Attendre par défaut. Revient à Attendre après chaque envoi et à chaque fin de tour.
  const [delivery, setDelivery] = useState<DeliveryMode>('wait')
  // Entrée en mode Attendre : rien ne part, le sélecteur se signale (un toast le couvrirait).
  const [nudge, setNudge] = useState(0)
  const busy = running && !minimal
  const chooseMode = (next: ChatMode) => {
    const updated = { ...modes, [bot.slug]: next }
    setModes(updated)
    saveModes(updated)
  }
  // Chaque bot garde son brouillon et ses fichiers : changer de bot n’envoie rien au mauvais destinataire.
  const draftsRef = useRef(new Map<string, Draft>())
  const botRef = useRef(bot.slug)
  const attachmentCountRef = useRef(0)
  attachmentCountRef.current = attachments.length

  const options = mention ? mentionOptions(mention.query, bots, bot.slug) : []
  const menuOpen = options.length > 0
  const activeOption = Math.min(mentionIndex, Math.max(0, options.length - 1))

  useEffect(() => {
    if (focusSignal > 0) textareaRef.current?.focus()
  }, [focusSignal])

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = '0px'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`
  }, [text])

  useEffect(() => () => recognitionRef.current?.stop?.(), [])

  // Avant l’affichage : le champ ne montre jamais, même un instant, le brouillon du bot précédent.
  useLayoutEffect(() => {
    if (botRef.current === bot.slug) return
    if (text || attachments.length) draftsRef.current.set(botRef.current, { text, attachments })
    const draft = draftsRef.current.get(bot.slug)
    draftsRef.current.delete(bot.slug)
    botRef.current = bot.slug
    setText(draft?.text ?? loadDraft(bot.slug))
    setAttachments(draft?.attachments ?? [])
    setMention(null)
    setDelivery('wait')
  }, [bot.slug])

  // Après le changement de bot ci-dessus : le brouillon s’écrit toujours sous le bot affiché.
  useEffect(() => { saveDraft(botRef.current, text) }, [text])

  useEffect(() => {
    if (!running) setDelivery('wait')
  }, [running])

  const addFiles = (files: File[]) => {
    if (!files.length) return
    const { accepted, refused } = filterAttachments(files, attachmentCountRef.current)
    if (refused.length) onNotice(`Non ajouté : ${refused.join(', ')}.`)
    if (accepted.length) setAttachments((current) => [...current, ...accepted.map(toAttachment)])
    textareaRef.current?.focus()
  }
  useImperativeHandle(ref, () => ({
    addFiles,
    focus: () => textareaRef.current?.focus(),
    quote: (quoted) => {
      const block = quoted.trim().split('\n').map((line) => `> ${line}`).join('\n')
      setText((current) => `${current ? `${current.trimEnd()}\n\n` : ''}${block}\n\n`)
      textareaRef.current?.focus()
    },
  }))

  const removeAttachment = (attachment: PendingAttachment) => {
    releasePreviews([attachment])
    setAttachments((current) => current.filter((item) => item.id !== attachment.id))
  }

  const submit = async () => {
    const command = text.trim().match(/^\/model(?:\s+(.*))?$/i)
    if (command) {
      setText('')
      onOpenModels(command[1] || '')
      return
    }
    if ((!text.trim() && attachments.length === 0) || disabled) return
    if (busy && delivery === 'wait') {
      setNudge((value) => value + 1)
      return
    }
    const draft: Draft = { text, attachments }
    const target = bot.slug
    const sentDelivery = busy ? delivery : undefined
    setText('')
    setAttachments([])
    setMention(null)
    setDelivery('wait')
    requestAnimationFrame(() => textareaRef.current?.focus())
    const sent = await onSend(text.trim() || defaultPrompt(attachments), attachments, mode, sentDelivery)
    if (sent !== false) {
      releasePreviews(draft.attachments)
      return
    }
    if (botRef.current !== target) {
      draftsRef.current.set(target, draft)
      saveDraft(target, draft.text)
      return
    }
    setText((current) => current || draft.text)
    setAttachments((current) => [...draft.attachments, ...current])
  }

  const refreshMention = (element: HTMLTextAreaElement) => {
    const next = mentionTokenAt(element.value, element.selectionStart ?? element.value.length)
    setMention(next)
    if (next?.query !== mention?.query) setMentionIndex(0)
  }

  const insertMention = (option: MentionOption) => {
    const element = textareaRef.current
    if (!element || !mention) return
    const caret = element.selectionStart ?? text.length
    const inserted = `@${option.tag} `
    setText(`${text.slice(0, mention.start)}${inserted}${text.slice(caret)}`)
    setMention(null)
    const position = mention.start + inserted.length
    requestAnimationFrame(() => {
      element.focus()
      element.setSelectionRange(position, position)
    })
  }

  const dictate = () => {
    if (listening) {
      recognitionRef.current?.stop()
      return
    }
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SpeechRecognition) return
    const recognition = new SpeechRecognition()
    recognition.lang = 'fr-FR'
    recognition.continuous = true
    recognition.interimResults = true
    recognition.onresult = (event: any) => {
      let transcript = ''
      for (let index = event.resultIndex; index < event.results.length; index += 1) transcript += event.results[index][0].transcript
      if (transcript) setText((current) => `${current}${current && !current.endsWith(' ') ? ' ' : ''}${transcript}`)
    }
    recognition.onend = () => setListening(false)
    recognition.onerror = () => setListening(false)
    recognitionRef.current = recognition
    recognition.start()
    setListening(true)
  }

  const speechAvailable = Boolean((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)

  return (
    <div className="composer-wrap">
      {menuOpen && (
        <div className="mention-menu" id="mention-menu" role="listbox" aria-label="Bots à mentionner">
          {options.map((option, index) => (
            <button
              type="button"
              key={option.bot.slug}
              id={`mention-${option.bot.slug}`}
              role="option"
              aria-selected={index === activeOption}
              className={index === activeOption ? 'is-active' : ''}
              onMouseEnter={() => setMentionIndex(index)}
              // Avant le blur du champ : sinon le menu se ferme sous le clic.
              onMouseDown={(event) => { event.preventDefault(); insertMention(option) }}
            >
              <BotAvatar bot={option.bot} size={24} />
              <strong>{option.bot.name}</strong>
              <span>@{option.tag}</span>
            </button>
          ))}
        </div>
      )}
      {attachments.length > 0 && (
        <div className="composer-images">
          {attachments.map((attachment) => attachment.previewUrl ? (
            <div className="composer-image" key={attachment.id} title={attachment.name}>
              <img src={attachment.previewUrl} alt={attachment.name} />
              <button aria-label={`Retirer ${attachment.name}`} onClick={() => removeAttachment(attachment)}><X size={12} /></button>
            </div>
          ) : (
            <div className="composer-file" key={attachment.id} title={attachment.name}>
              <FileIcon name={attachment.name} />
              <span><strong>{attachment.name}</strong><small>{formatBytes(attachment.size)}</small></span>
              <button aria-label={`Retirer ${attachment.name}`} onClick={() => removeAttachment(attachment)}><X size={12} /></button>
            </div>
          ))}
        </div>
      )}
      <div className={`composer ${listening ? 'is-listening' : ''}`}>
        {!minimal && <input ref={fileRef} className="visually-hidden" type="file" multiple aria-label="Choisir des fichiers" onChange={(event) => { addFiles(Array.from(event.target.files || [])); event.target.value = '' }} />}
        {!minimal && <button type="button" className="composer-plus" aria-label="Ajouter des fichiers" disabled={disabled} onClick={() => fileRef.current?.click()}><Plus size={19} /></button>}
        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={busy ? deliveryPlaceholder(delivery, bot.name) : running ? `Message ${bot.name}` : modePlaceholder(mode, bot.name)}
          aria-label={`Message à ${bot.name}`}
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? 'mention-menu' : undefined}
          aria-activedescendant={menuOpen ? `mention-${options[activeOption].bot.slug}` : undefined}
          onChange={(event) => { setText(event.target.value); refreshMention(event.target) }}
          onSelect={(event) => refreshMention(event.currentTarget)}
          onBlur={() => setMention(null)}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files)
            if (minimal || !files.length) return
            event.preventDefault()
            addFiles(files)
          }}
          onKeyDown={(event) => {
            if (menuOpen && !event.nativeEvent.isComposing) {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                const step = event.key === 'ArrowDown' ? 1 : -1
                setMentionIndex((activeOption + step + options.length) % options.length)
                return
              }
              if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault()
                insertMention(options[activeOption])
                return
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                setMention(null)
                return
              }
            }
            const sends = sendKey === 'enter' ? !event.shiftKey : event.metaKey
            if (event.key === 'Enter' && sends && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void submit()
            }
          }}
        />
        {speechAvailable && !running && <button type="button" className={`composer-mic ${listening ? 'is-active' : ''}`} aria-label={listening ? 'Arrêter la dictée' : 'Dicter'} onClick={dictate}><Mic size={17} /></button>}
        {running && <button type="button" className="composer-send is-stop" aria-label="Arrêter le bot" onClick={onStop}><Square size={13} fill="currentColor" /></button>}
        {(!running || (text.trim() && busy && delivery !== 'wait')) && <button type="button" className={`composer-send ${busy && delivery === 'priority' ? 'is-priority' : ''}`} aria-label={busy ? (delivery === 'priority' ? 'Envoyer en priorité' : 'Mettre en file') : 'Envoyer'} disabled={disabled || (!text.trim() && attachments.length === 0)} onClick={() => void submit()}><ArrowUp size={18} /></button>}
      </div>
      <div className="composer-hint">
        {!minimal && (
          <div className="mode-switch" role="radiogroup" aria-label="Mode de travail">
            {CHAT_MODES.map((item) => (
              <button type="button" key={item.id} role="radio" aria-checked={mode === item.id} title={item.title} className={`mode-${item.id} ${mode === item.id ? 'is-active' : ''}`} onClick={() => chooseMode(item.id)}>
                <i aria-hidden="true" />{item.label}
              </button>
            ))}
          </div>
        )}
        {busy && (
          <div key={nudge} className={`delivery-switch ${nudge ? 'is-nudged' : ''}`} role="radiogroup" aria-label="Envoi pendant le travail">
            {DELIVERY_MODES.map((item) => (
              <button type="button" key={item.id} role="radio" aria-checked={delivery === item.id} title={item.title} className={`delivery-${item.id} ${delivery === item.id ? 'is-active' : ''}`} onClick={() => { setDelivery(item.id); textareaRef.current?.focus() }}>
                {item.label}
              </button>
            ))}
          </div>
        )}
        {busy && <span className="composer-hint-keys" aria-live="polite">{delivery === 'wait' ? `Brouillon gardé jusqu’à la fin du tour · File ou Prio pour l’envoyer maintenant` : delivery === 'queue' ? `Part quand ${bot.name} a fini` : `${bot.name} s’interrompt, lit, puis reprend`}</span>}
        {!busy && <span className="composer-hint-keys">{sendKey === 'enter' ? 'Entrée pour envoyer · Maj + Entrée pour une nouvelle ligne' : '⌘ Entrée pour envoyer · Entrée pour une nouvelle ligne'}{minimal ? '' : ' · @ pour citer un bot · /model'}</span>}
        {!minimal && <div className="composer-status">
          {showUsage && <span className="usage-readout">{formatUsage(usage)}</span>}
          <button type="button" className={`usage-toggle ${showUsage ? 'is-active' : ''}`} aria-label="Afficher le contexte et le débit" aria-pressed={showUsage} onClick={onToggleUsage}><Gauge size={13} /></button>
          <button type="button" className="model-chip" aria-label="Choisir le modèle" onClick={() => onOpenModels('')}>{modelLabel}<ChevronDown size={11} /></button>
        </div>}
      </div>
    </div>
  )
}
