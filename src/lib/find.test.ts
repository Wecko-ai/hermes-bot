import { describe, expect, it } from 'vitest'
import { findMatches } from './find'

describe('findMatches', () => {
  it('finds every occurrence, ignoring case', () => {
    expect(findMatches('Alpha beta ALPHA alpha', 'alpha')).toEqual([[0, 5], [11, 16], [17, 22]])
  })

  it('ignores accents in both directions and keeps offsets in the original text', () => {
    expect(findMatches('Écoute: ecole, école', 'ecole')).toEqual([[8, 13], [15, 20]])
    expect(findMatches('cafe', 'café')).toEqual([[0, 4]])
  })

  it('does not overlap and returns nothing for an empty query', () => {
    expect(findMatches('aaaa', 'aa')).toEqual([[0, 2], [2, 4]])
    expect(findMatches('abc', '  ')).toEqual([])
  })
})
