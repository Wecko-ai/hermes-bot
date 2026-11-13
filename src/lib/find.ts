// Find in the conversation: case- and accent-insensitive matches, as DOM ranges, so the
// rendered Markdown is never modified (the ranges feed the CSS Custom Highlight API).

/** A character without case or accent; may be longer than one char for rare letters. */
const fold = (char: string) => char.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/** The text folded, with for each folded char the index of its source char. */
function foldWithMap(text: string): { folded: string; origin: number[] } {
  let folded = ''
  const origin: number[] = []
  for (let index = 0; index < text.length; index += 1) {
    const piece = fold(text[index])
    for (let offset = 0; offset < piece.length; offset += 1) origin.push(index)
    folded += piece
  }
  return { folded, origin }
}

/** Offsets `[start, end)` in `text` of every occurrence of `query`, ignoring case and accents. */
export function findMatches(text: string, query: string): Array<[number, number]> {
  const needle = foldWithMap(query.trim()).folded
  if (!needle) return []
  const { folded, origin } = foldWithMap(text)
  const found: Array<[number, number]> = []
  for (let from = folded.indexOf(needle); from !== -1; from = folded.indexOf(needle, from + needle.length)) {
    found.push([origin[from], origin[from + needle.length - 1] + 1])
  }
  return found
}

/** Ranges of every match in the visible text of the messages under `root`, in reading order. */
export function findRanges(root: HTMLElement, query: string): Range[] {
  if (!query.trim()) return []
  const ranges: Range[] = []
  for (const content of root.querySelectorAll('.message-content')) {
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => (node.parentElement?.closest('textarea, script, style, [hidden], .visually-hidden') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    })
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const [start, end] of findMatches(node.textContent ?? '', query)) {
        const range = document.createRange()
        range.setStart(node, start)
        range.setEnd(node, end)
        ranges.push(range)
      }
    }
  }
  return ranges
}
