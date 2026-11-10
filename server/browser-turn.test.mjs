import { describe, expect, it } from 'vitest'
import { parseBrowserTurn } from './browser-turn.mjs'

describe('propriétaire du Chrome partagé', () => {
  it('lit seulement le propriétaire de la première ligne', () => {
    expect(parseBrowserTurn('tour : vega 2026-01-05T10:00:00+0000 pid=4242 depuis 12 min\nen file : 1\n  1. iris\n')).toBe('vega')
  })

  it('reconnaît un navigateur libre ou un ancien verrou anonyme', () => {
    expect(parseBrowserTurn('tour : libre\nen file : 0')).toBe('')
    expect(parseBrowserTurn('tour : ? (ancien verrou sans owner) depuis 2 min')).toBe('')
  })
})
