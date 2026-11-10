import { create } from 'zustand'
import type { Bot } from '../types'
import { applyWorkEvent, type WorkSummary } from '../lib/work-summary'
import { resolveUpdater, type Updater } from './updater'

/** Délai pendant lequel un bot qui vient de finir reste « Terminé » avant de repasser au repos. */
export const DONE_VISIBLE_MS = 5000

type WorkEvent = Parameters<typeof applyWorkEvent>[1]

/** Copie de la liste avec les changements appliqués au seul bot visé. */
export function patchBot(bots: Bot[], slug: string, changes: Partial<Bot>): Bot[] {
  return bots.map((bot) => bot.slug === slug ? { ...bot, ...changes } : bot)
}

/** Garde l’objet courant tant que le contenu est identique : pas de rendu inutile. */
export function publishedWork(current: Record<string, WorkSummary>, next: Record<string, WorkSummary>) {
  return JSON.stringify(current) === JSON.stringify(next) ? current : next
}

// Hors état réactif : ces tables changent à chaque événement et ne se lisent jamais à l’écran directement.
// `work` est publié dans `workSummaries` à son rythme (voir `publishWork`).
const work = new Map<string, WorkSummary>()
const workSeq = new Map<string, number>()
const doneTimers = new Map<string, ReturnType<typeof setTimeout>>()

export interface RosterState {
  bots: Bot[]
  selected: string
  /** Tant que le roster n’a pas répondu, une liste vide veut dire « pas encore », pas « aucun bot ». */
  rosterLoaded: boolean
  connected: boolean
  reconnecting: boolean
  workSummaries: Record<string, WorkSummary>

  setBots: (value: Updater<Bot[]>) => void
  updateBot: (slug: string, changes: Partial<Bot>) => void
  setSelected: (value: Updater<string>) => void
  setRosterLoaded: (value: boolean) => void
  setConnected: (value: boolean) => void
  setReconnecting: (value: boolean) => void

  /** Replie un événement dans le résumé de travail du bot (non publié tout de suite). */
  applyWork: (slug: string, event: WorkEvent) => void
  /** Publie les résumés accumulés si quelque chose a changé. */
  publishWork: () => void
  getWorkSeq: (slug: string) => number
  setWorkSeq: (slug: string, seq: number) => void

  clearDoneTimer: (slug: string) => void
  /** Fin de tour : « Terminé » 5 s, puis repos. Un worker encore actif garde le bot « au travail ». */
  markDone: (slug: string) => void
}

export const useRosterStore = create<RosterState>()((set, get) => ({
  bots: [],
  selected: '',
  rosterLoaded: false,
  connected: false,
  reconnecting: false,
  workSummaries: {},

  setBots: (value) => set((state) => ({ bots: resolveUpdater(value, state.bots) })),
  updateBot: (slug, changes) => set((state) => ({ bots: patchBot(state.bots, slug, changes) })),
  setSelected: (value) => set((state) => ({ selected: resolveUpdater(value, state.selected) })),
  setRosterLoaded: (rosterLoaded) => set({ rosterLoaded }),
  setConnected: (connected) => set({ connected }),
  setReconnecting: (reconnecting) => set({ reconnecting }),

  applyWork: (slug, event) => {
    const next = applyWorkEvent(work.get(slug), event)
    if (next) work.set(slug, next)
    else work.delete(slug)
  },
  publishWork: () => {
    const next = Object.fromEntries(work)
    set((state) => {
      const published = publishedWork(state.workSummaries, next)
      return published === state.workSummaries ? state : { workSummaries: published }
    })
  },
  getWorkSeq: (slug) => workSeq.get(slug) ?? 0,
  setWorkSeq: (slug, seq) => { workSeq.set(slug, seq) },

  clearDoneTimer: (slug) => {
    const timer = doneTimers.get(slug)
    if (timer) clearTimeout(timer)
    doneTimers.delete(slug)
  },
  markDone: (slug) => {
    const { clearDoneTimer, updateBot } = get()
    clearDoneTimer(slug)
    // Un worker du bot tourne encore : le tour de chat est fini, pas son travail.
    if (get().bots.find((bot) => bot.slug === slug)?.workerActive) {
      updateBot(slug, { status: 'working' })
      return
    }
    updateBot(slug, { status: 'done' })
    doneTimers.set(slug, setTimeout(() => get().updateBot(slug, { status: 'idle' }), DONE_VISIBLE_MS))
  },
}))

/** Remise à zéro complète (tests). */
export function resetRosterStore() {
  work.clear()
  workSeq.clear()
  for (const timer of doneTimers.values()) clearTimeout(timer)
  doneTimers.clear()
  useRosterStore.setState({ bots: [], selected: '', rosterLoaded: false, connected: false, reconnecting: false, workSummaries: {} })
}
