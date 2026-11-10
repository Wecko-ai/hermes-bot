import { describe, expect, it } from 'vitest'
import { DEFAULT_APP_CONFIG, compareSections, getAppConfig, parseAppConfig, setAppConfig } from './app-config'
import { hasAnimation } from './animations'

describe('réglages de l’installation', () => {
  it('garde les valeurs par défaut pour une réponse vide ou invalide', () => {
    expect(parseAppConfig(null)).toEqual(DEFAULT_APP_CONFIG)
    expect(parseAppConfig({ ui: 'x', animatedBots: 'orion' })).toEqual(DEFAULT_APP_CONFIG)
  })

  it('ne garde que des textes', () => {
    const config = parseAppConfig({ ui: { defaultBot: 'orion', sectionOrder: ['Atelier', 3, ''], userInitial: 'ABC', hiddenProviders: ['x'] }, animatedBots: ['orion', null] })
    expect(config.ui.defaultBot).toBe('orion')
    expect(config.ui.sectionOrder).toEqual(['Atelier'])
    expect(config.ui.userInitial).toBe('AB')
    expect(config.ui.hiddenProviders).toEqual(['x'])
    expect(config.animatedBots).toEqual(['orion'])
  })

  it('anime seulement les bots listés par le serveur', () => {
    setAppConfig(parseAppConfig({ animatedBots: ['orion'] }))
    expect(hasAnimation('orion')).toBe(true)
    expect(hasAnimation('iris')).toBe(false)
    setAppConfig(DEFAULT_APP_CONFIG)
    expect(getAppConfig().animatedBots).toEqual([])
  })

  it('range les sections dans l’ordre choisi, les autres par ordre alphabétique, Non classés puis Local à la fin', () => {
    const sections = ['Non classés', 'Voyage', 'Local', 'Atelier', 'Maison', 'Lecture']
    const trailing = ['Non classés', 'Local']
    expect([...sections].sort(compareSections([], trailing))).toEqual(['Atelier', 'Lecture', 'Maison', 'Voyage', 'Non classés', 'Local'])
    expect([...sections].sort(compareSections(['Maison', 'Atelier'], trailing))).toEqual(['Maison', 'Atelier', 'Lecture', 'Voyage', 'Non classés', 'Local'])
    expect([...sections].sort(compareSections(['Non classés', 'Voyage'], trailing))).toEqual(['Non classés', 'Voyage', 'Atelier', 'Lecture', 'Maison', 'Local'])
  })
})
