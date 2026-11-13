import { describe, expect, it } from 'vitest'
import { normalizeHref } from './links'

describe('normalizeHref', () => {
  it('adds https to an address written without a scheme', () => {
    expect(normalizeHref('www.example.com/x')).toBe('https://www.example.com/x')
    expect(normalizeHref('example.com/path?a=1#top')).toBe('https://example.com/path?a=1#top')
    expect(normalizeHref('docs.example.io')).toBe('https://docs.example.io')
    expect(normalizeHref('example.com:8080/x')).toBe('https://example.com:8080/x')
    expect(normalizeHref('//cdn.example.com/a')).toBe('https://cdn.example.com/a')
  })

  it('leaves links with a scheme, hash links, mentions and mail alone', () => {
    for (const href of ['https://example.com', 'http://example.com/a', 'mailto:a@example.com', 'tel:+33123', '#media:2', '#section', 'hermes-mention:iris', 'file:///tmp/a.md']) {
      expect(normalizeHref(href)).toBe(href)
    }
  })

  it('never turns a local path or a file name into a web link', () => {
    for (const href of ['/Users/test/notes.md', './notes.md', '../a/b.html', '~/projects/a.md', 'notes.md', 'build.sh', 'src/lib/a.ts', 'README.md', 'docs/index.html']) {
      expect(normalizeHref(href)).toBe(href)
    }
  })

  it('passes through an empty or missing href', () => {
    expect(normalizeHref(undefined)).toBeUndefined()
    expect(normalizeHref('')).toBe('')
  })
})
