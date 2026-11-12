import type { ChatMessage } from '../types'
import { findMediaTags } from './media'
import { MAIL_FENCE } from './mail'

const isAnswerText = (message: ChatMessage) => message.role === 'assistant' && !message.agent && !message.technical && !message.streaming
// A tool call of the bot: its result row, or the line of a message it sent to another bot. A message
// received from another bot, or a reply delivered back, starts a turn of its own instead.
const isToolRow = (message: ChatMessage, profile: string) => message.role === 'tool' || (message.agent?.kind === 'message' && message.agent.from === profile)
const startsTurn = (message: ChatMessage) => Boolean(message.agent) || (message.role === 'user' && !(message.pending && message.delivery === 'queue'))
// A step that hands the user something keeps its bubble: a file or a mail card to approve.
const carriesSomething = (message: ChatMessage) => findMediaTags(message.content).length > 0 || message.content.includes(MAIL_FENCE)

/**
 * The bot's steps inside a turn, as opposed to its answer: the ids of the assistant messages the
 * thread folds into the working line. A step is a text written just before a tool call, so it is
 * followed by a tool row before the next text or user message. While a turn runs, its last text is
 * still a step: the answer only comes with the end of the turn. A step that carries a file or a
 * mail card is never folded.
 */
export function stepIds(messages: ChatMessage[], running: boolean, profile: string): Set<string> {
  const steps = new Set<string>()
  let pending: ChatMessage | null = null
  for (const message of messages) {
    if (isAnswerText(message)) {
      pending = message
    } else if (isToolRow(message, profile)) {
      if (pending && !carriesSomething(pending)) steps.add(pending.id)
      pending = null
    } else if (startsTurn(message)) {
      pending = null
    }
  }
  if (running && pending && !carriesSomething(pending)) {
    const last = [...messages].reverse().find((message) => isAnswerText(message) || startsTurn(message))
    if (last === pending) steps.add(pending.id)
  }
  return steps
}
