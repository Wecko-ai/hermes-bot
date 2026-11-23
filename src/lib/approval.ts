import type { PendingPrompt, ServerRequest } from './hermes'

/** A card may record “sent” only when the send was not refused. `false` keeps the form and the draft. */
export async function approvalAccepted(result: Promise<boolean | void> | boolean | void): Promise<boolean> {
  return (await result) !== false
}

const text = (value: unknown) => (typeof value === 'string' ? value : '')

/** JSON-RPC `approval` from the gateway, shown in-thread like `approval.request`. */
export function serverApprovalPrompt(request: ServerRequest, executionGeneration: number): PendingPrompt | null {
  if (request.method !== 'approval') return null
  const sessionId = text(request.params.session_id)
  if (!sessionId) return null
  const choices = Array.isArray(request.params.choices)
    ? request.params.choices.filter((choice): choice is string => typeof choice === 'string' && choice.trim() !== '')
    : ['once', 'deny']
  return {
    sessionId,
    kind: 'approval',
    promptId: `server-${request.id}`,
    generation: executionGeneration,
    question: '',
    choices,
    multiSelect: false,
    command: text(request.params.command),
    description: text(request.params.description),
    serverRequestId: request.id,
  }
}
