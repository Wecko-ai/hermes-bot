import { describe, expect, it } from 'vitest'
import { dictationLanguageCode, hiddenModelKey, parseSettings, selectableModels, withModelsVisible, withPinned } from './settings'
import type { ModelOption } from '../types'

const option = (model: string, provider = 'anthropic'): ModelOption => ({ model, provider, providerName: provider })

describe('réglages', () => {
  it('reprend les anciennes préférences tant que le réglage n’a jamais été écrit', () => {
    const legacy = (key: string) => ({ 'hermesbot-theme': 'dark', 'hermesbot-show-usage': '1', 'hermesbot-sort': 'activity' } as Record<string, string>)[key] ?? null
    expect(parseSettings(null, legacy)).toMatchObject({ theme: 'dark', showUsage: true, activitySort: true })
    expect(parseSettings('{"theme":"light","showUsage":false,"activitySort":false}', legacy)).toMatchObject({ theme: 'light', showUsage: false, activitySort: false })
  })

  it('suit le système et garde Entrée par défaut', () => {
    expect(parseSettings(null)).toEqual({ language: 'system', theme: 'system', textSize: 'normal', reduceMotion: false, showUsage: false, sendKey: 'enter', dictationLanguage: 'interface', caveman: false, activitySort: false, showHidden: false, pinnedBots: [], hiddenModels: [], freeMode: false, localModel: '', notifications: true })
  })

  it('garde les bots épinglés dans leur ordre, sans valeur étrangère', () => {
    expect(parseSettings('{"pinnedBots":["orion",3,"nova"]}').pinnedBots).toEqual(['orion', 'nova'])
    expect(parseSettings('{"pinnedBots":"orion"}').pinnedBots).toEqual([])
  })

  it('épingle à la suite et désépingle sans doublon', () => {
    expect(withPinned(['orion'], 'nova', true)).toEqual(['orion', 'nova'])
    expect(withPinned(['orion', 'nova'], 'orion', true)).toEqual(['nova', 'orion'])
    expect(withPinned(['orion', 'nova'], 'orion', false)).toEqual(['nova'])
    expect(withPinned([], 'orion', false)).toEqual([])
  })

  it('garde le mode caveman choisi et refuse une valeur qui n’est pas un booléen', () => {
    expect(parseSettings('{"caveman":true}').caveman).toBe(true)
    expect(parseSettings('{"caveman":"oui"}').caveman).toBe(false)
  })

  it('écoute la dictée dans la langue choisie, sinon dans celle de l’interface', () => {
    expect(parseSettings('{"dictationLanguage":"fr"}').dictationLanguage).toBe('fr')
    expect(parseSettings('{"dictationLanguage":"de"}').dictationLanguage).toBe('interface')
    expect(dictationLanguageCode('fr', 'en')).toBe('fr')
    expect(dictationLanguageCode('en', 'fr')).toBe('en')
    expect(dictationLanguageCode('interface', 'fr')).toBe('fr')
    expect(dictationLanguageCode('interface', 'en')).toBe('en')
    expect(dictationLanguageCode('interface', 'de')).toBe('en')
  })

  it('remplace une valeur invalide au lieu de la propager', () => {
    expect(parseSettings('pas du json').theme).toBe('system')
    expect(parseSettings('[1]').sendKey).toBe('enter')
    expect(parseSettings('{"theme":"rose","textSize":12,"reduceMotion":"oui","hiddenModels":["a:b",3]}')).toMatchObject({ theme: 'system', textSize: 'normal', reduceMotion: false, hiddenModels: ['a:b'] })
  })
})

describe('modèles proposés', () => {
  const options = [option('claude-opus-5-5'), option('claude-sonnet-5-5'), option('claude-sonnet-5-5', 'openrouter'), option('claude-haiku-5-5')]

  it('retire un modèle masqué chez ce fournisseur seulement', () => {
    const hidden = [hiddenModelKey(options[1])]
    expect(selectableModels(options, hidden, []).map(hiddenModelKey)).toEqual(['anthropic:claude-opus-5-5', 'openrouter:claude-sonnet-5-5', 'anthropic:claude-haiku-5-5'])
  })

  it('garde le modèle actif et celui du profil, même masqués', () => {
    const hidden = options.map(hiddenModelKey)
    expect(selectableModels(options, hidden, ['claude-opus-5-5', 'claude-haiku-5-5']).map((item) => item.model)).toEqual(['claude-opus-5-5', 'claude-haiku-5-5'])
  })

  it('en mode gratuit, ne propose que les modèles gratuits et ceux des abonnements, sauf le modèle actif', () => {
    const all = [...options, option('nvidia/nemotron-3-ultra-550b-a55b:free', 'openrouter'), option('gemini-3.5-flash', 'gemini'), option('gemini-4-carbon', 'gemini')]
    expect(selectableModels(all, [], [], []).map(hiddenModelKey)).toEqual(['openrouter:nvidia/nemotron-3-ultra-550b-a55b:free', 'gemini:gemini-3.5-flash'])
    expect(selectableModels(all, [], ['claude-opus-5-5'], []).map((item) => item.model)).toEqual(['claude-opus-5-5', 'nvidia/nemotron-3-ultra-550b-a55b:free', 'gemini-3.5-flash'])
    expect(selectableModels(all, ['gemini:gemini-3.5-flash'], [], []).map((item) => item.model)).toEqual(['nvidia/nemotron-3-ultra-550b-a55b:free'])
    // The Anthropic subscription costs nothing more; the same model on OpenRouter is still paid.
    expect(selectableModels(all, [hiddenModelKey(options[1])], [], ['anthropic']).map(hiddenModelKey)).toEqual(['anthropic:claude-opus-5-5', 'anthropic:claude-haiku-5-5', 'openrouter:nvidia/nemotron-3-ultra-550b-a55b:free', 'gemini:gemini-3.5-flash'])
    // Free mode off: everything not hidden.
    expect(selectableModels(all, [], [], undefined)).toHaveLength(all.length)
    expect(parseSettings('{"freeMode":true}').freeMode).toBe(true)
    expect(parseSettings('{"freeMode":"oui"}').freeMode).toBe(false)
  })

  it('laisse proposé un modèle qui vient d’apparaître', () => {
    expect(selectableModels([...options, option('claude-fable-9')], [hiddenModelKey(options[0])], []).map((item) => item.model)).toContain('claude-fable-9')
  })

  it('masque et réaffiche sans doublon ni perte des autres', () => {
    const hidden = withModelsVisible(['autre:x', 'anthropic:claude-opus-5-5'], [options[0], options[3]], false)
    expect(hidden).toEqual(['autre:x', 'anthropic:claude-opus-5-5', 'anthropic:claude-haiku-5-5'])
    expect(withModelsVisible(hidden, [options[0], options[3]], true)).toEqual(['autre:x'])
  })
})
