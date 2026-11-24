/** Which rows of a long thread are on screen. Heights are pixels. */

export interface MessageWindow {
  start: number
  end: number
  top: number
  bottom: number
}

export const ESTIMATED_ROW_HEIGHT = 120

export function messageWindow(
  count: number,
  scrollTop: number,
  viewport: number,
  heightAt: (index: number) => number = () => ESTIMATED_ROW_HEIGHT,
  overscan = 8,
): MessageWindow {
  if (count <= 0) return { start: 0, end: 0, top: 0, bottom: 0 }
  if (viewport <= 0) return { start: 0, end: count, top: 0, bottom: 0 }
  const slack = overscan * ESTIMATED_ROW_HEIGHT
  const lead = Math.max(0, scrollTop - slack)
  let start = 0
  let top = 0
  while (start < count) {
    const height = heightAt(start)
    if (top + height > lead) break
    top += height
    start += 1
  }
  let end = start
  let covered = 0
  const need = viewport + slack * 2
  while (end < count && covered < need) {
    covered += heightAt(end)
    end += 1
  }
  end = Math.min(count, end + overscan)
  let bottom = 0
  for (let index = end; index < count; index += 1) bottom += heightAt(index)
  return { start, end, top, bottom }
}

/** The last screen, used while the thread is pinned to the newest line. */
export function messageTail(
  count: number,
  viewport: number,
  heightAt: (index: number) => number = () => ESTIMATED_ROW_HEIGHT,
  overscan = 8,
): MessageWindow {
  if (count <= 0) return { start: 0, end: 0, top: 0, bottom: 0 }
  if (viewport <= 0) return { start: 0, end: count, top: 0, bottom: 0 }
  const slack = overscan * ESTIMATED_ROW_HEIGHT
  let start = count
  let used = 0
  const need = viewport + slack * 2
  while (start > 0 && used < need) {
    start -= 1
    used += heightAt(start)
  }
  start = Math.max(0, start - overscan)
  let top = 0
  for (let index = 0; index < start; index += 1) top += heightAt(index)
  return { start, end: count, top, bottom: 0 }
}

/** In-memory LRU. The oldest key is dropped when `max` is passed. */
export function createLru<T>(max: number) {
  const entries = new Map<string, T>()
  return {
    get(key: string) {
      const value = entries.get(key)
      if (value === undefined && !entries.has(key)) return undefined
      entries.delete(key)
      entries.set(key, value as T)
      return value
    },
    set(key: string, value: T) {
      entries.delete(key)
      entries.set(key, value)
      while (entries.size > max) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        entries.delete(oldest)
      }
    },
  }
}
