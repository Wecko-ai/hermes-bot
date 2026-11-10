import { describe, expect, it } from 'vitest'
import { buildResources, resolveLanguage, resources } from './index'

/** Every leaf key of a catalog, as `a.b.c`. */
function keys(value: unknown, prefix = ''): string[] {
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, child]) => keys(child, prefix ? `${prefix}.${key}` : key))
  return [prefix]
}

describe('traduction', () => {
  it('a les mêmes clés en anglais et en français, sans texte vide', () => {
    const en = keys(resources.en?.translation ?? {}).sort()
    const fr = keys(resources.fr?.translation ?? {}).sort()
    expect(fr).toEqual(en)
    const empty = (catalog: unknown) => keys(catalog).filter((key) => {
      const text = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], catalog)
      return typeof text !== 'string' || !text.trim()
    })
    expect(empty(resources.en?.translation ?? {})).toEqual([])
    expect(empty(resources.fr?.translation ?? {})).toEqual([])
  })

  it('refuse une clé définie dans deux fichiers', () => {
    expect(() => buildResources({ './locales/en/a.json': { x: 'a' }, './locales/en/b.json': { x: 'b' } })).toThrow('defined twice')
  })

  it('suit la langue du système : français s’il est français, anglais sinon', () => {
    expect(resolveLanguage('system', ['fr-FR', 'en-US'])).toBe('fr')
    expect(resolveLanguage('system', ['en-GB', 'fr-FR'])).toBe('fr')
    expect(resolveLanguage('system', ['de-DE'])).toBe('en')
    expect(resolveLanguage('system', [])).toBe('en')
    expect(resolveLanguage('en', ['fr-FR'])).toBe('en')
    expect(resolveLanguage('fr', ['en-US'])).toBe('fr')
  })
})
