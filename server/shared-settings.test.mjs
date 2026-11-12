import { describe, expect, it } from 'vitest'
import { parseSharedSettings, sharedSettingsFrom, sharedSettingsText } from './shared-settings.mjs'

describe('réglages partagés', () => {
  it('ne garde que les champs connus, bien typés', () => {
    expect(sharedSettingsFrom({ hiddenModels: ['a:b', 'a:b', 3, '', 'c:d'], token: 'x' })).toEqual({ hiddenModels: ['a:b', 'c:d'] })
    expect(sharedSettingsFrom(null)).toEqual({})
    expect(sharedSettingsFrom({ hiddenModels: 'a:b' })).toEqual({})
  })
  it('relit le fichier écrit, et un fichier illisible vaut vide', () => {
    expect(parseSharedSettings(sharedSettingsText({ hiddenModels: ['x:y'] }))).toEqual({ hiddenModels: ['x:y'] })
    expect(JSON.parse(sharedSettingsText({ hiddenModels: [] })).version).toBe(1)
    expect(parseSharedSettings('{oops')).toEqual({})
  })
})
