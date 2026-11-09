import { useEffect, useRef, useState } from 'react'
import { ArrowUp, ChevronDown, Gauge, Mic, Plus, Square, X } from 'lucide-react'
import type { Bot, SessionUsage } from '../types'
import { formatUsage } from '../lib/model'

export interface PendingImage {
  id: string
  name: string
  dataUrl: string
}

interface ComposerProps {
  bot: Bot
  running: boolean
  disabled: boolean
  focusSignal: number
  onSend: (text: string, images: PendingImage[]) => void
  onStop: () => void
  modelLabel: string
  onOpenModels: (query: string) => void
  usage: SessionUsage | null
  showUsage: boolean
  onToggleUsage: () => void
}

export function Composer({ bot, running, disabled, focusSignal, onSend, onStop, modelLabel, onOpenModels, usage, showUsage, onToggleUsage }: ComposerProps) {
  const [text, setText] = useState('')
  const [images, setImages] = useState<PendingImage[]>([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const recognitionRef = useRef<any>(null)
  const [listening, setListening] = useState(false)

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

  const submit = () => {
    const command = text.trim().match(/^\/model(?:\s+(.*))?$/i)
    if (command) {
      setText('')
      onOpenModels(command[1] || '')
      return
    }
    if ((!text.trim() && images.length === 0) || disabled || running) return
    onSend(text.trim() || 'Analyse cette image.', images)
    setText('')
    setImages([])
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const chooseImages = async (files: FileList | null) => {
    if (!files) return
    const selected = Array.from(files).filter((file) => /^image\/(png|jpeg|gif|webp)$/.test(file.type) && file.size <= 16 * 1024 * 1024).slice(0, 10 - images.length)
    const loaded = await Promise.all(selected.map((file) => new Promise<PendingImage>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve({ id: crypto.randomUUID(), name: file.name, dataUrl: String(reader.result) })
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(file)
    })))
    setImages((current) => [...current, ...loaded])
    if (fileRef.current) fileRef.current.value = ''
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
      {images.length > 0 && (
        <div className="composer-images">
          {images.map((image) => (
            <div className="composer-image" key={image.id}>
              <img src={image.dataUrl} alt={image.name} />
              <button aria-label={`Retirer ${image.name}`} onClick={() => setImages((current) => current.filter((item) => item.id !== image.id))}><X size={12} /></button>
            </div>
          ))}
        </div>
      )}
      <div className={`composer ${listening ? 'is-listening' : ''}`}>
        <input ref={fileRef} className="visually-hidden" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple onChange={(event) => chooseImages(event.target.files)} />
        <button type="button" className="composer-plus" aria-label="Ajouter des images" disabled={disabled} onClick={() => fileRef.current?.click()}><Plus size={19} /></button>
        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={`Message ${bot.name}`}
          aria-label={`Message à ${bot.name}`}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              submit()
            }
          }}
        />
        {speechAvailable && !running && <button type="button" className={`composer-mic ${listening ? 'is-active' : ''}`} aria-label={listening ? 'Arrêter la dictée' : 'Dicter'} onClick={dictate}><Mic size={17} /></button>}
        {running ? (
          <button type="button" className="composer-send is-stop" aria-label="Arrêter le bot" onClick={onStop}><Square size={13} fill="currentColor" /></button>
        ) : (
          <button type="button" className="composer-send" aria-label="Envoyer" disabled={disabled || (!text.trim() && images.length === 0)} onClick={submit}><ArrowUp size={18} /></button>
        )}
      </div>
      <div className="composer-hint">
        <span className="composer-hint-keys">Entrée pour envoyer · Maj + Entrée pour une nouvelle ligne · /model</span>
        <div className="composer-status">
          {showUsage && <span className="usage-readout">{formatUsage(usage)}</span>}
          <button type="button" className={`usage-toggle ${showUsage ? 'is-active' : ''}`} aria-label="Afficher le contexte et le débit" aria-pressed={showUsage} onClick={onToggleUsage}><Gauge size={13} /></button>
          <button type="button" className="model-chip" aria-label="Choisir le modèle" onClick={() => onOpenModels('')}>{modelLabel}<ChevronDown size={11} /></button>
        </div>
      </div>
    </div>
  )
}
