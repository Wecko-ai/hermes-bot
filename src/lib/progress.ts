import type { ChatMessage } from '../types'
import { isSilentMessage } from './hermes'
import { cleanPreview } from './time'
import { stepIds } from './turns'

const MAX_PROGRESS = 220

/** One short line for a progress bubble in the thread. */
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

/**
 * Builds the thread view: progress lines group under the turn's final assistant reply.
 * While the turn runs, open groups show compact bubbles above the working line.
 */
export function threadItems(messages: ChatMessage[], running: boolean, profile: string, progressEnabled: boolean): ThreadItem[] {
  const hiddenSteps = stepIds(messages, running, profile)
  const items: ThreadItem[] = []
  let bucket: ChatMessage[] = []

  for (const message of messages) {
    if (hiddenSteps.has(message.id) || !isVisible(message)) continue
    if (progressEnabled && isProgress(message)) {
      bucket.push(message)
      continue
    }
    if (progressEnabled && message.role === 'assistant' && !message.agent && !message.streaming) {
      if (bucket.length) {
        items.push({ kind: 'turn', progress: bucket, answer: message, collapsed: true })
        bucket = []
      } else {
        items.push({ kind: 'message', message })
      }
      continue
    }
    if (bucket.length) {
      for (const progress of bucket) items.push({ kind: 'message', message: progress })
      bucket = []
    }
    items.push({ kind: 'message', message })
  }

  if (progressEnabled && bucket.length) {
    items.push({ kind: 'turn', progress: bucket, collapsed: !running })
  }
  return items
}