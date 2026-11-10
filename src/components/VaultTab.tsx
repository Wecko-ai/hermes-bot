import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { KeyRound, Plus } from 'lucide-react'
import type { Bot } from '../types'
import { listVaultEntries, removeVaultEntry, saveVaultEntry, type VaultEntry } from '../lib/browser-vault'

interface Draft {
  /** Origine de l’identifiant modifié ; vide pour un ajout. */
  editing: string
  origin: string
  identifier: string
  password: string
  allBots: boolean
  bots: Set<string>
}

const emptyDraft = (): Draft => ({ editing: '', origin: '', identifier: '', password: '', allBots: false, bots: new Set() })

const hostOf = (origin: string) => {
  try { return new URL(origin).host } catch { return origin }
}

/**
 * Identifiants du Chrome partagé, rangés dans le trousseau de la machine des bots. Le mot de passe ne revient jamais
 * jusqu’ici : on le remplace, on ne le relit pas.
 */
export function VaultTab({ bots }: { bots: Bot[] }) {
  const [entries, setEntries] = useState<VaultEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const names = useMemo(() => new Map(bots.map((bot) => [bot.slug, bot.name])), [bots])
  const choices = useMemo(() => bots.filter((bot) => !bot.hidden).sort((a, b) => a.name.localeCompare(b.name, 'fr')), [bots])

  const load = () => {
    setLoading(true)
    listVaultEntries()
      .then((items) => { setEntries(items); setError('') })
      .catch((reason) => setError(reason instanceof Error ? reason.message : 'Le coffre ne répond pas.'))
      .finally(() => setLoading(false))
  }
  useEffect(load, [])

  const edit = (entry: VaultEntry) => setDraft({
    editing: entry.origin,
    origin: entry.origin,
    identifier: entry.identifier,
    password: '',
    allBots: entry.bots.includes('*'),
    bots: new Set(entry.bots.filter((bot) => bot !== '*')),
  })
  const toggleBot = (slug: string) => setDraft((current) => {
    if (!current) return current
    const next = new Set(current.bots)
    if (!next.delete(slug)) next.add(slug)
    return { ...current, bots: next }
  })
  const remove = async (entry: VaultEntry) => {
    if (!window.confirm(`Retirer l’identifiant de ${hostOf(entry.origin)} du trousseau de la machine des bots ?`)) return
    try {
      await removeVaultEntry(entry.origin)
      load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Retrait impossible.')
    }
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!draft || saving) return
    setSaving(true)
    setError('')
    try {
      await saveVaultEntry({
        origin: draft.origin.trim(),
        identifier: draft.identifier.trim(),
        ...(draft.password ? { password: draft.password } : {}),
        bots: draft.allBots ? ['*'] : [...draft.bots],
      })
      setDraft(null)
      load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Enregistrement impossible.')
    } finally {
      setSaving(false)
    }
  }

  const botLabel = (entry: VaultEntry) => entry.bots.includes('*')
    ? 'Tous les bots'
    : entry.bots.map((slug) => names.get(slug) || slug).join(', ')

  return (
    <>
      <p className="settings-note">Identifiants que les bots utilisent dans le Chrome partagé. Ils sont rangés dans le trousseau de session de la machine des bots, visibles dans Trousseau d’accès. Le coffre tape lui-même le mot de passe : le bot ne le voit jamais.</p>
      {error && <p className="settings-error" role="alert">{error}</p>}
      {!draft && (
        <div className="vault-tools">
          <button type="button" className="settings-button" onClick={() => setDraft(emptyDraft())}><Plus size={13} />Ajouter un identifiant</button>
        </div>
      )}
      {draft && (
        <form className="vault-form" onSubmit={submit} autoComplete="off">
          <label>Site
            <input value={draft.origin} placeholder="https://www.instagram.com" disabled={Boolean(draft.editing) || saving} required
              onChange={(event) => setDraft({ ...draft, origin: event.target.value })} autoCapitalize="none" spellCheck={false} />
          </label>
          <label>Identifiant
            <input value={draft.identifier} disabled={saving} required onChange={(event) => setDraft({ ...draft, identifier: event.target.value })} autoCapitalize="none" spellCheck={false} />
          </label>
          <label>Mot de passe
            <input type="password" value={draft.password} placeholder={draft.editing ? 'Inchangé' : ''} required={!draft.editing} disabled={saving}
              autoComplete="new-password" onChange={(event) => setDraft({ ...draft, password: event.target.value })} />
          </label>
          <fieldset className="vault-bots">
            <legend>Bots autorisés</legend>
            <label className="vault-bot is-all">
              <input type="checkbox" checked={draft.allBots} disabled={saving} onChange={(event) => setDraft({ ...draft, allBots: event.target.checked })} />Tous les bots
            </label>
            {!draft.allBots && choices.map((bot) => (
              <label key={bot.slug} className="vault-bot">
                <input type="checkbox" checked={draft.bots.has(bot.slug)} disabled={saving} onChange={() => toggleBot(bot.slug)} />{bot.name}
              </label>
            ))}
          </fieldset>
          <div className="vault-form-actions">
            <button type="button" className="settings-button" disabled={saving} onClick={() => setDraft(null)}>Annuler</button>
            <button type="submit" className="settings-button is-primary" disabled={saving || (!draft.allBots && draft.bots.size === 0)}>{saving ? 'Enregistrement…' : 'Enregistrer'}</button>
          </div>
        </form>
      )}
      {loading && !entries.length && <p className="settings-note">Lecture du trousseau…</p>}
      {!loading && !entries.length && !error && <p className="settings-note">Aucun identifiant pour l’instant. Un bot qui doit se connecter te le demandera dans une fenêtre.</p>}
      <div className="vault-list">
        {entries.map((entry) => (
          <div key={entry.origin} className="settings-row vault-entry">
            <div className="settings-row-copy">
              <strong><KeyRound size={12} />{hostOf(entry.origin)}</strong>
              <span>{entry.identifier} · {botLabel(entry)}</span>
            </div>
            <div className="vault-entry-actions">
              <button type="button" className="settings-button" onClick={() => edit(entry)}>Modifier</button>
              <button type="button" className="settings-button is-danger" onClick={() => void remove(entry)}>Retirer</button>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
