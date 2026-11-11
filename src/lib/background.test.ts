import { describe, expect, it, vi } from 'vitest'
import type { Bot } from '../types'
import { HermesRpcError, type HermesClient } from './hermes'
import { backgroundSummary, effectiveStatus, loadBackgroundWork, loadChatBackground, loadSubagentTail, mergeBackground, runningProcesses } from './background'
import { mergeRoster } from './activity'
import { avatarPhase } from '../components/LiveAvatar'

const bot = (status: Bot['status'], background?: Bot['background']): Bot => ({
  slug: 'orion', name: 'Orion', role: '', section: '', sectionId: '', model: '', status,
  preview: '', timestamp: null, unread: 0, hidden: false, background,
})

// Simulated gateway: each method answers from this table, an Error is thrown as is.
type Params = Record<string, unknown>
function gateway(answers: Record<string, unknown | ((params: Params) => unknown)>, generation = 1) {
  const request = vi.fn(async (method: string, params: Params) => {
    const answer = answers[method]
    const value = typeof answer === 'function' ? (answer as (params: Params) => unknown)(params) : answer
    if (value instanceof Error) throw value
    if (value === undefined) throw new HermesRpcError(`unknown ${method}`, {}, 4000)
    return value
  })
  return { client: { request, generation } as unknown as HermesClient, request }
}

const unknownMethod = () => new HermesRpcError('unknown method', { reason: 'unknown_method' }, -32601)

describe('statut en veille', () => {
  it('passe en veille sans tour quand des sous-agents ou des processus tournent', () => {
    expect(effectiveStatus(bot('idle', { subagents: 1, processes: 0 }))).toBe('standby')
    expect(effectiveStatus(bot('idle', { subagents: 0, processes: 2 }))).toBe('standby')
    // Work left running is not “done”.
    expect(effectiveStatus(bot('done', { subagents: 0, processes: 1 }))).toBe('standby')
  })

  it('laisse la priorité au travail, à une question et au blocage', () => {
    const work = { subagents: 3, processes: 1 }
    for (const status of ['working', 'thinking', 'waiting', 'blocked'] as const) expect(effectiveStatus(bot(status, work))).toBe(status)
    expect(avatarPhase(bot('working', work))).toBe('working')
  })

  it('revient au repos quand plus rien ne tourne', () => {
    expect(effectiveStatus(bot('idle'))).toBe('idle')
    expect(effectiveStatus(bot('idle', { subagents: 0, processes: 0 }))).toBe('idle')
    expect(effectiveStatus(bot('done'))).toBe('done')
    expect(effectiveStatus(bot('standby'))).toBe('idle')
  })

  it('a sa propre phase d’avatar, jamais animée comme le travail', () => {
    expect(avatarPhase(bot('idle', { subagents: 1, processes: 0 }))).toBe('standby')
    expect(avatarPhase(bot('done'))).toBe('done')
    expect(avatarPhase(bot('idle'))).toBe('idle')
  })

  it('dit au survol ce qui tourne encore', () => {
    expect(backgroundSummary({ subagents: 2, processes: 1 })).toBe('2 sous-agents · 1 processus en arrière-plan')
    expect(backgroundSummary({ subagents: 1, processes: 0 })).toBe('1 sous-agent')
    expect(backgroundSummary({ subagents: 0, processes: 3 })).toBe('3 processus en arrière-plan')
    expect(backgroundSummary(undefined)).toBe('')
  })

  it('garde le plus grand compte des deux lectures, champ par champ', () => {
    expect(mergeBackground({ subagents: 2, processes: 0 }, { subagents: 1, processes: 1 })).toEqual({ subagents: 2, processes: 1 })
    expect(mergeBackground(undefined, { subagents: 1, processes: 0 })).toEqual({ subagents: 1, processes: 0 })
  })

  it('garde les comptes à la relecture du roster, qui ne les porte pas', () => {
    const before = [bot('idle', { subagents: 1, processes: 0 })]
    expect(mergeRoster(before, [bot('idle')], '', () => false)[0].background).toEqual({ subagents: 1, processes: 0 })
  })
})

