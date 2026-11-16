/** A stream may commit and save its answer only while the conversation generation it started in is still current. */
export function streamMayCommit(startedGeneration: number, currentGeneration: number): boolean {
  return startedGeneration === currentGeneration
}

export interface ConversationLoad {
  /** Generation captured before the read. */
  startedGeneration: number
  currentGeneration: number
  /** The on-screen messages were replaced while the read was in flight (a send commits a new array). */
  messagesChanged: boolean
  /** A reply is streaming. */
  streamActive: boolean
  /** The open conversation id changed while the read was in flight. */
  conversationChanged: boolean
}

/** A saved conversation may replace the thread only when nothing newer has started. */
export function acceptLoadedConversation(load: ConversationLoad): boolean {
  return load.startedGeneration === load.currentGeneration
    && !load.messagesChanged
    && !load.streamActive
    && !load.conversationChanged
}

/**
 * Text for the polite live region. A reply still streaming returns null so each token is not announced.
 * An empty finish returns null and leaves the previous announcement alone.
 */
export function replyAnnouncement(streaming: boolean, text: string): string | null {
  if (streaming) return null
  const answer = text.trim()
  return answer ? answer : null
}
