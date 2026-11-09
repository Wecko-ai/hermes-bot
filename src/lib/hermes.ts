import type { Bot, BotStatus, ChatMessage, ModelOption, ModelOverride, Routine, RosterResponse, SessionUsage } from '../types'

type Json = Record<string, unknown>
type RpcEvent = {
  type?: string
  session_id?: string
  seq?: number
  replay_epoch?: string
  execution_generation?: number
  admission_id?: string
  payload?: Json
}

type PendingRequest = {
  resolve: (value: any) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface ActiveChat {
  profile: string
  sessionId: string
  revision: number
  executionGeneration: number
  replayEpoch?: string
  subscriptionId?: string
  running: boolean
  model?: string
  socketGeneration: number
}

export class HermesRpcError extends Error {
  constructor(message: string, public data: Json = {}) {
    super(message)
    this.name = 'HermesRpcError'
  }
}

const asObject = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {})
const SILENT_MESSAGES = new Set(['SILENT', '[SILENT]', 'NOREPLY', '[NOREPLY]', 'NO_REPLY', '[NO_REPLY]', 'NO RESPONSE', '[NO RESPONSE]'])
export const isSilentMessage = (content: string) => SILENT_MESSAGES.has(content.trim().toUpperCase())
/** Pendant le streaming : vrai tant que le texte peut encore devenir `NOREPLY`, `[SILENT]`… */
export const mayBecomeSilent = (content: string) => {
  const text = content.trim().toUpperCase()
  return [...SILENT_MESSAGES].some((silent) => silent.startsWith(text))
}
const asString = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback
const asNumber = (value: unknown, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? value : fallback
const isoDate = (value: unknown): string | null => {
  const numeric = asNumber(value)
  if (!numeric) return typeof value === 'string' && value ? value : null
  return new Date(numeric < 1_000_000_000_000 ? numeric * 1000 : numeric).toISOString()
}

function textContent(message: Json): string {
  for (const candidate of [message.text, message.content, message.display_text]) {
    if (typeof candidate === 'string') return candidate
    if (Array.isArray(candidate)) {
      return candidate.map((part) => {
        if (typeof part === 'string') return part
        const item = asObject(part)
        if (typeof item.text === 'string') return item.text
        if (typeof item.content === 'string') return item.content
        if (item.type === 'image' || item.type === 'image_url') return '[Image]'
        return ''
      }).filter(Boolean).join('\n')
    }
  }
  return ''
}

function mapMessage(value: unknown, index: number): ChatMessage | null {
  const wrapper = asObject(value)
  const message = Object.keys(asObject(wrapper.message)).length ? { ...wrapper, ...asObject(wrapper.message) } : wrapper
  const content = textContent(message).trim()
  if (!content) return null
  const silent = isSilentMessage(content)
  const rawRole = asString(message.role, 'system')
  const role = ['user', 'assistant', 'system', 'tool'].includes(rawRole) ? rawRole as ChatMessage['role'] : 'system'
  return {
    id: asString(message.id) || String(message.row_id ?? `message-${index}`),
    role,
    content,
    createdAt: isoDate(message.timestamp ?? message.created_at),
    technical: silent || role === 'system' || role === 'tool',
  }
}

/** Même fenêtre que `workerActiveAt` du Bot Mode de Hermes Desktop. */
const WORKER_ACTIVE_MS = 150_000

/** Demande de la gateway qui attend une réponse de l’utilisateur (coffre, accord). */
export interface ServerRequest {
  id: string
  method: string
  params: Json
}

const ANSWERED_HERE = new Set(['approval', 'vault.save_login', 'vault.unlock_prompt', 'vault.code'])
/** Réservées à une fenêtre qui affiche la session : le refus 4404 laisse répondre une autre fenêtre. */
const WINDOW_OWNED = new Set(['preview.act', 'preview.read', 'terminal.read', 'theme.apply', 'window.read', 'tour'])

export class HermesClient {
  private serverRequestListeners = new Set<(request: ServerRequest) => void>()
  private socket: WebSocket | null = null
  private sequence = 0
  private pending = new Map<string, PendingRequest>()
  private listeners = new Set<(event: RpcEvent) => void>()
  private readyPromise: Promise<void> | null = null
  private connectionListeners = new Set<(connected: boolean) => void>()
  /** Incrémenté à chaque nouveau socket : les abonnements de session ne survivent pas à une reconnexion. */
  generation = 0

  async connect() {
    // CONNECTING compris : la relecture du roster et le bouton de reconnexion partagent le même socket.
    if (this.readyPromise && this.socket && this.socket.readyState <= WebSocket.OPEN) return this.readyPromise
    this.rejectPending()
    this.readyPromise = new Promise<void>((resolve, reject) => {
      const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
      const socket = new WebSocket(`${protocol}://${location.host}/api/ws?profile=default`, 'hermes-gateway-v1')
      this.socket = socket
      this.generation += 1
      const timer = setTimeout(() => {
        reject(new Error('La gateway Hermes ne répond pas.'))
        // Un socket ouvert mais muet resterait réutilisé : le fermer permet de repartir de zéro.
        socket.close()
      }, 20_000)
      socket.onmessage = (message) => {
        if (this.socket !== socket) return
        let frame: Json
        try { frame = JSON.parse(String(message.data)) } catch { return }
        const id = frame.id
        if (typeof frame.method === 'string' && frame.method !== 'event' && typeof id === 'string') {
          this.receiveServerRequest({ id, method: frame.method, params: asObject(frame.params) })
          return
        }
        if (id !== undefined && id !== null) {
          const request = this.pending.get(String(id))
          if (!request) return
          this.pending.delete(String(id))
          clearTimeout(request.timer)
          if (frame.error) {
            const error = asObject(frame.error)
            request.reject(new HermesRpcError(asString(error.message, 'Hermes a refusé la requête.'), asObject(error.data)))
          } else request.resolve(frame.result)
          return
        }
        if (frame.method === 'event') {
          const event = asObject(frame.params) as RpcEvent
          if (event.type === 'gateway.ready') {
            clearTimeout(timer)
            // Sans cette annonce, la gateway fait échouer les demandes de coffre et d’accord au lieu de les envoyer.
            socket.send(JSON.stringify({ jsonrpc: '2.0', id: `hermesbot-${++this.sequence}`, method: 'client.capabilities', params: { server_requests: true } }))
            this.connectionListeners.forEach((listener) => listener(true))
            resolve()
          }
          this.listeners.forEach((listener) => listener(event))
        }
      }
      socket.onerror = () => {
        clearTimeout(timer)
        reject(new Error('Connexion à Hermes impossible.'))
      }
      socket.onclose = () => {
        clearTimeout(timer)
        reject(new Error('La connexion Hermes a été fermée.'))
        // Un socket déjà remplacé ne touche plus à l’état ni aux requêtes du nouveau.
        if (this.socket !== socket) return
        this.socket = null
        this.readyPromise = null
        this.connectionListeners.forEach((listener) => listener(false))
        this.rejectPending()
      }
    })
    return this.readyPromise
  }

  private rejectPending() {
    this.pending.forEach((request) => {
      clearTimeout(request.timer)
      request.reject(new Error('La connexion Hermes a été fermée.'))
    })
    this.pending.clear()
  }

  onConnection(listener: (connected: boolean) => void) {
    this.connectionListeners.add(listener)
    return () => this.connectionListeners.delete(listener)
  }

  onServerRequest(listener: (request: ServerRequest) => void) {
    this.serverRequestListeners.add(listener)
    return () => this.serverRequestListeners.delete(listener)
  }

  /** Reçoit aussi les demandes encore ouvertes qu’une reprise de session redonne. */
  receiveServerRequest(request: ServerRequest) {
    if (ANSWERED_HERE.has(request.method)) {
      this.serverRequestListeners.forEach((listener) => listener(request))
      return
    }
    // Une demande sans réponse bloquerait le bot jusqu’à son délai : on la refuse tout de suite.
    this.sendFrame({
      jsonrpc: '2.0',
      id: request.id,
      error: WINDOW_OWNED.has(request.method) ? { code: 4404, message: 'session_not_shown' } : { code: -32601, message: `unsupported: ${request.method}` },
    })
  }

  respond(id: string, result: Json) {
    this.sendFrame({ jsonrpc: '2.0', id, result })
  }

  private sendFrame(frame: Json) {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('Hermes est déconnecté.')
    this.socket.send(JSON.stringify(frame))
  }

  onEvent(listener: (event: RpcEvent) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async request<T = any>(method: string, params: Json = {}): Promise<T> {
    await this.connect()
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Hermes est déconnecté.')
    const id = `hermesbot-${++this.sequence}`
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Hermes n’a pas répondu à ${method}.`))
      }, 45_000)
      this.pending.set(id, { resolve, reject, timer })
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  close() {
    this.socket?.close()
    this.socket = null
    this.readyPromise = null
    this.rejectPending()
  }
}

export async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(asString(body.detail || body.error, `Erreur HTTP ${response.status}`)) as Error & { status?: number }
    error.status = response.status
    throw error
  }
  return body as T
}

function deliverOpenRequests(client: HermesClient, value: unknown) {
  if (!Array.isArray(value)) return
  for (const item of value) {
    const entry = asObject(item)
    if (typeof entry.id === 'string' && typeof entry.method === 'string') {
      client.receiveServerRequest({ id: entry.id, method: entry.method, params: asObject(entry.params) })
    }
  }
}

/** État réel des sessions vivantes : `profiles.list` ne dit pas si un tour de Bot Chat est en cours. */
async function loadLiveStatuses(client: HermesClient) {
  try {
    const result = await client.request('session.active_list', {})
    const rows: unknown[] = Array.isArray(result?.sessions) ? result.sessions : []
    return new Map(rows.flatMap((value) => {
      const row = asObject(value)
      const status = asString(row.status)
      return [asString(row.session_key), asString(row.id)].filter(Boolean).map((id) => [id, status] as const)
    }))
  } catch {
    return new Map<string, string>() // gateway plus ancienne : le statut vient alors des événements et des workers
  }
}

/** Relecture sans effet de bord des derniers événements d’une session : utile pour un bot pas encore ouvert. */
export async function loadSessionEvents(client: HermesClient, profile: string, sessionId: string, lastSeen: number) {
  const result = await client.request('session.events.since', { profile, session_id: sessionId, last_seen: lastSeen })
  deliverOpenRequests(client, result?.open_requests)
  return { events: (Array.isArray(result?.events) ? result.events : []) as RpcEvent[], latestSeq: asNumber(result?.latest_seq, lastSeen) }
}

export async function loadRoster(client: HermesClient): Promise<RosterResponse> {
  const [result, live] = await Promise.all([client.request('profiles.list', { include_sessions: true }), loadLiveStatuses(client)])
  const profiles = Array.isArray(result?.profiles) ? result.profiles : []
  const bots = profiles.flatMap((value: unknown, index: number) => {
    const profile = asObject(value)
    const slug = asString(profile.name)
    const metadata = asObject(asObject(profile.ui_meta)['hermes-bots'])
    if (!slug || profile.is_default || Object.keys(metadata).length === 0) return []
    const canonical = asObject(profile.canonical_session)
    const worker = asObject(profile.worker_session)
    const workerActive = asNumber(worker.last_active) * 1000 > Date.now() - WORKER_ACTIVE_MS
    const liveStatus = live.get(asString(canonical.resolved_id)) ?? live.get(asString(canonical.id))
    const turnRunning = canonical.running === true || liveStatus === 'working' || liveStatus === 'starting'
    const status: BotStatus = turnRunning || workerActive ? 'working' : liveStatus === 'waiting' ? 'waiting' : 'idle'
    return [{
      slug,
      sessionId: asString(canonical.resolved_id || canonical.id) || undefined,
      provider: asString(profile.provider) || undefined,
      name: asString(metadata.title || profile.display_name, slug),
      role: asString(metadata.description || profile.description, 'Bot Hermes'),
      section: asString(metadata.sectionName, 'Non classés'),
      sectionId: asString(metadata.sectionId, 'unassigned'),
      model: asString(profile.model, 'Hermes'),
      status,
      workerActive,
      workTitle: workerActive ? asString(worker.title) || undefined : undefined,
      preview: (() => {
        const preview = asString(canonical.preview, 'Aucun message pour le moment')
        return isSilentMessage(preview) ? '' : preview
      })(),
      timestamp: isoDate(canonical.last_active ?? canonical.started_at),
      // Le Bot Chat ne bouge pas pendant une tâche de fond : worker_session et last_session complètent.
      lastActivity: Math.max(0, ...[canonical.last_active ?? canonical.started_at, asObject(profile.last_session).last_active, worker.last_active]
        .map((value) => Date.parse(isoDate(value) ?? '') || 0)),
      unread: 0,
      hidden: metadata.hidden === true,
      avatar: {
        shape: asString(metadata.shape, undefined),
        color: asString(metadata.color, undefined),
      },
      _index: index,
    } satisfies Bot & { _index: number }]
  }).sort((a: Bot & { _index: number }, b: Bot & { _index: number }) => {
    const timeA = a.timestamp ? Date.parse(a.timestamp) : 0
    const timeB = b.timestamp ? Date.parse(b.timestamp) : 0
    return timeB - timeA || a._index - b._index
  }).map(({ _index, ...bot }: Bot & { _index: number }) => bot)
  return { bots, health: { connected: true, label: 'Hermes connecté' } }
}

export async function openChat(client: HermesClient, profile: string, sessionIdHint?: string): Promise<{ chat: ActiveChat; messages: ChatMessage[] }> {
  let sessionId = sessionIdHint || ''
  if (!sessionId) {
    const roster = await client.request('profiles.list', { include_sessions: true })
    const item = (roster?.profiles || []).find((value: unknown) => asObject(value).name === profile)
    const canonical = asObject(asObject(item).canonical_session)
    sessionId = asString(canonical.resolved_id || canonical.id)
  }

  if (!sessionId) {
    const listed = await client.request('session.list', { profile, title: 'Bot Chat', include_hidden: true, limit: 200 })
    const found = (listed?.sessions || []).find((value: unknown) => asObject(value).root_title === 'Bot Chat' || asObject(value).title === 'Bot Chat')
    const foundSession = asObject(found)
    sessionId = asString(foundSession.resolved_id || foundSession.session_id || foundSession.id)
  }
  if (!sessionId) {
    const created = await client.request('session.create', {
      profile,
      request_id: crypto.randomUUID(),
      source: 'gui',
      title: 'Bot Chat',
      hidden: true,
    })
    sessionId = asString(created?.session_id || created?.stored_session_id)
  }
  if (!sessionId) throw new Error('Le Bot Chat est introuvable.')

  const snapshot = await client.request('session.resume', {
    profile,
    session_id: sessionId,
    source: 'gui',
    omit_messages: false,
    display_projection: true,
  })
  deliverOpenRequests(client, snapshot?.open_requests)
  const rawMessages = snapshot?.display_messages || snapshot?.messages || []
  let messages = rawMessages.map(mapMessage).filter(Boolean) as ChatMessage[]
  if (messages.length === 0) {
    const history = await client.request('session.history', { profile, session_id: sessionId })
    messages = (history?.messages || []).map(mapMessage).filter(Boolean) as ChatMessage[]
  }
  return {
    chat: {
      profile,
      sessionId,
      revision: asNumber(snapshot?.revision),
      executionGeneration: asNumber(snapshot?.execution_generation, 1),
      replayEpoch: asString(snapshot?.replay_epoch, undefined),
      subscriptionId: asString(snapshot?.subscription_id, undefined),
      running: snapshot?.running === true,
      model: asString(asObject(snapshot?.info).model) || undefined,
      socketGeneration: client.generation,
    },
    messages,
  }
}

export async function submitPrompt(client: HermesClient, chat: ActiveChat, text: string, attachments: { path: string; mime: string }[] = []) {
  return client.request('prompt.submit', {
    profile: chat.profile,
    session_id: chat.sessionId,
    submission_id: crypto.randomUUID(),
    text,
    queued: false,
    ...(attachments.length ? { attachments } : {}),
  })
}

export async function interruptChat(client: HermesClient, chat: ActiveChat) {
  return client.request('session.interrupt', {
    profile: chat.profile,
    session_id: chat.sessionId,
    execution_generation: chat.executionGeneration,
  })
}

export async function loadModelOptions(client: HermesClient, profile: string, sessionId?: string): Promise<{ options: ModelOption[]; current: string }> {
  const result = await client.request('model.options', { profile, ...(sessionId ? { session_id: sessionId } : {}) })
  const options: ModelOption[] = []
  for (const value of Array.isArray(result?.providers) ? result.providers : []) {
    const provider = asObject(value)
    if (provider.authenticated === false) continue
    const slug = asString(provider.slug)
    const unavailable = new Set(Array.isArray(provider.unavailable_models) ? provider.unavailable_models : [])
    const pricing = asObject(provider.pricing)
    for (const model of Array.isArray(provider.models) ? provider.models : []) {
      if (typeof model !== 'string' || unavailable.has(model)) continue
      const price = asObject(pricing[model])
      options.push({
        model,
        provider: slug,
        providerName: asString(provider.name, slug),
        inputPrice: asString(price.input) || undefined,
        outputPrice: asString(price.output) || undefined,
      })
    }
  }
  return { options, current: asString(result?.model) }
}

/** Mutation bornée par révision : le choix reste sur ce Bot Chat, le profil Hermes n’est jamais réécrit. */
export async function switchModel(client: HermesClient, chat: ActiveChat, option: ModelOverride, confirmation?: string) {
  let revision = chat.revision
  let generation = chat.executionGeneration

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await client.request('session.mutate', {
        profile: chat.profile,
        session_id: chat.sessionId,
        request_id: crypto.randomUUID(),
        expected_revision: revision,
        expected_generation: generation,
        operation: 'model',
        payload: {
          model: option.model,
          provider: option.provider,
          ...(confirmation ? { confirm: confirmation } : {}),
        },
      })
      return {
        ...result,
        ...(result?.status === 'confirmation_required' ? { confirm_required: true } : {}),
        ...(result?.status === 'deferred' ? { deferred: true } : {}),
      }
    } catch (error) {
      const data = asObject((error as { data?: unknown })?.data)
      const reason = asString(data.reason) || (error instanceof Error ? error.message : '')
      const retryable = reason === 'revision_conflict' || reason === 'stale_generation'
      if (attempt > 0 || !retryable || typeof data.revision !== 'number') throw error
      revision = data.revision
      generation = asNumber(data.execution_generation, generation)
    }
  }

  throw new Error('Changement de modèle refusé.')
}

export function parseUsage(value: unknown): SessionUsage | null {
  const usage = asObject(value)
  if (Object.keys(usage).length === 0) return null
  return {
    contextUsed: asNumber(usage.context_used),
    contextMax: asNumber(usage.context_max),
    contextPercent: asNumber(usage.context_percent),
    averageTps: asNumber(usage.avg_tps),
    inputTokens: asNumber(usage.input),
    outputTokens: asNumber(usage.output),
    totalTokens: asNumber(usage.total),
  }
}

export async function loadUsage(client: HermesClient, chat: ActiveChat) {
  return parseUsage(await client.request('session.usage', { profile: chat.profile, session_id: chat.sessionId }))
}

export async function loadRoutines(profile: string): Promise<Routine[]> {
  const result = await fetchJson<{ jobs?: Json[] } | Json[]>(`/api/hermes/cron/jobs?profile=${encodeURIComponent(profile)}`)
  const jobs = Array.isArray(result) ? result : result.jobs || []
  return jobs.map((job) => {
    const schedule = asObject(job.schedule)
    return {
      id: asString(job.id),
      name: asString(job.name, 'Routine'),
      schedule: asString(job.schedule_display || schedule.display || schedule.expr),
      scheduleText: asString(job.schedule_display || schedule.display || schedule.expr, 'Planifiée'),
      enabled: job.enabled === true,
      nextRunAt: isoDate(job.next_run_at),
      lastRunAt: isoDate(job.last_run_at),
    }
  })
}
