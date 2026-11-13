import { describe, expect, it, vi } from 'vitest'
import { BOT_CARD_KEY, BotManageError, isRemovedProfile, moveBotToSection, newSectionId, readProfileMeta, REMOVED_KEY, removeBot, renameBot, restoreBot, setBotHidden, updateBotCard, writeUiMeta } from './bot-manage'
import { HermesRpcError } from './hermes'

type Json = Record<string, unknown>

/** The gateway's `profiles.configure` as Hermes writes `ui_meta`: per-key merge, `null` deletes, per-key compare-and-swap. */
function fakeGateway(uiMeta: Json, revisions: Record<string, number> | null = {}) {
  const profile = { name: 'orion', ui_meta: structuredClone(uiMeta), ui_meta_revisions: revisions ? { ...revisions } : undefined }
  const configureCalls: Json[] = []
  /** Another app writes between the read and the write, this many times. */
  let interleaved = 0
  const request = vi.fn(async (method: string, params: Json = {}) => {
    if (method === 'profiles.list') {
      const row = structuredClone(profile)
      if (interleaved > 0) {
        interleaved -= 1
        // The other app's write lands just after this read.
        queueMicrotask(() => { if (profile.ui_meta_revisions) profile.ui_meta_revisions[BOT_CARD_KEY] = (profile.ui_meta_revisions[BOT_CARD_KEY] ?? 0) + 1 })
      }
      return { profiles: [{ name: 'default', is_default: true }, row] }
    }
    if (method === 'profiles.configure') {
      configureCalls.push(structuredClone(params))
      const incoming = params.ui_meta as Json
      const expected = params.ui_meta_expected_revisions as Record<string, number> | undefined
      const current = profile.ui_meta_revisions ?? {}
      if (expected && profile.ui_meta_revisions) {
        const conflicts = Object.fromEntries(Object.keys(incoming).flatMap((key) => expected[key] === (current[key] ?? 0) ? [] : [[key, { expected: expected[key], actual: current[key] ?? 0 }]]))
        if (Object.keys(conflicts).length) return { ok: false, applied: { ui_meta: false, ui_meta_conflicts: conflicts, ui_meta_revisions: current } }
      }
      for (const [key, value] of Object.entries(incoming)) {
        if (value === null) delete profile.ui_meta[key]
        else profile.ui_meta[key] = structuredClone(value)
        current[key] = (current[key] ?? 0) + 1
      }
      if (profile.ui_meta_revisions) profile.ui_meta_revisions = current
      return { ok: true, applied: { ui_meta: true, ui_meta_revisions: Object.fromEntries(Object.keys(incoming).map((key) => [key, current[key]])) } }
    }
    throw new Error(`unexpected ${method}`)
  })
  return { client: { request }, profile, configureCalls, interleave: (times: number) => { interleaved = times } }
}

const card = { title: 'Orion', description: 'Test assistant', sectionId: 'build', sectionName: 'Build', shape: 'squircle', color: 'red', created: 1, groups: ['room'] }

