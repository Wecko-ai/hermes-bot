import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, Cpu } from 'lucide-react'
import { localModelFacts, type LocalMemory, type LocalModels } from '../lib/local-chat'
import './LocalModelMenu.css'

interface LocalModelMenuProps {
  current: string
  models: LocalModels | null
  memory: LocalMemory | null
  disabled: boolean
  onOpen: () => void
  onSelect: (model: string) => void
}

/** The exact Ollama model of the local chat, and the list of installed models to switch to. */
export function LocalModelMenu({ current, models, memory, disabled, onOpen, onSelect }: LocalModelMenuProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const installed = models?.models ?? []

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    const row = listRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? listRef.current?.querySelector<HTMLButtonElement>('button')
    row?.focus()
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])

  const toggle = () => {
    if (!open) onOpen()
    setOpen(!open)
  }
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      rootRef.current?.querySelector<HTMLButtonElement>('.local-model-chip')?.focus()
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const rows = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    const index = rows.indexOf(document.activeElement as HTMLButtonElement)
    rows[(index + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]?.focus()
  }

  return (
    <div className="local-model-menu" ref={rootRef} onKeyDown={keyDown}>
      <button type="button" className="local-model-chip" aria-label={`${t('localChat.chooseModel')} (${current})`} title={current} aria-haspopup="menu" aria-expanded={open} disabled={disabled || installed.length === 0} onClick={toggle}>
        <Cpu size={14} aria-hidden="true" />
        <span>{current}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open && (
        <div className="local-model-popover" role="menu" aria-label={t('localChat.modelsTitle')} ref={listRef}>
          <p className="local-model-popover-title">{t('localChat.modelsTitle')}</p>
          {installed.length === 0 && <p className="local-model-empty">{t('localChat.noModels')}</p>}
          {installed.map((model) => {
            const facts = localModelFacts(models?.details?.[model])
            const inMemory = memory?.loaded.some((entry) => entry.model === model) ?? false
            return (
              <button type="button" key={model} role="menuitemradio" aria-checked={model === current} className="local-model-row" onClick={() => { setOpen(false); if (model !== current) onSelect(model) }}>
                <span className="local-model-row-check" aria-hidden="true">{model === current && <Check size={14} />}</span>
                <span className="local-model-row-text">
                  <span className="local-model-row-name">{model}</span>
                  {(facts || inMemory) && (
                    <span className="local-model-row-facts">
                      {inMemory && <span className="local-model-row-memory"><i aria-hidden="true" />{t('localChat.inMemory')}</span>}
                      {facts}
                    </span>
                  )}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
