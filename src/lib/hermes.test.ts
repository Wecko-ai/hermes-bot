import { describe, expect, it, vi } from 'vitest'
import { HermesRpcError, loadModelOptions, loadRoster, switchModel, type ActiveChat, type HermesClient } from './hermes'

const chat: ActiveChat = {
  profile: 'orion',
  sessionId: 'chat-orion',
  revision: 4,
  executionGeneration: 2,
  running: false,
  socketGeneration: 1,
}

const option = { model: 'claude-sonnet-5-5', provider: 'anthropic' }

describe('roster', () => {
  it('retient la plus récente des activités du profil, sans toucher à la date du Bot Chat', async () => {
    const request = vi.fn().mockResolvedValue({ profiles: [{
      name: 'orion',
      ui_meta: { 'hermes-bots': { title: 'Orion' } },
      canonical_session: { id: 'chat', last_active: 1_000 },
      last_session: { id: 'autre', last_active: 2_000 },
      worker_session: { id: 'tache', last_active: 3_000 },
    }] })
    const { bots } = await loadRoster({ request } as unknown as HermesClient)
    expect(bots[0].lastActivity).toBe(3_000_000)
    expect(bots[0].timestamp).toBe(new Date(1_000_000).toISOString())
  })
})

describe('statut réel du roster', () => {
  const profile = { name: 'orion', ui_meta: { 'hermes-bots': { title: 'Orion' } }, canonical_session: { id: 'racine', resolved_id: 'chat', last_active: 1_000 } }
  const roster = (status: string | Error) => loadRoster({
    request: vi.fn(async (method: string) => {
      if (method === 'profiles.list') return { profiles: [profile] }
      if (status instanceof Error) throw status
      return { sessions: [{ id: 'vivant', session_key: 'chat', status }] }
    }),
  } as unknown as HermesClient)

  it('voit un tour de Bot Chat en cours et une attente de réponse', async () => {
    expect((await roster('working')).bots[0].status).toBe('working')
    expect((await roster('waiting')).bots[0].status).toBe('waiting')
    expect((await roster('idle')).bots[0].status).toBe('idle')
  })

  it('reste utilisable avec une gateway sans session.active_list', async () => {
    expect((await roster(new Error('unknown method'))).bots[0].status).toBe('idle')
  })
})

describe('changement de modèle', () => {
  it('utilise une mutation de session bornée, sans réécrire le profil', async () => {
    const request = vi.fn().mockResolvedValue({ session_id: 'chat-orion', revision: 5, execution_generation: 2 })
    const result = await switchModel({ request } as unknown as HermesClient, chat, option)

    expect(request).toHaveBeenCalledWith('session.mutate', expect.objectContaining({
      profile: 'orion',
      session_id: 'chat-orion',
      expected_revision: 4,
      expected_generation: 2,
      operation: 'model',
      payload: option,
    }))
    expect(result.revision).toBe(5)
  })

  it('réessaie une fois aux clôtures fournies par la gateway', async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new HermesRpcError('stale_generation', { reason: 'stale_generation', revision: 6, execution_generation: 3 }))
      .mockResolvedValueOnce({ session_id: 'chat-orion', revision: 7, execution_generation: 3 })
    await switchModel({ request } as unknown as HermesClient, chat, option)

    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[1][1]).toMatchObject({ expected_revision: 6, expected_generation: 3 })
    expect(request.mock.calls[1][1].request_id).not.toBe(request.mock.calls[0][1].request_id)
  })

  it('renvoie le jeton de confirmation dans la mutation suivante', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ status: 'confirmation_required', confirm: 'confirm-test', confirm_message: 'Confirmer ?' })
      .mockResolvedValueOnce({ session_id: 'chat-orion', revision: 5 })
    const client = { request } as unknown as HermesClient
    const first = await switchModel(client, chat, option)
    expect(first.confirm_required).toBe(true)

    await switchModel(client, chat, option, first.confirm)
    expect(request.mock.calls[1][1].payload).toEqual({ ...option, confirm: 'confirm-test' })
  })

  it('ne propose que les fournisseurs connectés', async () => {
    const request = vi.fn().mockResolvedValue({
      model: 'claude-opus-5-5',
      providers: [
        { slug: 'absent', name: 'Non connecté', authenticated: false, models: ['autre-modele'] },
        { slug: 'anthropic', name: 'Anthropic', authenticated: true, models: ['claude-opus-5-5'] },
      ],
    })
    const result = await loadModelOptions({ request } as unknown as HermesClient, 'orion', 'chat-orion')

    expect(result.options).toEqual([expect.objectContaining({ provider: 'anthropic', model: 'claude-opus-5-5' })])
  })
})
