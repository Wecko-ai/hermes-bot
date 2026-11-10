import { afterEach, describe, expect, it, vi } from 'vitest'
import { deliveryPlaceholder, loadDraft, priorityApiText, saveDraft } from './delivery'

describe('envoi pendant le travail', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('ajoute la consigne de reprise après le texte, ou après la consigne du mode', () => {
    expect(priorityApiText('Arrête-toi')).toMatch(/^Arrête-toi\n\n\[HermesBot priority: .*resume the interrupted task/)
    expect(priorityApiText('Idée', 'Idée\n\n[HermesBot mode: BRAIN.]')).toMatch(/^Idée\n\n\[HermesBot mode: BRAIN\.\]\n\n\[HermesBot priority:/)
  })

  it('dit au champ de saisie ce qui va se passer', () => {
    expect(deliveryPlaceholder('wait', 'Nova')).toContain('attend la fin de son tour')
    expect(deliveryPlaceholder('queue', 'Nova')).toContain('à la fin de son tour')
    expect(deliveryPlaceholder('priority', 'Nova')).toContain('s’interrompt')
  })

  it('garde un brouillon par bot et l’oublie une fois vide', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value) })
    saveDraft('nova', 'À finir après le rendu')
    saveDraft('sage', 'Autre brouillon')
    expect(loadDraft('nova')).toBe('À finir après le rendu')
    expect(loadDraft('vega')).toBe('')
    saveDraft('nova', '   ')
    expect(loadDraft('nova')).toBe('')
    expect(JSON.parse(store.get('hermesbot-drafts') || '{}')).toEqual({ sage: 'Autre brouillon' })
    store.set('hermesbot-drafts', 'pas du json')
    expect(loadDraft('sage')).toBe('')
  })

  it('reste utilisable sans stockage', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('bloqué') }, setItem: () => { throw new Error('bloqué') } })
    expect(() => saveDraft('nova', 'texte')).not.toThrow()
    expect(loadDraft('nova')).toBe('')
  })
})
