import { describe, expect, it } from 'vitest'
import { parseSharedSettings, relaySharedSettingsGet, relaySharedSettingsPut, sharedSettingsFrom, sharedSettingsText } from './shared-settings.mjs'

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

  it('drops the upstream body on every answer, including 404 and a successful write', async () => {
    const upstream = (status, text) => {
      const state = { status, ok: status >= 200 && status < 300, cancelled: false }
      state.json = async () => ({ text })
      state.body = { cancel: async () => { state.cancelled = true } }
      return state
    }
    const missing = upstream(404, '')
    expect(await relaySharedSettingsGet(missing)).toEqual({ status: 200, body: { exists: false, settings: {} } })
    expect(missing.cancelled).toBe(true)
    const broken = upstream(500, '')
    expect(await relaySharedSettingsGet(broken)).toEqual({ status: 500, body: { error: 'shared_settings_unreadable' } })
    expect(broken.cancelled).toBe(true)
    const found = upstream(200, sharedSettingsText({ hiddenModels: ['a:b'] }))
    expect(await relaySharedSettingsGet(found)).toEqual({ status: 200, body: { exists: true, settings: { hiddenModels: ['a:b'] } } })
    expect(found.cancelled).toBe(true)
    const saved = upstream(200, '')
    expect((await relaySharedSettingsPut(saved, { hiddenModels: [] })).status).toBe(200)
    expect(saved.cancelled).toBe(true)
    const refused = upstream(403, '')
    expect(await relaySharedSettingsPut(refused, {})).toEqual({ status: 403, body: { error: 'shared_settings_unwritable' } })
    expect(refused.cancelled).toBe(true)
  })
})
