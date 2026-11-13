import { describe, expect, it, vi } from 'vitest'
import { BOT_CARD_KEY, REMOVED_KEY } from './bot-manage'
import {
  BOT_COLORS, BOT_SHAPES, BotCreateError, botCreateErrorText, canonicalShape, createBot, createdBotEntry, createProfileParams, leastUsed,
  loadProfileNames, profileNameFrom, profileNameIssue, RESERVED_PROFILE_NAMES, withCreatedBot, type BotDraft,
} from './bot-create'
import { HermesRpcError } from './hermes'
import { UNASSIGNED_SECTION_ID } from './roster-groups'

type Json = Record<string, unknown>

describe('nom du profil Hermes', () => {
  it('suit le nom affiché : minuscules, sans accents, espaces en tirets, le reste retiré', () => {
    expect(profileNameFrom('Léa Martin')).toBe('lea-martin')
    expect(profileNameFrom('  Agent   de voyage  ')).toBe('agent-de-voyage')
    expect(profileNameFrom('Cœur & Âme')).toBe('coeur-ame')
    expect(profileNameFrom('L’agent n°2 !')).toBe('lagent-n2')
    expect(profileNameFrom('Inbox_Triage-v2')).toBe('inbox_triage-v2')
    expect(profileNameFrom('Straße.Ølen/Été')).toBe('strasse-olen-ete')
    expect(profileNameFrom('--Nova--')).toBe('nova')
    expect(profileNameFrom('🤖 Robot ✨')).toBe('robot')
  })

  it('reste vide sans lettre ni chiffre utilisable', () => {
    expect(profileNameFrom('')).toBe('')
    expect(profileNameFrom('!!! ???')).toBe('')
    expect(profileNameFrom('小助手')).toBe('')
  })

  it('tient en 64 caractères, sans tiret au bout', () => {
    const slug = profileNameFrom(`${'a'.repeat(63)} b`)
    expect(slug).toBe('a'.repeat(63))
    expect(profileNameFrom('x'.repeat(80))).toHaveLength(64)
  })

  it('signale un nom invalide, réservé, pris ou gardé par un bot supprimé', () => {
    const known = { taken: new Set(['nova', 'atlas', 'notify']), removed: new Set(['atlas']) }
    expect(profileNameIssue('', known)).toBe('invalid')
    expect(profileNameIssue('-nova', known)).toBe('invalid')
    expect(profileNameIssue('a'.repeat(65), known)).toBe('invalid')
    for (const name of RESERVED_PROFILE_NAMES) expect(profileNameIssue(name, known)).toBe('reserved')
    expect(profileNameIssue('nova', known)).toBe('taken')
    expect(profileNameIssue('notify', known)).toBe('taken')
    expect(profileNameIssue('atlas', known)).toBe('removed')
    expect(profileNameIssue('lea-martin', known)).toBeNull()
  })

  it('lit tous les profils de Hermes, ceux que l’app cache compris', async () => {
    const request = vi.fn().mockResolvedValue({ profiles: [
      { name: 'default', is_default: true }, { name: 'notify' }, { name: 'nova', ui_meta: {} },
      { name: 'atlas', ui_meta: { [REMOVED_KEY]: { removed_at: '2026-11-13T10:00:00.000Z', card: null } } },
    ] })
    const known = await loadProfileNames({ request })
    expect([...known.taken]).toEqual(['default', 'notify', 'nova', 'atlas'])
    expect([...known.removed]).toEqual(['atlas'])
    expect(request).toHaveBeenCalledWith('profiles.list', { include_sessions: false })
  })
})

