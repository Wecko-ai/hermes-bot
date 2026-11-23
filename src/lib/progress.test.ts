import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../types'
import { progressBubbleText, shouldRecordProgress, threadItems } from './progress'

const say = (id: string, content: string, progress = false): ChatMessage => ({ id, role: 'assistant', content, createdAt: null, ...(progress ? { progress: true } : {}) })
const user = (id: string): ChatMessage => ({ id, role: 'user', content: 'Go', createdAt: null })

describe('progress bubbles', () => {
  it('shortens interim text for a bubble', () => {
    expect(progressBubbleText('Je vérifie les fichiers. Ensuite je corrige.')).toBe('Je vérifie les fichiers.')
  })

  it('skips silent markers', () => {
    expect(shouldRecordProgress('NOREPLY')).toBe(false)
    expect(shouldRecordProgress('Je commence.')).toBe(true)
  })

  it('groups progress lines under the final assistant reply', () => {
    const messages = [user('u1'), say('p1', 'Je regarde.', true), say('p2', 'J’écris les tests.', true), say('a1', 'Terminé.')]
    const items = threadItems(messages, false, 'orion', true)
    expect(items).toHaveLength(2)
    expect(items[0]).toEqual({ kind: 'message', message: messages[0] })
    expect(items[1].kind).toBe('turn')
    if (items[1].kind === 'turn') {
      expect(items[1].progress.map((item) => item.id)).toEqual(['p1', 'p2'])
      expect(items[1].answer?.id).toBe('a1')
      expect(items[1].collapsed).toBe(true)
    }
  })
})