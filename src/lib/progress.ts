import type { ChatMessage } from '../types'
import { isSilentMessage } from './hermes'
import { cleanPreview } from './time'
import { expandToolMessage } from './tool-transcript'
import { stepIds } from './turns'

const MAX_PROGRESS = 220

/** One short line for a progress step in the thread. */
export function progressBubbleText(text: string) {
  const line = cleanPreview(text)
  const end = line.search(/[.!?…](\s|$)/)
  const clip = end >= 16 ? line.slice(0, end + 1) : line
  return clip.length > MAX_PROGRESS ? `${clip.slice(0, MAX_PROGRESS - 1).trimEnd()}…` : clip
}

export function shouldRecordProgress(text: string) {
  const trimmed = text.trim()
  return Boolean(trimmed) && !isSilentMessage(trimmed)
}

export type ThreadItem =
  | { kind: 'message'; message: ChatMessage }
  | { kind: 'turn'; progress: ChatMessage[]; answer?: ChatMessage; collapsed: boolean }

const isProgress = (message: ChatMessage) => message.progress === true
const isVisible = (message: ChatMessage) =>
  message.agent || (!message.technical && message.role !== 'system' && message.role !== 'tool')

const normalized = (text: string) => text.replace(/\s+/g, ' ').trim()

/** Short lines for the toggle. Drops empties, repeats, and a step that is the final answer itself. */
function stepLines(bucket: ChatMessage[], answer?: ChatMessage): ChatMessage[] {
  const answerText = answer ? normalized(answer.content) : ''
  const seen = new Set<string>()
  const steps: ChatMessage[] = []
  for (const item of bucket) {
    const content = progressBubbleText(item.content)
    const key = normalized(content)
    if (!key || key === answerText || seen.has(key)) continue
    seen.add(key)
    steps.push(content === item.content ? item : { ...item, content })
  }
  return steps
}

/**
 * Builds the thread view. A bot's steps (a sealed `message.interim`, or a history row written
 * just before a tool call) group with the turn's final reply. The group is collapsed once the
 * reply exists; while the turn runs it stays a single live line. The reply is never one of the steps.
 */
export function threadItems(messages: ChatMessage[], running: boolean, profile: string, progressEnabled: boolean): ThreadItem[] {
  const expanded = messages.flatMap(expandToolMessage)
  const hiddenSteps = stepIds(expanded, running, profile)
  const items: ThreadItem[] = []
  let bucket: ChatMessage[] = []

  const flush = (answer?: ChatMessage) => {
    const progress = progressEnabled ? stepLines(bucket, answer) : []
    bucket = []
    if (progress.length) {
      items.push({ kind: 'turn', progress, ...(answer ? { answer } : {}), collapsed: answer ? true : !running })
      return
    }
    if (answer) items.push({ kind: 'message', message: answer })
  }

  for (const message of expanded) {
    if (!isVisible(message)) continue
    if (hiddenSteps.has(message.id)) {
      if (progressEnabled) bucket.push(message)
      continue
    }
    // A step is never its own bubble, including when the thread hides the progress list.
    if (isProgress(message)) {
      if (progressEnabled) bucket.push(message)
      continue
    }
    if (progressEnabled && message.role === 'assistant' && !message.agent && !message.streaming) {
      flush(message)
      continue
    }
    if (bucket.length) flush()
    items.push({ kind: 'message', message })
  }

  if (bucket.length) flush()
  return items
}
