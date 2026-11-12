import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../types'
import { stepIds } from './turns'

const user = (id: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, role: 'user', content: 'Fais-le.', createdAt: null, ...extra })
const say = (id: string, content = 'Texte.'): ChatMessage => ({ id, role: 'assistant', content, createdAt: null })
const tool = (id: string): ChatMessage => ({ id, role: 'tool', content: 'terminal', createdAt: null, technical: true })
const ids = (messages: ChatMessage[], running = false) => [...stepIds(messages, running, 'orion')].sort()

describe('étapes d’un tour', () => {
  it('replie le texte écrit avant un appel d’outil et garde la réponse finale', () => {
    const turn = [user('u1'), say('a1', 'Je regarde le code.'), tool('t1'), say('a2', 'Les tests maintenant.'), tool('t2'), tool('t3'), say('a3', 'C’est fait.')]
    expect(ids(turn)).toEqual(['a1', 'a2'])
  })

  it('pendant le tour, le dernier texte est encore une étape ; à la fin, c’est la réponse', () => {
    const turn = [user('u1'), say('a1'), tool('t1'), say('a2')]
    expect(ids(turn, true)).toEqual(['a1', 'a2'])
    expect(ids(turn, false)).toEqual(['a1'])
  })

  it('ne touche pas aux réponses de tours sans outil, ni au tour précédent quand un nouveau commence', () => {
    const turns = [user('u1'), say('a1'), user('u2'), say('a2')]
    expect(ids(turns)).toEqual([])
    expect(ids([...turns, user('u3')], true)).toEqual([])
  })

  it('garde une étape qui porte un fichier ou une carte de mail', () => {
    const turn = [user('u1'), say('a1', 'Voici la capture :\n\nMEDIA:/tmp/capture.png'), tool('t1'), say('a2', 'Brouillon :\n\n````hermes-mail\nId: 1\n````'), tool('t2'), say('a3')]
    expect(ids(turn)).toEqual([])
  })

  it('un message envoyé à un autre bot est un appel d’outil ; un message reçu ouvre un tour', () => {
    const sent: ChatMessage = { id: 'm1', role: 'system', content: 'Salut', createdAt: null, agent: { kind: 'message', from: 'orion', to: 'iris', text: 'Salut' } }
    const received: ChatMessage = { id: 'm2', role: 'system', content: 'Coucou', createdAt: null, agent: { kind: 'message', from: 'iris', to: 'orion', text: 'Coucou' } }
    expect(ids([user('u1'), say('a1', 'Je préviens Iris.'), sent, say('a2')])).toEqual(['a1'])
    expect(ids([user('u1'), say('a1', 'Réponse.'), received, say('a2')])).toEqual([])
  })

  it('un message mis en file pendant le tour ne coupe pas ce tour', () => {
    const turn = [user('u1'), say('a1'), user('u2', { pending: true, delivery: 'queue' }), tool('t1'), say('a2')]
    expect(ids(turn)).toEqual(['a1'])
  })
})
