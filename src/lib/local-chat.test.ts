import { describe, expect, it } from 'vitest'
import { LOCAL_CHAT_SLUG, chooseLocalModel, formatBytes, localChatBot, localModelFacts, localModelLabel, parseLocalMemory, parseLocalModels, readLocalChatFrames, visibleAnswer } from './local-chat'

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

  it('lit les détails des modèles installés sans croire le serveur sur parole', () => {
    const local = parseLocalModels({
      available: true,
      models: ['exemple-27b:q4_k', 42, '', 'qwen3:4b'],
      details: { 'exemple-27b:q4_k': { size: 16810714518, parameters: '27.3B', quantization: 'Q4_K_M', family: 'qwen3' }, 'qwen3:4b': { size: 'gros' } },
      defaultModel: 'exemple-27b:q4_k',
    })
    expect(local.models).toEqual(['exemple-27b:q4_k', 'qwen3:4b'])
    expect(local.details?.['qwen3:4b']).toEqual({ size: 0, parameters: '', quantization: '', family: '' })
    expect(localModelFacts(local.details?.['exemple-27b:q4_k'])).toBe('27.3B · Q4_K_M · 16,8 Go')
    expect(localModelFacts(local.details?.['qwen3:4b'])).toBe('')
    expect(parseLocalModels(null)).toEqual({ available: false, models: [], details: {}, defaultModel: '' })
  })

  it('lit les modèles en mémoire', () => {
    const memory = parseLocalMemory({ available: true, loaded: [{ model: 'qwen3:4b', size: 3e9, vram: 3e9, expiresAt: '2026-11-16T15:02:00.000Z', context: 32768, kept: true }, { size: 1 }, null] })
    expect(memory).toEqual({ available: true, loaded: [{ model: 'qwen3:4b', size: 3e9, vram: 3e9, expiresAt: '2026-11-16T15:02:00.000Z', context: 32768, kept: true }] })
    expect(parseLocalMemory({ available: 'oui', loaded: 'x' })).toEqual({ available: false, loaded: [] })
  })

  it('écrit les tailles en Go ou en Mo', () => {
    expect(formatBytes(16810714518, 'en')).toBe('16.8 GB')
    expect(formatBytes(512e6, 'en')).toBe('512 MB')
    expect(formatBytes(0)).toBe('')
  })
})
