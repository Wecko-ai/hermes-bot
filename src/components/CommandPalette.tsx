import { useState } from 'react'
import { Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Bot } from '../types'
import { BotAvatar } from './BotAvatar'
import { locale } from '../i18n'

interface CommandPaletteProps {
  bots: Bot[]
  onSelect: (bot: Bot) => void
  onClose: () => void
}

/** ⌘K: jump to a bot from the keyboard. */
export function CommandPalette({ bots, onSelect, onClose }: CommandPaletteProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const lower = (value: string) => value.toLocaleLowerCase(locale())
  const search = lower(query.trim())
  const results = bots
    .filter((bot) => !bot.hidden && lower(`${bot.name} ${bot.slug} ${bot.role} ${bot.section}`).includes(search))
    .sort((a, b) => Number(lower(b.name).startsWith(search)) - Number(lower(a.name).startsWith(search)))
    .slice(0, 30)
  const active = Math.min(index, Math.max(0, results.length - 1))
  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-modal="true" aria-label={t('palette.goTo')} onMouseDown={(event) => event.stopPropagation()}>
        <div className="palette-search">
          <Search size={15} />
          <input
            autoFocus
            value={query}
            placeholder={t('palette.goTo')}
            aria-label={t('palette.findBot')}
            onChange={(event) => { setQuery(event.target.value); setIndex(0) }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onClose()
              else if (event.key === 'Enter' && results[active]) onSelect(results[active])
              else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && results.length) setIndex((active + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length)
              else return
              event.preventDefault()
            }}
          />
        </div>
        <div className="palette-results" role="listbox" aria-label={t('palette.bots')}>
          {results.length === 0 && <p>{t('palette.none')}</p>}
          {results.map((bot, position) => (
            <button type="button" key={bot.slug} role="option" aria-selected={position === active} className={position === active ? 'is-active' : ''} onMouseEnter={() => setIndex(position)} onClick={() => onSelect(bot)}>
              <BotAvatar bot={bot} size={26} />
              <strong>{bot.name}</strong>
              <span>{bot.section}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