describe('subagent.roster', () => {
  it('additionne les conversations du profil et ne demande que ce profil', async () => {
    const { client, request } = gateway({
      'subagent.roster': (params: Params) => params.profile === 'orion'
        ? { sessions: [{ session_id: 'chat-orion', subagents: 1, background: 2 }, { session_id: 'cron-1', subagents: 0, background: 1 }] }
        : { sessions: [] },
    })
    const { counts, answered } = await loadBackgroundWork(client, ['orion', 'nova'])
    expect(counts.get('orion')).toEqual({ subagents: 1, processes: 3 })
    expect(counts.get('nova')).toEqual({ subagents: 0, processes: 0 })
    expect([...answered].sort()).toEqual(['nova', 'orion'])
    expect(request.mock.calls.map(([method, params]) => [method, params])).toEqual([
      ['subagent.roster', { profile: 'orion' }],
      ['subagent.roster', { profile: 'nova' }],
    ])
  })

  it('laisse les derniers comptes d’un profil qui ne répond pas', async () => {
    const { client } = gateway({ 'subagent.roster': (params: Params) => params.profile === 'nova' ? new Error('timeout') : { sessions: [] } })
    const { answered } = await loadBackgroundWork(client, ['orion', 'nova'])
    expect([...answered]).toEqual(['orion'])
  })

  it('ne redemande pas une méthode inconnue sur la même connexion, mais réessaie sur la suivante', async () => {
    const answers = { 'subagent.roster': unknownMethod() }
    const first = gateway(answers)
    await loadBackgroundWork(first.client, ['orion'])
    await loadBackgroundWork(first.client, ['orion'])
    expect(first.request).toHaveBeenCalledTimes(1)
    ;(first.client as unknown as { generation: number }).generation = 2
    await loadBackgroundWork(first.client, ['orion'])
    expect(first.request).toHaveBeenCalledTimes(2)
  })
})

describe('conversation ouverte : process.list et subagent.list', () => {
  const chat = { profile: 'orion', sessionId: 'chat-orion' }

  it('ne compte que les processus en cours', () => {
    expect(runningProcesses({ processes: [
      { session_id: 'proc_1', status: 'running' },
      { session_id: 'proc_2', status: 'exited', exit_code: 0 },
      { session_id: 'proc_3' },
    ] })).toBe(2)
    expect(runningProcesses({})).toBe(0)
  })

  it('n’envoie que profile et session_id : la gateway refuse toute autre clé', async () => {
    const { client, request } = gateway({
      'process.list': { processes: [{ session_id: 'proc_1', command: 'npm run dev', status: 'running' }, { session_id: 'proc_2', status: 'exited' }] },
      'subagent.list': { subagents: [{ subagent_id: 'sa-1', goal: 'Relire le plan', status: 'running', started_at: 1_700_000_000.5, tool_count: 3, last_tool: 'read_file', depth: 0 }], delegations: [] },
    })
    const result = await loadChatBackground(client, chat)
    expect(result.processes).toBe(1)
    expect(result.subagents).toEqual([{ id: 'sa-1', goal: 'Relire le plan', status: 'running', startedAt: 1_700_000_000_500, toolCount: 3, lastTool: 'read_file', model: undefined, depth: 0 }])
    for (const [, params] of request.mock.calls) expect(params).toEqual({ profile: 'orion', session_id: 'chat-orion' })
  })

  it('garde une lecture quand l’autre échoue (session pas encore attachée)', async () => {
    const { client } = gateway({
      'process.list': new HermesRpcError('not_found', { reason: 'not_found' }),
      'subagent.list': { subagents: [] },
    })
    expect(await loadChatBackground(client, chat)).toEqual({ processes: undefined, subagents: [] })
  })

  it('lit la fin du journal d’un sous-agent à la demande', async () => {
    const { client, request } = gateway({ 'subagent.tail': { subagent_id: 'sa-1', available: true, text: '…dernière ligne', truncated: true } })
    expect(await loadSubagentTail(client, chat, 'sa-1')).toEqual({ available: true, text: '…dernière ligne', truncated: true })
    expect(request).toHaveBeenCalledWith('subagent.tail', { profile: 'orion', session_id: 'chat-orion', subagent_id: 'sa-1' }, 10_000)
  })
})
