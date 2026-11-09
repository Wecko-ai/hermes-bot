export interface ModelOverride {
  model: string
  provider: string
}

export interface ModelOption extends ModelOverride {
  providerName: string
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
