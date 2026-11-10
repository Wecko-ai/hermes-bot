import { create } from 'zustand'
import type { Bot } from '../types'
import { applyWorkEvent, type WorkSummary } from '../lib/work-summary'
import { resolveUpdater, type Updater } from './updater'

/** How long a bot that has just finished stays “Done” before going back to idle. */
export const DONE_VISIBLE_MS = 5000

type WorkEvent = Parameters<typeof applyWorkEvent>[1]

/** Copy of the list with the changes applied to the targeted bot only. */
export function patchBot(bots: Bot[], slug: string, changes: Partial<Bot>): Bot[] {
  return bots.map((bot) => bot.slug === slug ? { ...bot, ...changes } : bot)
}

/** Keeps the current object while the content is identical: no needless render. */
export function publishedWork(current: Record<string, WorkSummary>, next: Record<string, WorkSummary>) {
  return JSON.stringify(current) === JSON.stringify(next) ? current : next
}

// Outside reactive state: these tables change on every event and are never read on screen directly.
// `work` is published into `workSummaries` at its own pace (see `publishWork`).
const work = new Map<string, WorkSummary>()
const workSeq = new Map<string, number>()
const doneTimers = new Map<string, ReturnType<typeof setTimeout>>()

export interface RosterState {
  bots: Bot[]
  selected: string
  /** Until the roster has answered, an empty list means “not yet”, not “no bot”. */
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

  /** Folds an event into the bot's work summary (not published right away). */
  applyWork: (slug: string, event: WorkEvent) => void
  /** Publishes the accumulated summaries if anything changed. */
  publishWork: () => void
  getWorkSeq: (slug: string) => number
  setWorkSeq: (slug: string, seq: number) => void

  clearDoneTimer: (slug: string) => void
  /** End of turn: “Done” for 5 s, then idle. A worker that is still active keeps the bot “at work”. */
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
    // A worker of the bot is still running: the chat turn is over, not its work.
    if (get().bots.find((bot) => bot.slug === slug)?.workerActive) {
      updateBot(slug, { status: 'working' })
      return
    }
    updateBot(slug, { status: 'done' })
    doneTimers.set(slug, setTimeout(() => get().updateBot(slug, { status: 'idle' }), DONE_VISIBLE_MS))
  },
}))

/** Full reset (tests). */
export function resetRosterStore() {
  work.clear()
  workSeq.clear()
  for (const timer of doneTimers.values()) clearTimeout(timer)
  doneTimers.clear()
  useRosterStore.setState({ bots: [], selected: '', rosterLoaded: false, connected: false, reconnecting: false, workSummaries: {} })
}