describe('carte du bot dans Hermes', () => {
  it('lit le profil et ses révisions tels que la gateway les tient', async () => {
    const { client } = fakeGateway({ [BOT_CARD_KEY]: card }, { [BOT_CARD_KEY]: 3 })
    expect(await readProfileMeta(client, 'orion')).toEqual({ name: 'orion', uiMeta: { [BOT_CARD_KEY]: card }, revisions: { [BOT_CARD_KEY]: 3 } })
    await expect(readProfileMeta(client, 'vega')).rejects.toMatchObject({ reason: 'not_found' })
  })

  it('change un champ, garde tous les autres et envoie la révision lue', async () => {
    const gateway = fakeGateway({ [BOT_CARD_KEY]: card, other: { kept: true } }, { [BOT_CARD_KEY]: 3, other: 1 })
    await moveBotToSection(gateway.client, 'orion', { id: 'sec-x', name: 'Clients' })
    expect(gateway.configureCalls).toEqual([{
      name: 'orion',
      ui_meta: { [BOT_CARD_KEY]: { ...card, sectionId: 'sec-x', sectionName: 'Clients' } },
      ui_meta_expected_revisions: { [BOT_CARD_KEY]: 3 },
    }])
    expect(gateway.profile.ui_meta.other).toEqual({ kept: true })
    expect(gateway.profile.ui_meta_revisions).toEqual({ [BOT_CARD_KEY]: 4, other: 1 })
  })

  it('range un bot sous Non classés avec des valeurs nulles, comme Hermes Desktop', async () => {
    const gateway = fakeGateway({ [BOT_CARD_KEY]: card }, { [BOT_CARD_KEY]: 1 })
    await moveBotToSection(gateway.client, 'orion', null)
    expect(gateway.profile.ui_meta[BOT_CARD_KEY]).toMatchObject({ sectionId: null, sectionName: null, title: 'Orion' })
  })

  it('renomme le nom affiché seulement, sans espaces autour, et refuse un nom vide', async () => {
    const gateway = fakeGateway({ [BOT_CARD_KEY]: card }, { [BOT_CARD_KEY]: 0 })
    await renameBot(gateway.client, 'orion', '  Orion Prime ')
    expect(gateway.profile.ui_meta[BOT_CARD_KEY]).toEqual({ ...card, title: 'Orion Prime' })
    expect(gateway.configureCalls[0].name).toBe('orion')
    await expect(renameBot(gateway.client, 'orion', '   ')).rejects.toMatchObject({ reason: 'rejected' })
    expect(gateway.configureCalls).toHaveLength(1)
  })

  it('crée la carte d’un profil qui n’en avait pas, avec la révision 0', async () => {
    const gateway = fakeGateway({}, {})
    await setBotHidden(gateway.client, 'orion', true)
    expect(gateway.configureCalls[0]).toMatchObject({ ui_meta: { [BOT_CARD_KEY]: { hidden: true } }, ui_meta_expected_revisions: { [BOT_CARD_KEY]: 0 } })
  })

  it('relit et recommence une fois si une autre app a écrit entre-temps', async () => {
    const gateway = fakeGateway({ [BOT_CARD_KEY]: card }, { [BOT_CARD_KEY]: 5 })
    gateway.interleave(1)
    await renameBot(gateway.client, 'orion', 'Orion 2')
    expect(gateway.configureCalls.map((call) => call.ui_meta_expected_revisions)).toEqual([{ [BOT_CARD_KEY]: 5 }, { [BOT_CARD_KEY]: 6 }])
    expect(gateway.profile.ui_meta[BOT_CARD_KEY]).toMatchObject({ title: 'Orion 2' })
  })

  it('abandonne après deux conflits, sans rien écrire', async () => {
    const gateway = fakeGateway({ [BOT_CARD_KEY]: card }, { [BOT_CARD_KEY]: 5 })
    gateway.interleave(2)
    await expect(renameBot(gateway.client, 'orion', 'Orion 2')).rejects.toMatchObject({ reason: 'conflict' })
    expect(gateway.configureCalls).toHaveLength(2)
    expect(gateway.profile.ui_meta[BOT_CARD_KEY]).toEqual(card)
  })

  it('écrit sans révisions attendues sur une gateway qui n’en a pas', async () => {
    const gateway = fakeGateway({ [BOT_CARD_KEY]: card }, null)
    await updateBotCard(gateway.client, 'orion', { color: 'blue' })
    expect(gateway.configureCalls[0]).toEqual({ name: 'orion', ui_meta: { [BOT_CARD_KEY]: { ...card, color: 'blue' } } })
  })

  it('dit clairement pourquoi une écriture échoue', async () => {
    const unknown = { request: vi.fn(async (method: string) => {
      if (method === 'profiles.list') return { profiles: [{ name: 'orion', ui_meta_revisions: {} }] }
      throw new HermesRpcError('unknown method: profiles.configure', {}, -32601)
    }) }
    await expect(setBotHidden(unknown, 'orion', true)).rejects.toMatchObject({ reason: 'unsupported' })
    const refused = { request: vi.fn(async (method: string) => {
      if (method === 'profiles.list') return { profiles: [{ name: 'orion', ui_meta_revisions: {} }] }
      throw new HermesRpcError('profile locked', {}, 5064)
    }) }
    await expect(setBotHidden(refused, 'orion', true)).rejects.toMatchObject({ reason: 'refused', message: 'profile locked' })
    const offline = { request: vi.fn(async () => { throw new Error('Hermes déconnecté') }) }
    await expect(setBotHidden(offline, 'orion', true)).rejects.toBeInstanceOf(BotManageError)
    await expect(setBotHidden(offline, 'orion', true)).rejects.toMatchObject({ reason: 'offline' })
    const old = { request: vi.fn(async (method: string) => method === 'profiles.list' ? { profiles: [{ name: 'orion' }] } : { ok: true }) }
    await expect(setBotHidden(old, 'orion', true)).rejects.toMatchObject({ reason: 'unsupported' })
    const capped = { request: vi.fn(async (method: string) => method === 'profiles.list' ? { profiles: [{ name: 'orion', ui_meta_revisions: {} }] } : { ok: false, applied: { ui_meta: false } }) }
    await expect(setBotHidden(capped, 'orion', true)).rejects.toMatchObject({ reason: 'rejected' })
  })

  it('passe à `build` le profil tel qu’il est au moment d’écrire', async () => {
    const gateway = fakeGateway({ [BOT_CARD_KEY]: card }, { [BOT_CARD_KEY]: 2 })
    const build = vi.fn(() => ({ note: { a: 1 } }))
    expect(await writeUiMeta(gateway.client, 'orion', build)).toEqual({ note: 1 })
    expect(build).toHaveBeenCalledWith({ name: 'orion', uiMeta: { [BOT_CARD_KEY]: card }, revisions: { [BOT_CARD_KEY]: 2 } })
  })
})

