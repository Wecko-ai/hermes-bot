import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, useSyncExternalStore, type Ref } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUp, ChevronDown, FileText, Film, Gauge, Mic, MicOff, Music, Pause, Plus, X } from 'lucide-react'
import type { Bot, SessionUsage } from '../types'
import { formatUsage } from '../lib/model'
import { defaultPrompt, filterAttachments, formatBytes, toAttachment, type PendingAttachment } from '../lib/attachments'
import { mentionOptions, mentionTokenAt, type MentionOption, type MentionToken } from '../lib/mentions'
import { CHAT_MODES, loadModes, modePlaceholder, saveModes, type ChatMode } from '../lib/modes'
import { DELIVERY_MODES, deliveryPlaceholder, loadDraft, saveDraft, type DeliveryMode } from '../lib/delivery'
import { useSettings } from '../lib/settings'
import { i18n } from '../i18n'
import { DictationController, type DictationSnapshot } from '../lib/dictation'
import { createDictationEngine } from '../lib/dictation-engines'
import { BotAvatar } from './BotAvatar'
import { DictationPill } from './DictationPill'

export interface ComposerHandle {
  addFiles: (files: File[]) => void
  focus: () => void
  /** Quotes a passage of the thread at the start of the draft. */
  quote: (text: string) => void
}

