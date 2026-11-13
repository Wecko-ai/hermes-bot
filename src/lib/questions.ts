/** Open questions a bot asks at the end of a reply, answered from a small form. */
export interface OpenQuestions {
  /** Markdown before the heading, and after the list: both stay rendered as is. */
  before: string
  after: string
  heading: string
  questions: string[]
}

// "## Questions ouvertes", "**Open questions:**", "Questions pour toi :"… alone on their line.
const HEADING = /^\s{0,3}(?:#{1,6}\s+)?(?:\*\*|__)?\s*((?:questions?\s+ouvertes?|questions?\s+pour\s+(?:toi|vous)|questions?\s+en\s+suspens|open\s+questions?|questions?\s+for\s+you|questions?))\s*:?\s*(?:\*\*|__)?\s*:?\s*$/i
const ITEM = /^\s{0,3}(?:\d{1,2}[.)]|[-*+])\s+(.*\S)\s*$/
const CONTINUATION = /^\s{2,}(\S.*)$/

/** The last "open questions" section of a reply, or null when there is none. */
export function splitOpenQuestions(content: string): OpenQuestions | null {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  let fence = false
  let found: OpenQuestions | null = null
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s{0,3}(```|~~~)/.test(lines[index])) fence = !fence
    if (fence) continue
    const heading = HEADING.exec(lines[index])
    if (!heading) continue
    const questions: string[] = []
    let cursor = index + 1
    while (cursor < lines.length && !lines[cursor].trim()) cursor += 1
    for (; cursor < lines.length; cursor += 1) {
      const line = lines[cursor]
      const item = ITEM.exec(line)
      if (item) { questions.push(item[1]); continue }
      const more = CONTINUATION.exec(line)
      if (more && questions.length) { questions[questions.length - 1] += ` ${more[1].trim()}`; continue }
      // A blank line inside the list is fine; it ends there only if no item follows.
      if (!line.trim() && questions.length) {
        let next = cursor + 1
        while (next < lines.length && !lines[next].trim()) next += 1
        if (next < lines.length && ITEM.exec(lines[next])) { cursor = next - 1; continue }
      }
      break
    }
    if (!questions.length) continue
    found = {
      before: lines.slice(0, index).join('\n').replace(/\s+$/, ''),
      after: lines.slice(cursor).join('\n').replace(/^\s+/, ''),
      heading: heading[1].replace(/\s+/g, ' ').trim(),
      questions: questions.map((question) => question.replace(/\*\*|__/g, '').trim()),
    }
    index = cursor - 1
  }
  return found
}

const OTHER_BLOCK = /^\s{0,3}(?:#{1,6}\s|>|\||([-*_])(?:\s*\1){2,}\s*$)/
const FENCE = /^\s{0,3}(```|~~~)/

/** Whether a line asks something: a question mark outside URLs and inline code. */
const asks = (text: string) => /\?/.test(text.replace(/`[^`]*`/g, '').replace(/https?:\/\/\S+/g, ''))

/**
 * A plain line counts only when it ends on its question. Prose that merely contains one
 * ("Why this choice? Because…") must stay prose: two such paragraphs would otherwise become a form.
 */
const endsAsking = (text: string) => asks(text) && /\?[\s*_)\]»"”’']*$/.test(text)

/** Question text as shown above a field: no list or bold markers, links reduced to their label. */
function cleanQuestion(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

interface Run { mode: 'list' | 'plain'; items: string[]; start: number; end: number }

/**
 * Looser rule, for the latest reply only: the last run of two or more consecutive questions,
 * as a list (every item must ask) or as plain lines. The short line above it becomes the heading.
 * `heading` is empty when there is no such line: the card then shows its default title.
 */
export function splitLooseQuestions(content: string): OpenQuestions | null {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  let found: Run | null = null
  let run: Run | null = null
  const close = () => {
    if (run && run.items.length >= 2 && run.items.every(asks)) found = run
    run = null
  }
  let fence = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (FENCE.test(line)) { close(); fence = !fence; continue }
    if (fence) continue
    if (!line.trim()) continue
    if (OTHER_BLOCK.test(line)) { close(); continue }
    const item = ITEM.exec(line)
    if (item) {
      if (!run || run.mode !== 'list') { close(); run = { mode: 'list', items: [], start: index, end: index + 1 } }
      run.items.push(item[1]); run.end = index + 1
      continue
    }
    const more = CONTINUATION.exec(line)
    const current = run as Run | null
    if (more && current?.mode === 'list' && current.items.length) {
      current.items[current.items.length - 1] += ` ${more[1].trim()}`; current.end = index + 1
      continue
    }
    // Plain line: it joins a run of plain questions; a line without a question ends that run.
    if (current?.mode === 'list') close()
    if (!endsAsking(line)) { close(); continue }
    if (!run) run = { mode: 'plain', items: [], start: index, end: index + 1 }
    run.items.push(line.trim()); run.end = index + 1
  }
  close()
  const block = found as Run | null
  if (!block) return null
  let start = block.start
  let heading = ''
  let above = start - 1
  while (above >= 0 && !lines[above].trim()) above -= 1
  if (above >= 0 && !(fenceBefore(lines, above))) {
    const raw = lines[above].trim()
    const text = raw.replace(/^#{1,6}\s+/, '').replace(/\*\*|__/g, '').replace(/\s*:\s*$/, '').trim()
    if (text && text.length <= 80 && !asks(raw) && !/[.…]$/.test(text) && !ITEM.test(lines[above]) && !OTHER_BLOCK.test(lines[above].replace(/^\s{0,3}#{1,6}\s/, 'x ')) && !FENCE.test(lines[above])) {
      heading = text
      start = above
    }
  }
  return {
    before: lines.slice(0, start).join('\n').replace(/\s+$/, ''),
    after: lines.slice(block.end).join('\n').replace(/^\s+/, ''),
    heading,
    questions: block.items.map(cleanQuestion),
  }
}

/** Whether a line sits inside a code fence. */
function fenceBefore(lines: string[], target: number): boolean {
  let inside = false
  for (let index = 0; index <= target; index += 1) if (FENCE.test(lines[index])) inside = !inside
  return inside
}

/** The card for a reply: the "open questions" section, else, when allowed, the looser rule. */
export function findQuestions(content: string, loose: boolean): OpenQuestions | null {
  return splitOpenQuestions(content) ?? (loose ? splitLooseQuestions(content) : null)
}

/** The message sent back: each answered question, quoted, then its answer. */
export function answersPrompt(intro: string, questions: string[], answers: string[]): string {
  const parts = questions.flatMap((question, index) => {
    const answer = (answers[index] || '').trim()
    if (!answer) return []
    const quoted = answer.split('\n').map((line) => (line.trim() ? `   ${line}` : '')).join('\n')
    return [`${index + 1}. ${question}\n${quoted}`]
  })
  return `${intro}\n\n${parts.join('\n\n')}`
}

export const hasAnswer = (answers: string[]) => answers.some((answer) => answer.trim())
