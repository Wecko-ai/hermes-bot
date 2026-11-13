import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../types'
import { botActionError, runBotAction, type BotActionContext } from './bot-actions'
import { BOT_CARD_KEY, BotManageError, REMOVED_KEY } from './bot-manage'
import { getSettings, updateSettings } from './settings'

const bot: Bot = {
  slug: 'orion', sessionId: 'chat-orion', name: 'Orion', role: '', section: 'Build', sectionId: 'sec-build', model: 'm',
  status: 'idle', preview: '', timestamp: '2026-11-13T10:00:00.000Z', unread: 2, hidden: false,
}

function context(client: BotActionContext['client']) {
  return { client, patchBot: vi.fn(), dropBot: vi.fn(), refresh: vi.fn(async () => undefined) }
}

function gateway() {
  const writes: Record<string, unknown>[] = []
  const request = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'profiles.list') return { profiles: [{ name: 'orion', ui_meta: { [BOT_CARD_KEY]: { title: 'Orion' } }, ui_meta_revisions: { [BOT_CARD_KEY]: 1 } }] }
    writes.push(params)
    return { ok: true, applied: { ui_meta: true } }
  })
  return { client: { request }, writes }
}

describe('actions du menu d’un bot', () => {
  beforeEach(() => updateSettings({ pinnedBots: [] }))

  it('épingle et désépingle sur ce Mac seulement, sans appel à Hermes', async () => {
    const { client } = gateway()
    await runBotAction(bot, { type: 'pin' }, context(client))
    expect(getSettings().pinnedBots).toEqual(['orion'])
    await runBotAction(bot, { type: 'unpin' }, context(client))
    expect(getSettings().pinnedBots).toEqual([])
    expect(client.request).not.toHaveBeenCalled()
  })

  it('marque comme lu sur place, sans écrire chez Hermes', async () => {
    const { client } = gateway()
    const ctx = context(client)
    await runBotAction(bot, { type: 'markRead' }, ctx)
    expect(ctx.patchBot).toHaveBeenCalledWith('orion', { unread: 0, seenAt: bot.timestamp })
    expect(client.request).not.toHaveBeenCalled()
    expect(ctx.refresh).not.toHaveBeenCalled()
  })

  it('écrit la carte, montre le changement, puis relit le roster', async () => {
    const { client, writes } = gateway()
    const ctx = context(client)
    await runBotAction(bot, { type: 'move', section: { id: 'sec-home', name: 'Home' } }, ctx)
    expect(writes[0]).toMatchObject({ name: 'orion', ui_meta: { [BOT_CARD_KEY]: { title: 'Orion', sectionId: 'sec-home', sectionName: 'Home' } } })
    expect(ctx.patchBot).toHaveBeenCalledWith('orion', { section: 'Home', sectionId: 'sec-home' })
    expect(ctx.refresh).toHaveBeenCalledOnce()
  })

  it('supprime : marque le profil, retire le bot de la liste et de ses épingles', async () => {
    updateSettings({ pinnedBots: ['nova', 'orion'] })
    const { client, writes } = gateway()
    const ctx = context(client)
    await runBotAction(bot, { type: 'delete' }, ctx)
    expect(Object.keys(writes[0].ui_meta as object)).toEqual([BOT_CARD_KEY, REMOVED_KEY])
    expect(ctx.dropBot).toHaveBeenCalledWith('orion')
    expect(getSettings().pinnedBots).toEqual(['nova'])
  })

  it('ne touche à rien à l’écran quand Hermes refuse', async () => {
    const ctx = context({ request: vi.fn(async () => { throw new Error('Hermes déconnecté') }) })
    await expect(runBotAction(bot, { type: 'hide' }, ctx)).rejects.toMatchObject({ reason: 'offline' })
    expect(ctx.patchBot).not.toHaveBeenCalled()
    expect(ctx.refresh).not.toHaveBeenCalled()
  })

  it('en démo, change seulement le roster à l’écran', async () => {
    const ctx = context(null)
    await runBotAction(bot, { type: 'rename', title: ' Orion Prime ' }, ctx)
    expect(ctx.patchBot).toHaveBeenCalledWith('orion', { name: 'Orion Prime' })
    await runBotAction(bot, { type: 'delete' }, ctx)
    expect(ctx.dropBot).toHaveBeenCalledWith('orion')
    expect(ctx.refresh).not.toHaveBeenCalled()
  })

  it('donne un message lisible pour chaque échec', () => {
    expect(botActionError(new BotManageError('refused', 'profile locked'))).toContain('profile locked')
    for (const reason of ['unsupported', 'not_found', 'conflict', 'rejected', 'offline'] as const) {
      expect(botActionError(new BotManageError(reason))).not.toContain('botMenu.')
    }
    expect(botActionError(new Error('x'))).not.toContain('botMenu.')
  })
})