interface ComposerProps {
  ref?: Ref<ComposerHandle>
  /** Local chat: text only, no files, no modes, no model picker. */
  minimal?: boolean
  bot: Bot
  bots: Bot[]
  running: boolean
  disabled: boolean
  focusSignal: number
  /** `false`: nothing was sent, the draft and its files come back into the composer. `delivery`: only during a turn. */
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

const IDLE_DICTATION: DictationSnapshot = { phase: 'idle', blocked: null, listeningSince: null }
const noSubscription = () => () => {}
const getIdleDictation = () => IDLE_DICTATION
// The visual demo (`?demo=1`) dictates a scripted sentence: no microphone.
const DEMO = new URLSearchParams(location.search).get('demo') === '1'

const releasePreviews = (attachments: PendingAttachment[]) => attachments.forEach((item) => { if (item.previewUrl) URL.revokeObjectURL(item.previewUrl) })

export function Composer({ ref, minimal = false, bot, bots, running, disabled, focusSignal, onSend, onStop, onNotice, modelLabel, onOpenModels, usage, showUsage, onToggleUsage }: ComposerProps) {
  const { t } = useTranslation()
  const { sendKey } = useSettings()
  const [text, setText] = useState(() => loadDraft(bot.slug))
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [mention, setMention] = useState<MentionToken | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [modes, setModes] = useState(loadModes)
  const mode = modes[bot.slug] ?? 'exec'
  // During a turn: Wait by default. Goes back to Wait after every send and at the end of every turn.
  const [delivery, setDelivery] = useState<DeliveryMode>('wait')
  // Enter in Wait mode: nothing is sent, the selector flags itself (a toast would cover it).
  const [nudge, setNudge] = useState(0)
  const busy = running && !minimal
  const chooseMode = (next: ChatMode) => {
    const updated = { ...modes, [bot.slug]: next }
    setModes(updated)
    saveModes(updated)
  }
  // Each bot keeps its own draft and files: switching bots never sends anything to the wrong recipient.
  const draftsRef = useRef(new Map<string, Draft>())
  const botRef = useRef(bot.slug)
  const attachmentCountRef = useRef(0)
  attachmentCountRef.current = attachments.length
  // The field as it is now: the dictation reads it when it starts and writes the transcript into it.
  const textRef = useRef(text)
  textRef.current = text
  const noticeRef = useRef(onNotice)
  noticeRef.current = onNotice
  const sendingDictatedRef = useRef(false)
  // One controller for the composer's life; `null`: nothing can dictate here, so no mic button.
  const dictationRef = useRef<DictationController | null | undefined>(undefined)
  if (dictationRef.current === undefined) {
    const engine = createDictationEngine({ demo: DEMO, language: i18n.language === 'fr' ? 'fr' : 'en', languageCode: () => (i18n.language === 'fr' ? 'fr' : 'en') })
    dictationRef.current = engine && new DictationController({
      engine,
      languageCode: () => (i18n.language === 'fr' ? 'fr' : 'en'),
      getText: () => textRef.current,
      setText: (next) => { textRef.current = next; setText(next) },
      isOffline: () => !navigator.onLine,
      onNotice: (notice) => noticeRef.current(i18n.t(`dictation.notice.${notice}`)),
    })
  }
  const dictation = dictationRef.current
  const dictationState = useSyncExternalStore(dictation?.subscribe ?? noSubscription, dictation?.getSnapshot ?? getIdleDictation)
  const dictating = dictationState.phase !== 'idle'
  const dictationBlocked = dictationState.blocked !== null

  const options = mention ? mentionOptions(mention.query, bots, bot.slug) : []
  const menuOpen = options.length > 0
  const activeOption = Math.min(mentionIndex, Math.max(0, options.length - 1))

  // A focus asked while the field is disabled (the conversation is still loading) waits for it to be enabled.
  const focusWantedRef = useRef(false)
  useEffect(() => {
    if (focusSignal > 0) focusWantedRef.current = true
  }, [focusSignal])
  useEffect(() => {
    if (!focusWantedRef.current || disabled) return
    focusWantedRef.current = false
    textareaRef.current?.focus()
  }, [focusSignal, disabled])

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = '0px'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`
  }, [text])

  // The microphone is given back when the composer goes away.
  useEffect(() => () => dictation?.cancel(), [dictation])

  // The caret follows the transcript: at the end, in view, ready to edit once the dictation stops.
  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!dictating || !textarea) return
    textarea.setSelectionRange(text.length, text.length)
    textarea.scrollTop = textarea.scrollHeight
  }, [text, dictating])

  // The window leaves the screen: the microphone stops, the text stays. Back in front: a refusal may have been
  // lifted in System Settings, the next click tries again.
  useEffect(() => {
    if (!dictation) return
    const onVisibility = () => {
      if (document.hidden) void dictation.stop()
      else dictation.recheckAccess()
    }
    const onFocus = () => dictation.recheckAccess()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onFocus)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onFocus)
    }
  }, [dictation])

  // A turn of this bot starts another way (queued message, another window): the dictation ends, the text stays.
  useEffect(() => {
    if (running) void dictation?.stop()
  }, [running, dictation])

  // Before paint: the field never shows, even for an instant, the previous bot’s draft.
  useLayoutEffect(() => {
    if (botRef.current === bot.slug) return
    // A dictation never survives in another bot's field: what is written goes to the draft below.
    dictation?.cancel()
    if (text || attachments.length) draftsRef.current.set(botRef.current, { text, attachments })
    const draft = draftsRef.current.get(bot.slug)
    draftsRef.current.delete(bot.slug)
    botRef.current = bot.slug
    setText(draft?.text ?? loadDraft(bot.slug))
    setAttachments(draft?.attachments ?? [])
    setMention(null)
    setDelivery('wait')
  }, [bot.slug])

  // After the bot switch above: the draft is always saved under the bot on screen.
  useEffect(() => { saveDraft(botRef.current, text) }, [text])

  useEffect(() => {
    if (!running) setDelivery('wait')
  }, [running])

  const addFiles = (files: File[]) => {
    if (!files.length) return
    const { accepted, refused } = filterAttachments(files, attachmentCountRef.current)
    if (refused.length) onNotice(t('composer.notAdded', { files: refused.join(', ') }))
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

  /** Stop (button or Escape): the text stays in the field, the caret at its end, ready to edit. */
  const stopDictation = () => {
    if (!dictation) return
    void dictation.stop().then(() => requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea || dictation.active) return
      textarea.focus()
      textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    }))
  }
  useEffect(() => {
    if (!dictating) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      stopDictation()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const submit = async () => {
    // Send while dictating: stop, wait briefly for the final words, then send the field once.
    if (dictation?.active) {
      if (sendingDictatedRef.current) return
      sendingDictatedRef.current = true
      const target = bot.slug
      try { await dictation.finish() } finally { sendingDictatedRef.current = false }
      if (botRef.current !== target) return
    }
    const text = textRef.current
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

  return (
    <div className="composer-wrap">
      {menuOpen && (
        <div className="mention-menu" id="mention-menu" role="listbox" aria-label={t('composer.mentionMenu')}>
          {options.map((option, index) => (
            <button
              type="button"
              key={option.bot.slug}
              id={`mention-${option.bot.slug}`}
              role="option"
              aria-selected={index === activeOption}
              className={index === activeOption ? 'is-active' : ''}
              onMouseEnter={() => setMentionIndex(index)}
              // Before the field’s blur: otherwise the menu closes under the click.
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
              <button aria-label={t('composer.remove', { name: attachment.name })} onClick={() => removeAttachment(attachment)}><X size={12} /></button>
            </div>
          ) : (
            <div className="composer-file" key={attachment.id} title={attachment.name}>
              <FileIcon name={attachment.name} />
              <span><strong>{attachment.name}</strong><small>{formatBytes(attachment.size)}</small></span>
              <button aria-label={t('composer.remove', { name: attachment.name })} onClick={() => removeAttachment(attachment)}><X size={12} /></button>
            </div>
          ))}
        </div>
      )}
      <div className={`composer ${dictating ? 'is-dictating' : ''}`}>
        {!minimal && <input ref={fileRef} className="visually-hidden" type="file" multiple aria-label={t('composer.chooseFiles')} onChange={(event) => { addFiles(Array.from(event.target.files || [])); event.target.value = '' }} />}
        {!minimal && <button type="button" className="composer-plus" aria-label={t('composer.addFiles')} disabled={disabled} onClick={() => fileRef.current?.click()}><Plus size={19} /></button>}
        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          disabled={disabled}
          readOnly={dictating}
          placeholder={dictating ? t('dictation.placeholder') : busy ? deliveryPlaceholder(delivery, bot.name) : running ? t('modes.placeholder.exec', { name: bot.name }) : modePlaceholder(mode, bot.name)}
          aria-label={t('composer.messageTo', { name: bot.name })}
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
        {dictation && !running && !dictating && (
          <button type="button" className={`composer-mic ${dictationBlocked ? 'is-blocked' : ''}`} aria-label={dictationBlocked ? t('composer.dictateBlocked') : t('composer.dictate')} aria-disabled={dictationBlocked || undefined} disabled={disabled} onClick={() => void dictation.start()}>
            {dictationBlocked ? <MicOff size={17} /> : <Mic size={17} />}
          </button>
        )}
        {dictation && dictating && <DictationPill controller={dictation} onStop={stopDictation} />}
        {running && <button type="button" className="composer-send is-stop" aria-label={t('composer.stopBot')} onClick={onStop}><Pause size={14} fill="currentColor" /></button>}
        {(!running || (text.trim() && busy && delivery !== 'wait')) && <button type="button" className={`composer-send ${busy && delivery === 'priority' ? 'is-priority' : ''}`} aria-label={busy ? (delivery === 'priority' ? t('composer.sendPriority') : t('composer.sendQueue')) : t('composer.send')} disabled={disabled || dictationState.phase === 'finishing' || (!text.trim() && attachments.length === 0)} onClick={() => void submit()}><ArrowUp size={18} /></button>}
      </div>
      <div className="composer-hint">
        {!minimal && (
          <div className="mode-switch" role="radiogroup" aria-label={t('composer.modeGroup')}>
            {CHAT_MODES.map((item) => (
              <button type="button" key={item.id} role="radio" aria-checked={mode === item.id} title={item.title} className={`mode-${item.id} ${mode === item.id ? 'is-active' : ''}`} onClick={() => chooseMode(item.id)}>
                <i aria-hidden="true" />{item.label}
              </button>
            ))}
          </div>
        )}
        {busy && (
          <div key={nudge} className={`delivery-switch ${nudge ? 'is-nudged' : ''}`} role="radiogroup" aria-label={t('composer.deliveryGroup')}>
            {DELIVERY_MODES.map((item) => (
              <button type="button" key={item.id} role="radio" aria-checked={delivery === item.id} title={item.title} className={`delivery-${item.id} ${delivery === item.id ? 'is-active' : ''}`} onClick={() => { setDelivery(item.id); textareaRef.current?.focus() }}>
                {item.label}
              </button>
            ))}
          </div>
        )}
        {busy && <span className="composer-hint-keys" aria-live="polite">{delivery === 'wait' ? t('composer.hintWait') : delivery === 'queue' ? t('composer.hintQueue', { name: bot.name }) : t('composer.hintPriority', { name: bot.name })}</span>}
        {!minimal && <div className="composer-status">
          {showUsage && <span className="usage-readout">{formatUsage(usage)}</span>}
          <button type="button" className={`usage-toggle ${showUsage ? 'is-active' : ''}`} aria-label={t('composer.usageToggle')} aria-pressed={showUsage} onClick={onToggleUsage}><Gauge size={15} /></button>
          <button type="button" className="model-chip" aria-label={t('composer.chooseModel')} onClick={() => onOpenModels('')}>{modelLabel}<ChevronDown size={13} /></button>
        </div>}
      </div>
    </div>
  )
}
