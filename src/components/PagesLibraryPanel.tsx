import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { archiveLibraryPage, listLibraryPages, renameLibraryPage, type LibraryPage } from '../lib/pages-library'
import { ViewEmpty } from './ViewEmpty'

interface PagesLibraryPanelProps {
  profile: string
  onOpen: (page: LibraryPage) => void
}

export function PagesLibraryPanel({ profile, onOpen }: PagesLibraryPanelProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<LibraryPage[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    setLoading(true)
    listLibraryPages(profile, query)
      .then(setItems)
      .catch(() => setItems([]))
      .finally(() => setLoading(false))
  }, [profile, query])

  useEffect(load, [load])

  return (
    <section className="details-section pages-library-section">
      <div className="details-section-heading"><span>{t('pagesLibrary.heading')}</span></div>
      <label className="pages-library-search">
        <span className="visually-hidden">{t('pagesLibrary.search')}</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('pagesLibrary.search')} />
      </label>
      {loading && <div className="routine-loading"><span /><span /><span /></div>}
      {!loading && items.length === 0 && <ViewEmpty variant="inline" description={t('pagesLibrary.empty')} role="status" />}
      <ul className="pages-library-list">
        {items.map((item) => (
          <li key={item.id}>
            <button type="button" className="pages-library-open" onClick={() => onOpen(item)}>{item.title}</button>
            <small>{item.name}</small>
            <div className="pages-library-actions">
              <button type="button" onClick={async () => { const title = window.prompt(t('pagesLibrary.renamePrompt'), item.title); if (!title) return; await renameLibraryPage(profile, item.id, title); load() }}>{t('pagesLibrary.rename')}</button>
              <button type="button" onClick={async () => { await archiveLibraryPage(profile, item.id); load() }}>{t('pagesLibrary.archive')}</button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}