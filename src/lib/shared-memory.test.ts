import { describe, expect, it } from 'vitest'
import { sharedMemoryApiText } from './shared-memory'

describe('shared memory client', () => {
  it('ajoute la note partagée à api_text', () => {
    expect(sharedMemoryApiText('hello', '[note]')).toBe('hello\n\n[note]')
    expect(sharedMemoryApiText(undefined, '')).toBeUndefined()
  })
})