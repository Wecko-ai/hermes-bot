import { describe, expect, it } from 'vitest'
import links from './links.cjs'

const { externalUrl } = links
const APP = 'http://127.0.0.1:4330'

describe('externalUrl', () => {
  it('lets web pages and mail drafts out', () => {
    expect(externalUrl('https://example.com/a?b=1#c', APP)).toBe('https://example.com/a?b=1#c')
    expect(externalUrl('http://staging.example.com/', APP)).toBe('http://staging.example.com/')
    // A local dashboard on another port is someone else's page, not the app's.
    expect(externalUrl('http://127.0.0.1:4321/projects', APP)).toBe('http://127.0.0.1:4321/projects')
    expect(externalUrl('http://localhost:3000', APP)).toBe('http://localhost:3000/')
    expect(externalUrl('mailto:someone@example.com?subject=Hi', APP)).toBe('mailto:someone@example.com?subject=Hi')
  })

  it('never lets the app’s own server out, whatever loopback name points at it', () => {
    expect(externalUrl('http://127.0.0.1:4330/api/media?path=x', APP)).toBeNull()
    expect(externalUrl('http://localhost:4330/', APP)).toBeNull()
    expect(externalUrl('http://[::1]:4330/', APP)).toBeNull()
    expect(externalUrl('http://127.1:4330/', APP)).toBeNull()
  })

  it('refuses every other scheme', () => {
    for (const url of [
      'file:///etc/hosts',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'blob:http://127.0.0.1:4330/1234',
      'vscode://file/etc/hosts',
      'ssh://example.com',
      'x-apple.systempreferences:com.apple.preference.security',
      'ftp://example.com/file',
    ]) expect(externalUrl(url, APP), url).toBeNull()
  })

  it('refuses what is not a usable URL', () => {
    expect(externalUrl('not a url', APP)).toBeNull()
    expect(externalUrl('/relative/path', APP)).toBeNull()
    expect(externalUrl('mailto:', APP)).toBeNull()
    expect(externalUrl(undefined, APP)).toBeNull()
  })
})
