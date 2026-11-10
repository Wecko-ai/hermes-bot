import { describe, expect, it } from 'vitest'
import { LOCAL_CHAT_SLUG, chooseLocalModel, localChatBot, localModelLabel, readLocalChatFrames, visibleAnswer } from './local-chat'

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

  it('nomme le modèle sans son étiquette latest ni son dépôt', () => {
    expect(localModelLabel('qwen3:8b')).toBe('qwen3 8b')
    expect(localModelLabel('library/llama3.2:latest')).toBe('llama3.2')
    expect(localChatBot('qwen3:8b').name).toBe('qwen3 8b')
    expect(localChatBot('qwen3:8b', 'Mon modèle').name).toBe('Mon modèle')
  })

  it('choisit le modèle des réglages, puis celui de la configuration, puis le premier installé', () => {
    const local = { available: true, models: ['a:1b', 'b:7b', 'c:3b'], defaultModel: 'b:7b' }
    expect(chooseLocalModel(local, 'c:3b')).toBe('c:3b')
    expect(chooseLocalModel(local, 'absent')).toBe('b:7b')
    expect(chooseLocalModel({ ...local, defaultModel: 'absent' }, '')).toBe('a:1b')
    expect(chooseLocalModel({ ...local, available: false }, 'c:3b')).toBe('')
    expect(chooseLocalModel({ available: true, models: [], defaultModel: '' }, '')).toBe('')
    expect(chooseLocalModel(null, '')).toBe('')
  })

  it('utilise un profil refusé par la route des médias', () => {
    expect(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(LOCAL_CHAT_SLUG)).toBe(false)
  })
})