describe('suppression réversible', () => {
  it('masque la carte et garde l’ancienne avec la date, dans une seule écriture', async () => {
    const gateway = fakeGateway({ [BOT_CARD_KEY]: card }, { [BOT_CARD_KEY]: 7 })
    await removeBot(gateway.client, 'orion', new Date('2026-11-13T10:00:00.000Z'))
    expect(gateway.configureCalls).toEqual([{
      name: 'orion',
      ui_meta: {
        [BOT_CARD_KEY]: { ...card, hidden: true },
        [REMOVED_KEY]: { removed_at: '2026-11-13T10:00:00.000Z', card },
      },
      ui_meta_expected_revisions: { [BOT_CARD_KEY]: 7, [REMOVED_KEY]: 0 },
    }])
    expect(isRemovedProfile(gateway.profile.ui_meta)).toBe(true)
  })

  it('rétablit la carte d’avant exactement, et retire la marque', async () => {
    const gateway = fakeGateway({ [BOT_CARD_KEY]: card }, { [BOT_CARD_KEY]: 1 })
    await removeBot(gateway.client, 'orion')
    await removeBot(gateway.client, 'orion')
    expect((gateway.profile.ui_meta[REMOVED_KEY] as Json).card).toEqual(card)
    await restoreBot(gateway.client, 'orion')
    expect(gateway.profile.ui_meta).toEqual({ [BOT_CARD_KEY]: card })
    expect(isRemovedProfile(gateway.profile.ui_meta)).toBe(false)
  })

  it('ne laisse pas de carte inventée à un profil qui n’en avait pas', async () => {
    const gateway = fakeGateway({}, {})
    await removeBot(gateway.client, 'orion')
    expect(gateway.profile.ui_meta[REMOVED_KEY]).toMatchObject({ card: null })
    await restoreBot(gateway.client, 'orion')
    expect(gateway.profile.ui_meta).toEqual({})
  })

  it('reconnaît un profil supprimé seulement à sa marque', () => {
    expect(isRemovedProfile({ [BOT_CARD_KEY]: { hidden: true } })).toBe(false)
    expect(isRemovedProfile({ [REMOVED_KEY]: { removed_at: 'x', card: null } })).toBe(true)
    expect(isRemovedProfile(undefined)).toBe(false)
  })

  it('fabrique des ids de section au format de Hermes Desktop', () => {
    expect(newSectionId()).toMatch(/^sec-[a-z0-9]+-[a-z0-9]{1,5}$/)
  })
})
