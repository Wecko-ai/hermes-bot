export interface ModelOverride {
  model: string
  provider: string
}

export interface ModelOption extends ModelOverride {
  providerName: string
  tag?: string
  inputPrice?: string
  outputPrice?: string
}

export interface SessionUsage {
  contextUsed: number
  contextMax: number
  contextPercent: number
  averageTps: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  // Missing from some frames: a missing value never replaces the last known one.
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  apiCalls?: number
  compressions?: number
  cacheHitPercent?: number
  averageLatency?: number
  activeSubagents?: number
  lastTurnTokens?: number
  costUsd?: number
  contextEstimated?: boolean
  model?: string
  provider?: string
  plan?: { label: string; usedPercent: number; resetsAt: number | null }
}

export interface ContextBreakdown {
  used: number
  max: number
  estimated: boolean
  categories: { id: string; label: string; tokens: number }[]
  files: { label: string; tokens: number; loaded: boolean }[]
}

export interface UsageHistory {
  days: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  reasoningTokens: number
  costUsd: number
  sessions: number
  apiCalls: number
  daily: { day: string; tokens: number; costUsd: number }[]
  models: { model: string; tokens: number; costUsd: number }[]
}

/**
 * `standby`: no turn, but subagents or background processes still running. It is never stored in `Bot.status`,
 * which holds the turn state: `effectiveStatus` (lib/background) derives it from `Bot.background`.
 */
export type BotStatus = 'idle' | 'thinking' | 'working' | 'waiting' | 'blocked' | 'done' | 'standby'

/** Work still running without a turn: delegated subagents and background processes that have not exited. */
export interface BackgroundWork {
  subagents: number
  processes: number
}

export interface Bot {
  slug: string
  sessionId?: string
  provider?: string
  name: string
  role: string
  section: string
  sectionId: string
  model: string
  status: BotStatus
  preview: string
  timestamp: string | null
  /** Most recent activity of the profile in ms, across all sessions (background tasks included). */
  lastActivity?: number
  /** Last date already counted as unread: while the bot works, the unread mark waits for the end. */
  seenAt?: string | null
  /** A worker (kanban, tool) of the bot is still running. */
  workerActive?: boolean
  /** Title of this worker, while it runs. */
  workTitle?: string
  /** The bot holds the shared Chrome (local arbiter): at work even without a Hermes turn. */
  browserOwner?: boolean
  /** Subagents and background processes still running in the profile's conversations (`subagent.roster`). */
  background?: BackgroundWork
  unread: number
  hidden: boolean
  avatar?: {
    shape?: string
    color?: string
    image?: string
  }
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  createdAt: string | null
  pending?: boolean
  failed?: boolean
  technical?: boolean
  /** Reply being written: the final message reuses the same identifier. */
  streaming?: boolean
  /** Message between two bots (`message_agent`): an “Orion messaged Iris” line in the thread. */
  agent?: AgentMessage
  /** Sent during a turn: queued, or priority (the turn was interrupted for it). */
  delivery?: 'queue' | 'priority'
  /** Images the user sent with the message: paths on the gateway's machine. */
  images?: string[]
  /** `delegate_task` call: the prompt of each child the bot started (Subagents tab). */
  delegation?: DelegationTask[]
}

/** One child asked for by `delegate_task`: its goal and the background the bot gave it. */
export interface DelegationTask {
  goal: string
  context?: string
}

export interface AgentMessage {
  /** `message`: sent; `reply`: reply returned to the sender; `no-reply`: no reply, with the reason. */
  kind: 'message' | 'reply' | 'no-reply'
  /** Profile, name or tag as Hermes writes it: the interface resolves it against the roster. */
  from: string
  /** Name shown by Hermes for the sender, if the roster does not know it. */
  fromName?: string
  to: string
  /** Message, reply, or reason given by Hermes when the bot did not reply. */
  text: string
}

export interface Routine {
  id: string
  name: string
  schedule: string
  scheduleText: string
  enabled: boolean
  nextRunAt: string | null
  lastRunAt: string | null
}

export interface BotDetails {
  bot: Bot
  routines: Routine[]
}

export interface GatewayHealth {
  connected: boolean
  label: string
  version?: string
}

export interface RosterResponse {
  bots: Bot[]
  health: GatewayHealth
}
