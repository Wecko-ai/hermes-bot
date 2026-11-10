import { useState } from 'react'
import { Search } from 'lucide-react'
import type { Bot } from '../types'
import { BotAvatar } from './BotAvatar'

interface CommandPaletteProps {
  bots: Bot[]
  onSelect: (bot: Bot) => void
  onClose: () => void
}

/** ⌘K : aller à un bot au clavier. */
export function CommandPalette({ bots, onSelect, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const search = query.trim().toLocaleLowerCase('fr')
  const results = bots
    .filter((bot) => !bot.hidden && `${bot.name} ${bot.slug} ${bot.role} ${bot.section}`.toLocaleLowerCase('fr').includes(search))
    .sort((a, b) => Number(b.name.toLocaleLowerCase('fr').startsWith(search)) - Number(a.name.toLocaleLowerCase('fr').startsWith(search)))
    .slice(0, 30)
  const active = Math.min(index, Math.max(0, results.length - 1))
  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Aller à un bot" onMouseDown={(event) => event.stopPropagation()}>
        <div className="palette-search">
          <Search size={15} />
          <input
            autoFocus
            value={query}
            placeholder="Aller à un bot"
            aria-label="Chercher un bot"
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
        <div className="palette-results" role="listbox" aria-label="Bots">
          {results.length === 0 && <p>Aucun bot trouvé.</p>}
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
