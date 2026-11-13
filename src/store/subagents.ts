import { create } from 'zustand'
import { applySubagentEvent, applySubagentList, type SubagentRow, type SubagentSnapshot } from '../lib/subagents'
import { mergeAgentProcesses, type AgentProcess } from '../lib/agent-process'

/** Children and background processes of the conversations seen in this window, by session id. Memory only. */
export interface SubagentsState {
  rows: Record<string, SubagentRow[]>
  /** Background processes still running (`process.list`), for the conversations that were read. */
  processes: Record<string, number>
  /** Coding agents run as background processes (`claude -p`…), by session id. */
  agentProcesses: Record<string, AgentProcess[]>

  applyEvent: (sessionId: string, type: string, payload: unknown) => void
  applyList: (sessionId: string, snapshots: SubagentSnapshot[]) => void
  setProcesses: (sessionId: string, count: number) => void
  setAgentProcesses: (sessionId: string, rows: AgentProcess[]) => void
}

export const useSubagentsStore = create<SubagentsState>()((set) => ({
  rows: {},
  processes: {},
  agentProcesses: {},

  applyEvent: (sessionId, type, payload) => set((state) => {
    const current = state.rows[sessionId] ?? []
    const next = applySubagentEvent(current, type, payload)
    return next === current ? state : { rows: { ...state.rows, [sessionId]: next } }
  }),
  applyList: (sessionId, snapshots) => set((state) => {
    const current = state.rows[sessionId] ?? []
    if (!current.length && !snapshots.length) return state
    return { rows: { ...state.rows, [sessionId]: applySubagentList(current, snapshots) } }
  }),
  setAgentProcesses: (sessionId, rows) => set((state) => {
    const current = state.agentProcesses[sessionId] ?? []
    if (!current.length && !rows.length) return state
    return { agentProcesses: { ...state.agentProcesses, [sessionId]: mergeAgentProcesses(current, rows) } }
  }),
  setProcesses: (sessionId, count) => set((state) => (state.processes[sessionId] === count ? state : { processes: { ...state.processes, [sessionId]: count } })),
}))

/** Full reset (tests). */
export function resetSubagentsStore() {
  useSubagentsStore.setState({ rows: {}, processes: {}, agentProcesses: {} })
}
