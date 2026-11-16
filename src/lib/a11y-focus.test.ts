import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { contextMenuPoint, isContextMenuKey, nextRovingIndex, tabTrapIndex } from './a11y-focus'

describe('dialog focus trap', () => {
  it('wraps Tab at the ends and lets it move through the middle', () => {
    expect(tabTrapIndex(4, -1, false)).toBe(0)
    expect(tabTrapIndex(4, -1, true)).toBe(3)
    expect(tabTrapIndex(4, 0, true)).toBe(3)
    expect(tabTrapIndex(4, 0, false)).toBeNull()
    expect(tabTrapIndex(4, 2, false)).toBeNull()
    expect(tabTrapIndex(4, 2, true)).toBeNull()
    expect(tabTrapIndex(4, 3, false)).toBe(0)
    expect(tabTrapIndex(1, 0, false)).toBe(0)
    expect(tabTrapIndex(0, 0, false)).toBeNull()
  })
})

describe('roving tabs', () => {
  it('moves with the arrows, Home and End, and ignores keys when focus is not on a tab', () => {
    expect(nextRovingIndex(4, 1, 'ArrowRight')).toBe(2)
    expect(nextRovingIndex(4, 0, 'ArrowLeft')).toBe(3)
    expect(nextRovingIndex(4, 3, 'ArrowRight')).toBe(0)
    expect(nextRovingIndex(4, 2, 'Home')).toBe(0)
    expect(nextRovingIndex(4, 2, 'End')).toBe(3)
    expect(nextRovingIndex(4, -1, 'ArrowRight')).toBeNull()
    expect(nextRovingIndex(4, 1, 'Enter')).toBeNull()
  })
})

describe('bot context menu key', () => {
  const row = { left: 20, right: 280, top: 100, bottom: 158 }

  it('opens from the Context Menu key and Shift+F10', () => {
    expect(isContextMenuKey('ContextMenu', false)).toBe(true)
    expect(isContextMenuKey('F10', true)).toBe(true)
    expect(isContextMenuKey('F10', false)).toBe(false)
    expect(isContextMenuKey('Enter', true)).toBe(false)
  })

  it('places a keyboard menu from the row box, and a click where the pointer is', () => {
    expect(contextMenuPoint(row, 0, 0, true)).toEqual({ x: 48, y: 152 })
    expect(contextMenuPoint(row, 40, 120, true)).toEqual({ x: 48, y: 152 })
    expect(contextMenuPoint(row, 40, 120, false)).toEqual({ x: 40, y: 120 })
    expect(contextMenuPoint(row, 0, 0, false)).toEqual({ x: 48, y: 152 })
  })
})

describe('text size floor', () => {
  it('keeps every font-size in styles.css at 12px or more', () => {
    const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
    const declarations = [...css.matchAll(/font-size:\s*([^;}]+)/g)].map((match) => match[1].trim())
    const offenders = declarations.filter((value) => {
      if (value === 'inherit') return false
      if (value.endsWith('px')) return Number.parseFloat(value) < 12
      if (value.endsWith('em')) return Number.parseFloat(value) < 1
      return true
    })
    expect(offenders).toEqual([])
  })
})
