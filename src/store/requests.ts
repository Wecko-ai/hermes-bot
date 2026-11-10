import { create } from 'zustand'
import type { PendingPrompt, ServerRequest } from '../lib/hermes'
import type { BrowserVaultRequest } from '../lib/browser-vault'

/** Adds the question if its `promptId` is not already there. */
export function addPrompt(items: PendingPrompt[], prompt: PendingPrompt) {
  return items.some((item) => item.promptId === prompt.promptId) ? items : [...items, prompt]
}

/** Removes a settled question: it is identified by the session + `promptId` pair. */
export function settlePrompt(items: PendingPrompt[], sessionId: string, promptId: string) {
  return items.filter((item) => !(item.sessionId === sessionId && item.promptId === promptId))
}

/** A finished turn waits for nothing: removes all the session's questions (same list if none). */
export function clearSessionPrompts(items: PendingPrompt[], sessionId: string) {
  return items.some((item) => item.sessionId === sessionId) ? items.filter((item) => item.sessionId !== sessionId) : items
}

/** Replaces a session's questions with those the gateway has just returned. */
export function replaceSessionPrompts(items: PendingPrompt[], sessionId: string, fresh: PendingPrompt[]) {
  return [...items.filter((item) => item.sessionId !== sessionId), ...fresh]
}

export function addServerRequest(items: ServerRequest[], request: ServerRequest) {
  return items.some((item) => item.id === request.id) ? items : [...items, request]
}

export interface RequestsState {
  /** Open questions and approvals of the sessions followed on this socket (`clarify.request`, `approval.request`). */
  prompts: PendingPrompt[]
  serverRequests: ServerRequest[]
  browserVaultRequests: BrowserVaultRequest[]

  addPrompt: (prompt: PendingPrompt) => void
  settlePrompt: (sessionId: string, promptId: string) => void
  /** Answer given from here: removal by `promptId` alone. */
  removePrompt: (promptId: string) => void
  clearSessionPrompts: (sessionId: string) => void
  replaceSessionPrompts: (sessionId: string, fresh: PendingPrompt[]) => void

  addServerRequest: (request: ServerRequest) => void
  removeServerRequest: (id: string) => void

  setBrowserVaultRequests: (requests: BrowserVaultRequest[]) => void
  removeBrowserVaultRequest: (id: string) => void
}

export const useRequestsStore = create<RequestsState>()((set) => ({
  prompts: [],
  serverRequests: [],
  browserVaultRequests: [],

  addPrompt: (prompt) => set((state) => ({ prompts: addPrompt(state.prompts, prompt) })),
  settlePrompt: (sessionId, promptId) => set((state) => ({ prompts: settlePrompt(state.prompts, sessionId, promptId) })),
  removePrompt: (promptId) => set((state) => ({ prompts: state.prompts.filter((item) => item.promptId !== promptId) })),
  clearSessionPrompts: (sessionId) => set((state) => {
    const prompts = clearSessionPrompts(state.prompts, sessionId)
    return prompts === state.prompts ? state : { prompts }
  }),
  replaceSessionPrompts: (sessionId, fresh) => set((state) => ({ prompts: replaceSessionPrompts(state.prompts, sessionId, fresh) })),

  addServerRequest: (request) => set((state) => ({ serverRequests: addServerRequest(state.serverRequests, request) })),
  removeServerRequest: (id) => set((state) => ({ serverRequests: state.serverRequests.filter((item) => item.id !== id) })),

  setBrowserVaultRequests: (browserVaultRequests) => set({ browserVaultRequests }),
  removeBrowserVaultRequest: (id) => set((state) => ({ browserVaultRequests: state.browserVaultRequests.filter((item) => item.id !== id) })),
}))

export function resetRequestsStore() {
  useRequestsStore.setState({ prompts: [], serverRequests: [], browserVaultRequests: [] })
}
