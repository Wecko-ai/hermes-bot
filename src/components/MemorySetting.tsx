import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { deleteMemoryEntry, loadMemory, loadMemoryIndex, saveMemoryEntry, searchMemory, type MemoryEntry, type MemoryType } from '../lib/shared-memory'

const TYPES: MemoryType[] = ['profile', 'rules', 'people', 'workstreams']

export function MemorySetting() {
  const { t } = useTranslation()
  const [type, setType] = useState<MemoryType>('profile')
  const [entries, setEntries] = useState<MemoryEntry[]>([])
  const [search, setSearch] = useState('')
  const [hits, setHits] = useState<MemoryEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState({ title: '', body: '', source: 'user' })
  const [index, setIndex] = useState<Record<MemoryType, { entries: number; preview: string }> | null>(null)

  const loadType = useCallback(async (next: MemoryType) => {
    setBusy(true)
    setError('')
    try {
      const file = await loadMemory(next)
      setEntries(file.entries)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => { void loadMemoryIndex().then((body) => setIndex(body.types)).catch(() => {}) }, [])
  useEffect(() => { void loadType(type) }, [loadType, type])

  useEffect(() => {
    if (!search.trim()) { setHits([]); return }
    const handle = setTimeout(() => {
      void searchMemory(search.trim()).then((body) => setHits(body.hits)).catch(() => setHits([]))
    }, 250)
    return () => clearTimeout(handle)
  }, [search])

  const summary = useMemo(() => index?.[type], [index, type])

  const submit = async () => {
    if (!draft.title.trim()) return
    setBusy(true)
    setError('')
    try {
      const file = await saveMemoryEntry(type, draft)
      setEntries(file.entries)
      setDraft({ title: '', body: '', source: 'user' })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (entry: MemoryEntry) => {
    setBusy(true)
    try {
      const file = await deleteMemoryEntry(type, entry.id)
      setEntries(file.entries)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const list = search.trim() ? hits : entries

  return (
    <div className="memory-settings">
      <p className="settings-hint">{t('settings.memory.hint')}</p>
      <div className="memory-types" role="tablist" aria-label={t('settings.memory.types')}>
        {TYPES.map((item) => (
          <button key={item} type="button" role="tab" aria-selected={item === type} className={item === type ? 'is-active' : ''} onClick={() => setType(item)}>
            {t(`settings.memory.type.${item}`)}{summary ? ` (${index?.[item]?.entries ?? 0})` : ''}
          </button>
        ))}
      </div>
      <label className="settings-row">
        <span className="settings-row-copy"><strong>{t('settings.memory.search')}</strong></span>
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('settings.memory.searchPlaceholder')} />
      </label>
      <div className="memory-entries">
        {list.map((entry) => (
          <article key={`${entry.type}-${entry.id}`} className="memory-entry">
            <header>
              <strong>{entry.title}</strong>
              <span>{entry.date || '—'}{entry.source ? ` · ${entry.source}` : ''}</span>
              <button type="button" className="plain-icon" disabled={busy} onClick={() => void remove(entry)} aria-label={t('settings.memory.delete')}>×</button>
            </header>
            <p>{entry.body}</p>
          </article>
        ))}
        {!list.length && <p className="settings-hint">{t('settings.memory.empty')}</p>}
      </div>
      <div className="memory-compose">
        <h4>{t('settings.memory.add')}</h4>
        <input value={draft.title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} placeholder={t('settings.memory.titlePlaceholder')} />
        <textarea value={draft.body} onChange={(event) => setDraft((current) => ({ ...current, body: event.target.value }))} rows={4} placeholder={t('settings.memory.bodyPlaceholder')} />
        <button type="button" disabled={busy || !draft.title.trim()} onClick={() => void submit()}>{t('settings.memory.saveEntry')}</button>
      </div>
      {error && <p className="settings-error" role="alert">{error}</p>}
    </div>
  )
}