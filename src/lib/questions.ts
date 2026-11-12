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
