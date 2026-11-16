import { describe, expect, it, vi } from 'vitest'
import navigation from './navigation.cjs'

const { PDF_VIEWER_PREFIX, allowsNavigation, guardNavigation } = navigation
const ORIGIN = 'http://127.0.0.1:4330'

const main = (url) => allowsNavigation(url, { isMainFrame: true, origin: ORIGIN })
const frame = (url) => allowsNavigation(url, { isMainFrame: false, origin: ORIGIN })

describe('navigation guard', () => {
  it('keeps the main frame on this app', () => {
    expect(main(`${ORIGIN}/`)).toBe(true)
    expect(main(`${ORIGIN}/index.html`)).toBe(true)
    expect(main(`${ORIGIN}/api/document?profile=a&path=%2Fx.pdf`)).toBe(true)
    expect(main('https://example.com/')).toBe(false)
    expect(main('http://127.0.0.1:4321/')).toBe(false)
    expect(main('http://localhost:4330/')).toBe(false)
    expect(main(`${PDF_VIEWER_PREFIX}index.html`)).toBe(false)
    expect(main('about:blank')).toBe(false)
  })

  it('lets a subframe load only the document route, the PDF viewer, and about:blank', () => {
    expect(frame(`${ORIGIN}/api/document?profile=a&path=%2Fnotes.html`)).toBe(true)
    expect(frame(`${ORIGIN}/api/document`)).toBe(true)
    expect(frame(`${PDF_VIEWER_PREFIX}index.html`)).toBe(true)
    expect(frame(`${PDF_VIEWER_PREFIX}`)).toBe(true)
    expect(frame('about:blank')).toBe(true)
    expect(frame('about:blank#page=1')).toBe(true)
    expect(frame(`${ORIGIN}/`)).toBe(false)
    expect(frame(`${ORIGIN}/api/document/`)).toBe(false)
    expect(frame(`${ORIGIN}/api/document-extra`)).toBe(false)
    expect(frame(`${ORIGIN}/api/media?path=a.png`)).toBe(false)
  })

  it('cancels data, blob, javascript, file, and custom schemes in a subframe', () => {
    for (const url of [
      'data:text/html,<img src=https://example/>',
      'blob:http://127.0.0.1:4330/1234',
      'javascript:alert(1)',
      'file:///etc/hosts',
      'shortcuts://run',
      'about:srcdoc',
      'about:blankevil',
      'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/index.html',
      'http://127.0.0.1:4331/api/document',
      'https://127.0.0.1:4330/api/document',
      'http://127.0.0.1:4321/api/document?path=x',
    ]) expect(frame(url), url).toBe(false)
  })

  it('refuses a navigation whose frame is unknown', () => {
    expect(allowsNavigation(`${ORIGIN}/`, { origin: ORIGIN })).toBe(false)
    expect(allowsNavigation('about:blank', { origin: ORIGIN })).toBe(false)
  })

  it('cancels a refused subframe without opening it outside, and a refused main frame may leave', () => {
    const openOutside = vi.fn()
    const subframe = { url: 'shortcuts://run', isMainFrame: false, preventDefault: vi.fn() }
    guardNavigation(subframe, { origin: ORIGIN, openOutside })
    expect(subframe.preventDefault).toHaveBeenCalledOnce()
    expect(openOutside).not.toHaveBeenCalled()

    const redirect = { url: 'https://example.com/out', isMainFrame: true, preventDefault: vi.fn() }
    guardNavigation(redirect, { origin: ORIGIN, openOutside })
    expect(redirect.preventDefault).toHaveBeenCalledOnce()
    expect(openOutside).toHaveBeenCalledWith('https://example.com/out')

    const stay = { url: `${ORIGIN}/`, isMainFrame: true, preventDefault: vi.fn() }
    guardNavigation(stay, { origin: ORIGIN, openOutside })
    expect(stay.preventDefault).not.toHaveBeenCalled()
  })
})
