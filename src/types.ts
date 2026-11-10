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
  // Absents de certaines trames : une valeur manquante ne remplace jamais la dernière connue.
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

export type BotStatus = 'idle' | 'thinking' | 'working' | 'waiting' | 'blocked' | 'done'

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
  /** Activité la plus récente du profil en ms, toutes sessions confondues (tâches de fond comprises). */
  lastActivity?: number
  /** Dernière date déjà comptée en non-lu : pendant le travail, le non-lu attend la fin. */
  seenAt?: string | null
  /** Un worker (kanban, outil) du bot bat encore. */
  workerActive?: boolean
  /** Titre de ce worker, quand il tourne. */
  workTitle?: string
  /** Le bot détient le Chrome partagé (arbitre local) : au travail même sans tour Hermes. */
  browserOwner?: boolean
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
  /** Réponse en cours d’écriture : le message final reprend le même identifiant. */
  streaming?: boolean
  /** Message entre deux bots (`message_agent`) : une ligne « Orion messaged Iris » dans le fil. */
  agent?: AgentMessage
}

export interface AgentMessage {
  /** `message` : envoi ; `reply` : réponse renvoyée à l’envoyeur ; `no-reply` : pas de réponse, avec la raison. */
  kind: 'message' | 'reply' | 'no-reply'
  /** Profil, nom ou tag tel que Hermes l’écrit : l’interface le résout avec le roster. */
  from: string
  /** Nom affiché par Hermes pour l’envoyeur, si le roster ne le connaît pas. */
  fromName?: string
  to: string
  /** Message, réponse, ou raison donnée par Hermes quand le bot n’a pas répondu. */
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
