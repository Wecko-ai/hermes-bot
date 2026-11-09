import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Search } from 'lucide-react'
import type { ModelOption } from '../types'

interface ModelPickerProps {
  options: ModelOption[]
  current: string
  profileModel: string
  loading: boolean
  error: string
  initialQuery: string
  onSelect: (option: ModelOption) => void
  onClose: () => void
}

export function ModelPicker({ options, current, profileModel, loading, error, initialQuery, onSelect, onClose }: ModelPickerProps) {
  const [query, setQuery] = useState(initialQuery)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => inputRef.current?.focus(), [])

  const filtered = useMemo(() => {
    const words = query.toLocaleLowerCase('fr').split(/[\s/_-]+/).filter(Boolean)
    return options.filter((option) => {
      const text = `${option.model} ${option.providerName}`.toLocaleLowerCase('fr').replace(/[/_-]+/g, ' ')
      return words.every((word) => text.includes(word))
    })
  }, [options, query])

  const groups = useMemo(() => {
    const map = new Map<string, ModelOption[]>()
    filtered.forEach((option) => map.set(option.providerName, [...(map.get(option.providerName) || []), option]))
    return [...map.entries()]
  }, [filtered])

  return (
    <>
      <button className="model-picker-scrim" aria-label="Fermer le choix du modèle" onClick={onClose} />
      <div className="model-picker" role="dialog" aria-label="Choisir un modèle">
        <div className="model-picker-search">
          <Search size={14} />
          <input
            ref={inputRef}
            value={query}
            placeholder="Rechercher un modèle"
            aria-label="Rechercher un modèle"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onClose()
              if (event.key === 'Enter' && filtered[0]) onSelect(filtered[0])
            }}
          />
        </div>
        <div className="model-picker-list">
          {loading && options.length === 0 && <p className="model-picker-note">Chargement des modèles…</p>}
          {error && <p className="model-picker-note is-error">{error}</p>}
          {!loading && !error && filtered.length === 0 && <p className="model-picker-note">Aucun modèle trouvé.</p>}
          {groups.map(([provider, models]) => (
            <section key={provider}>
              <h3>{provider}</h3>
              {models.map((option) => (
                <button key={`${option.provider}:${option.model}`} className="model-option" data-model={option.model} onClick={() => onSelect(option)}>
                  <span className="model-option-name">{option.model}</span>
                  {option.model === profileModel && <span className="model-option-tag">Profil</span>}
                  {option.inputPrice && option.outputPrice && <span className="model-option-price">{option.inputPrice} / {option.outputPrice}</span>}
                  {option.model === current && <Check size={14} />}
                </button>
              ))}
            </section>
          ))}
        </div>
        <p className="model-picker-footer">S’applique à cette conversation. Le profil du bot ne change pas.</p>
      </div>
    </>
  )
}
