import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../types'
import { setTeammateEnabled } from './teammate'
import { stepIds } from './turns'

const user = (id: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, role: 'user', content: 'Fais-le.', createdAt: null, ...extra })
const say = (id: string, content = 'Texte.'): ChatMessage => ({ id, role: 'assistant', content, createdAt: null })
const tool = (id: string): ChatMessage => ({ id, role: 'tool', content: 'terminal', createdAt: null, technical: true })
const ids = (messages: ChatMessage[], running = false) => [...stepIds(messages, running, 'orion')].sort()

describe('étapes d’un tour', () => {
  it('garde l’accusé de réception et replie le texte écrit avant l’appel d’outil suivant', () => {
    const turn = [user('u1'), say('a1', 'Je regarde le code.'), tool('t1'), say('a2', 'Les tests maintenant.'), tool('t2'), tool('t3'), say('a3', 'C’est fait.')]
    expect(ids(turn)).toEqual(['a2'])
  })

  it('replie aussi la première phrase quand le mode coéquipier est coupé pour ce profil', () => {
    setTeammateEnabled('orion', false)
    const turn = [user('u1'), say('a1', 'Je regarde le code.'), tool('t1'), say('a2', 'Les tests maintenant.'), tool('t2'), say('a3', 'C’est fait.')]
    expect(ids(turn)).toEqual(['a1', 'a2'])
    setTeammateEnabled('orion', true)
  })

  it('pendant le tour, le dernier texte est encore une étape ; l’accusé reste visible', () => {
    const turn = [user('u1'), say('a1'), tool('t1'), say('a2')]
    expect(ids(turn, true)).toEqual(['a2'])
    expect(ids(turn, false)).toEqual([])
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
    expect(ids([user('u1'), say('a1', 'Je préviens Iris.'), sent, say('a2')])).toEqual([])
    expect(ids([user('u1'), say('a1', 'Je lis le dépôt en entier. Puis je compare les deux correctifs.'), sent, say('a2')])).toEqual(['a1'])
    expect(ids([user('u1'), say('a1', 'Réponse.'), received, say('a2')])).toEqual([])
  })

  it('ne replie ni une bulle de progression ni un accusé marqué', () => {
    const progress: ChatMessage = { id: 'p1', role: 'assistant', content: 'Les tests tournent.', createdAt: null, progress: true }
    const ack: ChatMessage = { id: 'k1', role: 'assistant', content: 'Je m’en occupe.', createdAt: null, ack: true }
    const turn = [user('u1'), ack, progress, tool('t1'), say('a2', 'C’est fait.')]
    expect(ids(turn, true)).toEqual([])
  })

  it('un message mis en file pendant le tour ne coupe pas ce tour', () => {
    const turn = [user('u1'), say('a1', 'Je lis le fichier. Puis je lance les tests.'), user('u2', { pending: true, delivery: 'queue' }), tool('t1'), say('a2')]
    expect(ids(turn)).toEqual(['a1'])
  })
})
