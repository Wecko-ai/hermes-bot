import type { ChatMessage } from '../types'
import { isGatewayMessage, isSilentMessage } from './hermes'

/** Rough Markdown to plain text: enough for a one-paragraph reminder, not a renderer. */
export function plainText(markdown: string) {
  return markdown
    .replace(/^\s*```.*$/gm, '')
    .replace(/^\s*MEDIA:\S.*$/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*(?::?-{3,}:?)?\s*$/gm, '')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, '')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_](\S(?:.*?\S)?)[*_](?=[\s).,;:!?]|$)/gm, '$1$2')
    .replace(/`+/g, '')
    .replace(/\s*\|\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** At most `max` characters, cut on a word when possible, with an ellipsis. */
export function shorten(text: string, max = 280) {
  if (text.length <= max) return text
  const cut = text.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/**
 * The bot's latest finished reply, in plain text, to remind the user why a request card is open.
 * Streaming, pending, technical, silent and gateway messages never count.
 */
export function requestContext(messages: readonly ChatMessage[] | undefined, max = 280) {
  if (!messages) return undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'assistant' || message.streaming || message.pending || message.failed || message.technical || message.agent) continue
    if (isSilentMessage(message.content) || isGatewayMessage(message.content)) continue
    const text = plainText(message.content)
    if (text) return shorten(text, max)
  }
  return undefined
}
