import { afterEach, describe, expect, it, vi } from 'vitest'
import { cavemanApiText, loadModes, modeApiText, modePlaceholder, saveModes } from './modes'

describe('modes de travail', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('garde le texte de l’utilisateur et ajoute la consigne du mode', () => {
    expect(modeApiText('Une idée ?', 'brain')).toMatch(/^Une idée \?\n\n\[HermesBot mode: BRAIN\./)
    expect(modeApiText('Prépare ça', 'plan')).toMatch(/^Prépare ça\n\n\[HermesBot mode: PLAN\./)
    expect(modeApiText('Fais-le', 'exec')).toBeUndefined()
  })

  it('interdit l’exécution en BRAIN et en PLAN', () => {
    for (const mode of ['brain', 'plan'] as const) expect(modeApiText('x', mode)).toContain('Do not change files')
  })

  it('ajoute la note caveman après la consigne du mode, et rien quand le réglage est coupé', () => {
    expect(cavemanApiText('Fais-le', undefined, false)).toBeUndefined()
    expect(cavemanApiText('Fais-le', undefined, true)).toMatch(/^Fais-le\n\n\[HermesBot style: caveman\. For this turn only/)
    const brain = modeApiText('Une idée ?', 'brain')
    expect(cavemanApiText('Une idée ?', brain, false)).toBe(brain)
    expect(cavemanApiText('Une idée ?', brain, true)).toMatch(/^Une idée \?\n\n\[HermesBot mode: BRAIN\..*\]\n\n\[HermesBot style: caveman\./s)
  })

  it('ne raccourcit que les réponses du chat', () => {
    const note = cavemanApiText('x', undefined, true)
    for (const kept of ['emails', 'posts', 'messages to others', 'negations exact', 'irreversible actions']) expect(note).toContain(kept)
  })

  it('adapte le champ de saisie', () => {
    expect(modePlaceholder('brain', 'Nova')).toBe('Réfléchir avec Nova')
    expect(modePlaceholder('plan', 'Nova')).toBe('Préparer un plan avec Nova')
    expect(modePlaceholder('exec', 'Nova')).toBe('Message Nova')
  })

  it('retrouve le mode de chaque bot et ignore une valeur inconnue', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value) })
    saveModes({ nova: 'plan' })
    expect(loadModes()).toEqual({ nova: 'plan' })
    store.set('hermesbot-modes', JSON.stringify({ nova: 'brain', sage: 'inconnu' }))
    expect(loadModes()).toEqual({ nova: 'brain' })
    store.set('hermesbot-modes', 'pas du json')
    expect(loadModes()).toEqual({})
  })
})
