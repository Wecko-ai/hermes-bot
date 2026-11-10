import { describe, expect, it } from 'vitest'
import { LOCAL_CHAT_SLUG, readLocalChatFrames, visibleAnswer } from './local-chat'

describe('chat local', () => {
  it('garde une ligne coupée pour le morceau suivant', () => {
    const first = readLocalChatFrames('{"message":{"content":"Bon"},"done":false}\n{"message":{"cont')
    expect(first.frames).toEqual([{ content: 'Bon', thinking: '', done: false }])
    const second = readLocalChatFrames(`${first.rest}ent":"jour","thinking":"hm"},"done":true}\n`)
    expect(second.frames).toEqual([{ content: 'jour', thinking: 'hm', done: true }])
    expect(second.rest).toBe('')
  })

  it('ignore une ligne illisible sans perdre la suite', () => {
    expect(readLocalChatFrames('pas du json\n{"done":true}\n').frames).toEqual([{ content: '', thinking: '', done: true }])
  })

  it('retire le raisonnement, fini ou en cours', () => {
    expect(visibleAnswer('<think>je cherche</think>\n\nRéponse')).toBe('Réponse')
    expect(visibleAnswer('<think>je cherche encore')).toBe('')
    expect(visibleAnswer('Réponse simple')).toBe('Réponse simple')
  })

  it('utilise un profil refusé par la route des médias', () => {
    expect(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(LOCAL_CHAT_SLUG)).toBe(false)
  })
})