describe('apparence proposée', () => {
  it('prend la couleur et la forme les moins utilisées, la première en cas d’égalité', () => {
    expect(leastUsed(['a', 'b', 'c'], ['a', 'b', 'a'])).toBe('c')
    expect(leastUsed(['a', 'b', 'c'], ['a', 'b', 'c', 'c'])).toBe('a')
    expect(leastUsed(BOT_COLORS.map((color) => color.value), ['#7a63c9'])).toBe('#3B82C4')
    expect(leastUsed(BOT_SHAPES, ['hexagon', 'blobatar', 'circle'].map(canonicalShape))).toBe('pebble')
  })

  it('ne propose que des couleurs hexadécimales et des formes que les trois apps dessinent', () => {
    for (const color of BOT_COLORS) expect(color.value).toMatch(/^#[0-9A-F]{6}$/)
    expect(BOT_SHAPES).toEqual(['blob', 'pebble', 'squircle', 'round', 'hex', 'wedge', 'cloud', 'teardrop'])
  })
})

/** The gateway as `profiles.create`, `profiles.list`, `profiles.configure` and `setup.runtime_check` answer. */
function fakeGateway(options: { create?: (params: Json) => unknown; listedAfter?: number; configure?: () => unknown; runtime?: () => unknown } = {}) {
  const profiles: Json[] = [{ name: 'default', is_default: true }, { name: 'nova', ui_meta: {} }]
  const calls: [string, Json][] = []
  let lists = 0
  const request = vi.fn(async (method: string, params: Json = {}) => {
    calls.push([method, structuredClone(params)])
    if (method === 'profiles.create') {
      const answer = options.create?.(params)
      if (answer instanceof Error) throw answer
      profiles.push({ name: params.name, ui_meta: {}, ui_meta_revisions: {} })
      return { ok: true, name: params.name }
    }
    if (method === 'profiles.list') {
      lists += 1
      const hidden = options.listedAfter !== undefined && lists <= options.listedAfter
      return { profiles: structuredClone(profiles.filter((row) => !(hidden && row.name === 'lea-martin'))) }
    }
    if (method === 'profiles.configure') {
      const answer = options.configure?.()
      if (answer instanceof Error) throw answer
      if (answer) return answer
      const row = profiles.find((item) => item.name === params.name)!
      row.ui_meta = { ...(row.ui_meta as Json), ...(params.ui_meta as Json) }
      return { ok: true, applied: { ui_meta: true, ui_meta_revisions: { [BOT_CARD_KEY]: 1 } } }
    }
    if (method === 'setup.runtime_check') {
      const answer = options.runtime?.()
      if (answer instanceof Error) throw answer
      return answer ?? { ok: true }
    }
    throw new Error(`unexpected ${method}`)
  })
  return { client: { request }, calls, profiles }
}

const draft: BotDraft = { title: 'Léa Martin', slug: 'lea-martin', color: '#3FA66B', shape: 'cloud' }
const noWait = () => Promise.resolve()

describe('création d’un bot', () => {
  it('crée le profil comme Hermes Desktop, écrit sa fiche, puis demande si un modèle peut le servir', async () => {
    const gateway = fakeGateway()
    const created = await createBot(gateway.client, draft, { wait: noWait, now: () => 1_700 })
    expect(created).toEqual({ slug: 'lea-martin', cardError: null, modelIssue: null, listed: true })
    expect(gateway.calls.map(([method]) => method)).toEqual(['profiles.create', 'profiles.list', 'profiles.list', 'profiles.configure', 'setup.runtime_check'])
    const [, params] = gateway.calls[0]
    expect(params).toEqual(createProfileParams(draft))
    expect(params).toMatchObject({ name: 'lea-martin', share_auth: true, no_skills: false })
    // A fresh profile: bundled skills, launch credentials and model; never a copy of another bot's memory.
    expect(params).not.toHaveProperty('clone_from')
    expect(params.soul).toContain('# Léa Martin')
    expect(params.soul).toContain('profile `lea-martin`')
    expect(gateway.calls[3][1]).toEqual({
      name: 'lea-martin',
      ui_meta: { [BOT_CARD_KEY]: { title: 'Léa Martin', shape: 'cloud', color: '#3FA66B', imageKind: 'shape', created: 1_700 } },
      ui_meta_expected_revisions: { [BOT_CARD_KEY]: 0 },
    })
    expect(gateway.calls[4][1]).toEqual({ profile: 'lea-martin' })
  })

  it('attend que Hermes liste le nouveau profil avant d’écrire sa fiche', async () => {
    const gateway = fakeGateway({ listedAfter: 2 })
    const wait = vi.fn(noWait)
    const created = await createBot(gateway.client, draft, { wait })
    expect(created.listed).toBe(true)
    expect(created.cardError).toBeNull()
    expect(wait).toHaveBeenCalledTimes(2)
  })

  it('garde le bot créé quand sa fiche ne peut pas être écrite', async () => {
    const gateway = fakeGateway({ configure: () => new HermesRpcError('unknown method: profiles.configure', {}, -32601) })
    const created = await createBot(gateway.client, draft, { wait: noWait })
    expect(created.cardError?.reason).toBe('unsupported')
    expect(created.slug).toBe('lea-martin')
    expect(gateway.calls.at(-1)?.[0]).toBe('setup.runtime_check')
  })

  it('dit quand aucun modèle ne peut encore le servir, et passe outre une réponse inconnue', async () => {
    const refused = fakeGateway({ runtime: () => ({ ok: false, error: 'No usable credentials found.' }) })
    expect((await createBot(refused.client, draft, { wait: noWait })).modelIssue).toBe('No usable credentials found.')
    const unknown = fakeGateway({ runtime: () => new HermesRpcError('unknown method', {}, -32601) })
    expect((await createBot(unknown.client, draft, { wait: noWait })).modelIssue).toBeNull()
  })

  it('distingue un nom pris d’un nom gardé par un bot supprimé d’ici', async () => {
    const taken = fakeGateway({ create: () => new HermesRpcError("A profile named 'nova' already exists.", {}, 4062) })
    await expect(createBot(taken.client, { ...draft, slug: 'nova' }, { wait: noWait })).rejects.toMatchObject({ reason: 'taken' })
    const removed = fakeGateway({ create: () => new HermesRpcError("A profile named 'atlas' already exists.", {}, 4062) })
    removed.profiles.push({ name: 'atlas', ui_meta: { [REMOVED_KEY]: { removed_at: '2026-11-13T10:00:00.000Z', card: null } } })
    await expect(createBot(removed.client, { ...draft, slug: 'atlas' }, { wait: noWait })).rejects.toMatchObject({ reason: 'removed' })
    const other = fakeGateway({ create: () => new HermesRpcError('a running gateway still owns it', {}, 4062) })
    await expect(createBot(other.client, draft, { wait: noWait })).rejects.toMatchObject({ reason: 'refused', message: 'a running gateway still owns it' })
    // Nothing more after a refused creation: no card, no check.
    expect(other.calls.map(([method]) => method)).toEqual(['profiles.create', 'profiles.list'])
  })

  it('dit qu’une gateway trop ancienne ne sait pas créer de bot, et qu’une gateway muette n’a pas répondu', async () => {
    const old = fakeGateway({ create: () => new HermesRpcError('unknown method: profiles.create', {}, -32601) })
    await expect(createBot(old.client, draft, { wait: noWait })).rejects.toMatchObject({ reason: 'unsupported' })
    const silent = fakeGateway({ create: () => new Error('Connection closed') })
    await expect(createBot(silent.client, draft, { wait: noWait })).rejects.toMatchObject({ reason: 'offline' })
    const failed = fakeGateway({ create: () => new HermesRpcError('disk full', {}, 5062) })
    await expect(createBot(failed.client, draft, { wait: noWait })).rejects.toMatchObject({ reason: 'refused' })
  })

  it('a un message lisible pour chaque échec', () => {
    expect(botCreateErrorText(new BotCreateError('removed'), 'atlas')).toContain('hermes profile delete atlas')
    expect(botCreateErrorText(new BotCreateError('refused', 'disk full'), 'x')).toContain('disk full')
    expect(botCreateErrorText(new BotCreateError('unsupported'), 'x')).toContain('profiles.create')
    expect(botCreateErrorText(new Error('?'), 'x')).toBe(botCreateErrorText(new BotCreateError('offline'), 'x'))
  })
})

describe('le bot créé dans le roster', () => {
  it('apparaît tout de suite, sans section, avec son apparence, même si Hermes ne le liste pas encore', () => {
    const entry = createdBotEntry(draft, new Date(1_000))
    expect(entry).toMatchObject({ slug: 'lea-martin', name: 'Léa Martin', sectionId: UNASSIGNED_SECTION_ID, status: 'idle', unread: 0, hidden: false, avatar: { shape: 'cloud', color: '#3FA66B' } })
    const roster = [createdBotEntry({ ...draft, slug: 'nova', title: 'Nova' })]
    expect(withCreatedBot(roster, entry).map((bot) => bot.slug)).toEqual(['nova', 'lea-martin'])
    const listed = withCreatedBot([...roster, { ...entry, name: 'Léa (Hermes)' }], entry)
    expect(listed.map((bot) => bot.name)).toEqual(['Nova', 'Léa (Hermes)'])
  })
})
