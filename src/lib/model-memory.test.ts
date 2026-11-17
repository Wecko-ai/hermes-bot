import { describe, expect, it } from 'vitest'
import { MODEL_MEMORY_MS, withRememberedModels } from './model-memory'

const now = 1_000_000_000_000
const full = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-haiku-5-5']
// Hermes's built-in list, served while the gateway's catalog cache warms again after an OAuth refresh.
const builtIn = ['claude-fable-5.1', 'claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001']

describe('modèles vus récemment', () => {
  it('garde Sonnet 5.5 quand la gateway répond avec sa liste intégrée', () => {
    const first = withRememberedModels(full, [], now)
    expect(first.models).toEqual(full)
    const fallback = withRememberedModels(builtIn, first.memory, now + 60_000)
    expect(fallback.models).toEqual(['claude-fable-5-1', 'claude-fable-5.1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-haiku-5-5', 'claude-haiku-4-5-20251001'])
  })

  it('garde l’heure de la dernière liste qui avait le modèle', () => {
    const first = withRememberedModels(full, [], now)
    const later = withRememberedModels(builtIn, first.memory, now + 1000)
    expect(new Map(later.memory).get('claude-sonnet-5-5')).toBe(now)
    expect(new Map(later.memory).get('claude-opus-5-5')).toBe(now + 1000)
  })

  it('oublie un modèle absent depuis plus de sept jours', () => {
    const first = withRememberedModels(full, [], now)
    const late = withRememberedModels(builtIn, first.memory, now + MODEL_MEMORY_MS + 1)
    expect(late.models).toEqual(builtIn)
  })

  it('ne repropose pas un modèle que la gateway dit indisponible', () => {
    const first = withRememberedModels(full, [], now)
    const next = withRememberedModels(['claude-opus-5-5'], first.memory, now + 1, new Set(['claude-sonnet-5-5']))
    expect(next.models).not.toContain('claude-sonnet-5-5')
    expect(next.memory.map(([model]) => model)).not.toContain('claude-sonnet-5-5')
  })

  it('place en tête un modèle dont aucun voisin n’est listé', () => {
    const memory: Array<[string, number]> = [['a', now], ['b', now]]
    expect(withRememberedModels(['c'], memory, now + 1).models).toEqual(['a', 'b', 'c'])
  })
})
