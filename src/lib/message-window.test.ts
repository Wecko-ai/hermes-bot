import { describe, expect, it } from 'vitest'
import { createLru, messageTail, messageWindow } from './message-window'

describe('message window', () => {
  it('renders everything until the viewport is known', () => {
    expect(messageWindow(500, 0, 0)).toEqual({ start: 0, end: 500, top: 0, bottom: 0 })
  })

  it('keeps a window around the scroll position and the height outside it', () => {
    const height = () => 100
    const view = messageWindow(50, 2000, 400, height, 0)
    expect(view.start).toBe(20)
    expect(view.top).toBe(2000)
    expect(view.end).toBeGreaterThan(view.start)
    expect(view.end).toBeLessThan(50)
    expect(view.bottom).toBe((50 - view.end) * 100)
  })

  it('pins the window to the newest rows', () => {
    const view = messageTail(50, 400, () => 100, 0)
    expect(view.end).toBe(50)
    expect(view.bottom).toBe(0)
    expect(view.start).toBeLessThan(50)
    expect(view.top).toBe(view.start * 100)
  })

  it('drops the oldest cached value', () => {
    const cache = createLru<number>(2)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.get('a')
    cache.set('c', 3)
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toBe(1)
    expect(cache.get('c')).toBe(3)
  })
})
