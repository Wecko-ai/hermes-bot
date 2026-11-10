import { describe, expect, it } from 'vitest'
import { parseBrowserOwners, parseBrowserTurn } from './browser-turn.mjs'

describe('propriétaire du Chrome partagé', () => {
  it('lit seulement le propriétaire de la première ligne', () => {
    expect(parseBrowserTurn('tour : vega 2026-01-05T10:00:00+0000 pid=4242 depuis 12 min\nen file : 1\n  1. iris\n')).toBe('vega')
  })

  it('reconnaît un navigateur libre ou un ancien verrou anonyme', () => {
    expect(parseBrowserTurn('tour : libre\nen file : 0')).toBe('')
    expect(parseBrowserTurn('tour : ? (ancien verrou sans owner) depuis 2 min')).toBe('')
  })

  it('lit un propriétaire par équipe dans le nouveau format', () => {
    const output = 'tour[commun] : libre\nen file[commun] : 0\ntour[direction] : orion 2026-11-10T14:20:00+0000 pid=123 depuis 3 min\nen file[direction] : 1\n  1. iris\ntour[studio] : nova 2026-11-10T14:21:00+0000 pid=9 depuis 1 min\nen file[studio] : 0\n'
    expect(parseBrowserOwners(output)).toEqual(['orion', 'nova'])
    expect(parseBrowserTurn(output)).toBe('orion')
    expect(parseBrowserOwners('tour[commun] : libre\nen file[commun] : 0')).toEqual([])
    expect(parseBrowserTurn('tour[commun] : libre\ntour[direction] : vega depuis 1 min')).toBe('vega')
  })

  it('garde l’ancien format sur une seule ligne', () => {
    expect(parseBrowserOwners('tour : vega 2026-01-05T10:00:00+0000 pid=1 depuis 2 min\nen file : 0')).toEqual(['vega'])
    expect(parseBrowserOwners('tour : libre')).toEqual([])
    expect(parseBrowserOwners('')).toEqual([])
  })
})
