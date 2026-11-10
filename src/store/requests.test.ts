import { beforeEach, describe, expect, it } from 'vitest'
import type { PendingPrompt, ServerRequest } from '../lib/hermes'
import { addPrompt, addServerRequest, clearSessionPrompts, replaceSessionPrompts, resetRequestsStore, settlePrompt, useRequestsStore } from './requests'

const prompt = (sessionId: string, promptId: string): PendingPrompt => ({
  sessionId, promptId, kind: 'clarify', generation: 1, question: 'Lequel ?', choices: [], multiSelect: false, command: '', description: '',
})

describe('demandes en attente', () => {
  beforeEach(resetRequestsStore)

  it('n’ajoute pas deux fois la même question', () => {
    const first = prompt('s1', 'p1')
    const list = addPrompt([], first)
    expect(addPrompt(list, prompt('s1', 'p1'))).toBe(list)
    expect(addPrompt(list, prompt('s1', 'p2'))).toHaveLength(2)
  })

  it('retire une question réglée par session et promptId, pas par promptId seul', () => {
    const list = [prompt('s1', 'p1'), prompt('s2', 'p1'), prompt('s1', 'p2')]
    expect(settlePrompt(list, 's1', 'p1').map((item) => `${item.sessionId}/${item.promptId}`)).toEqual(['s2/p1', 's1/p2'])
  })

  it('un tour fini vide sa session et garde la même liste s’il n’y avait rien', () => {
    const list = [prompt('s1', 'p1'), prompt('s2', 'p2')]
    expect(clearSessionPrompts(list, 's1').map((item) => item.promptId)).toEqual(['p2'])
    expect(clearSessionPrompts(list, 's3')).toBe(list)
  })

  it('remplace les questions d’une session par celles de la gateway, sans toucher aux autres', () => {
    const list = [prompt('s1', 'old'), prompt('s2', 'p2')]
    expect(replaceSessionPrompts(list, 's1', [prompt('s1', 'new')]).map((item) => item.promptId)).toEqual(['p2', 'new'])
  })

  it('dédoublonne les requêtes serveur par identifiant', () => {
    const request: ServerRequest = { id: 'r1', method: 'approval', params: {} }
    const list = addServerRequest([], request)
    expect(addServerRequest(list, { ...request })).toBe(list)
  })

  it('le store applique ces actions', () => {
    const { addPrompt: add, settlePrompt: settle, removePrompt, clearSessionPrompts: clear, addServerRequest: addRequest, removeServerRequest } = useRequestsStore.getState()
    add(prompt('s1', 'p1'))
    add(prompt('s1', 'p1'))
    add(prompt('s2', 'p2'))
    expect(useRequestsStore.getState().prompts).toHaveLength(2)
    settle('s1', 'p1')
    expect(useRequestsStore.getState().prompts.map((item) => item.promptId)).toEqual(['p2'])
    removePrompt('p2')
    expect(useRequestsStore.getState().prompts).toEqual([])
    const before = useRequestsStore.getState().prompts
    clear('s9')
    expect(useRequestsStore.getState().prompts).toBe(before)
    addRequest({ id: 'r1', method: 'approval', params: {} })
    removeServerRequest('r1')
    expect(useRequestsStore.getState().serverRequests).toEqual([])
  })

  it('les demandes du coffre se remplacent en bloc puis se retirent une à une', () => {
    const { setBrowserVaultRequests, removeBrowserVaultRequest } = useRequestsStore.getState()
    const base = { kind: 'save' as const, bot: 'a', origin: 'https://x', busy: false, createdAt: '' }
    setBrowserVaultRequests([{ ...base, id: 'v1' }, { ...base, id: 'v2' }])
    removeBrowserVaultRequest('v1')
    expect(useRequestsStore.getState().browserVaultRequests.map((item) => item.id)).toEqual(['v2'])
  })
})
