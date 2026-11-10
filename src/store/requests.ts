import { create } from 'zustand'
import type { PendingPrompt, ServerRequest } from '../lib/hermes'
import type { BrowserVaultRequest } from '../lib/browser-vault'

/** Ajoute la question si son `promptId` n’est pas déjà là. */
export function addPrompt(items: PendingPrompt[], prompt: PendingPrompt) {
  return items.some((item) => item.promptId === prompt.promptId) ? items : [...items, prompt]
}

/** Retire une question réglée : c’est le couple session + `promptId` qui l’identifie. */
export function settlePrompt(items: PendingPrompt[], sessionId: string, promptId: string) {
  return items.filter((item) => !(item.sessionId === sessionId && item.promptId === promptId))
}

/** Un tour fini n’attend plus rien : retire toutes les questions de la session (même liste si aucune). */
export function clearSessionPrompts(items: PendingPrompt[], sessionId: string) {
  return items.some((item) => item.sessionId === sessionId) ? items.filter((item) => item.sessionId !== sessionId) : items
}

/** Remplace les questions d’une session par celles que la gateway vient de renvoyer. */
export function replaceSessionPrompts(items: PendingPrompt[], sessionId: string, fresh: PendingPrompt[]) {
  return [...items.filter((item) => item.sessionId !== sessionId), ...fresh]
}

export function addServerRequest(items: ServerRequest[], request: ServerRequest) {
  return items.some((item) => item.id === request.id) ? items : [...items, request]
}

export interface RequestsState {
  /** Questions et accords ouverts des sessions suivies sur ce socket (`clarify.request`, `approval.request`). */
  prompts: PendingPrompt[]
  serverRequests: ServerRequest[]
  browserVaultRequests: BrowserVaultRequest[]

  addPrompt: (prompt: PendingPrompt) => void
  settlePrompt: (sessionId: string, promptId: string) => void
  /** Réponse donnée d’ici : retrait par `promptId` seul. */
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
