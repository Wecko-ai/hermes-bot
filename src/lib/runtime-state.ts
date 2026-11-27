import type { AnsweredBy, SessionUsage } from '../types'
import { parseModelFallback } from './auto-context'
import { isAutoModel } from './auto-router'
import { isDelegateModel } from './delegate'
import { composerReadout } from './turn-model'

export type RuntimeRole = 'chat' | 'chef' | 'worker' | 'vision' | 'fallback' | 'normal_after_worker_down'

export interface ActiveMission {
  id: string
  slot: number
  status: 'running' | 'completed' | 'failed' | 'partial'
  seconds?: number
  workerModel?: string
  workerLabel?: string
  contextUsed?: number
  contextMax?: number
  tps?: number
}

export interface LiveRuntime {
  role: RuntimeRole
  model: string
  provider: string
  baseUrl?: string
  contextUsed?: number
  contextMax?: number
  tps?: number
  reason?: string
  attempt?: number
  maxAttempts?: number
  mission?: ActiveMission | null
  missions?: ActiveMission[]
  previous?: { model: string; why?: string } | null
  pending: boolean
  updatedAt: number
}

export interface TurnModelTruth {
  picker: string
  session: string
  runtime: LiveRuntime | null
}

const ROLES: readonly RuntimeRole[] = ['chat', 'chef', 'worker', 'vision', 'fallback', 'normal_after_worker_down']

export function sameModelId(a?: string, b?: string): boolean {
  const norm = (v?: string) => (v || '').trim().toLowerCase().replace(/^custom:/, '')
  const x = norm(a)
  const y = norm(b)
  if (!x || !y) return x === y
  if (x === y) return true
  if (x.endsWith(`/${y}`) || y.endsWith(`/${x}`)) return true
  const lastSlash = (v: string) => v.slice(v.lastIndexOf('/') + 1)
  return lastSlash(x) === lastSlash(y)
}

export function isStaleOmlxProvider(provider?: string, model?: string): boolean {
  const p = (provider || '').trim().toLowerCase().replace(/^custom:/, '')
  if (p !== 'omlx') return false
  const m = (model || '').trim().toLowerCase()
  if (!m) return false
  if (m.includes('inkling') || m.includes('mlx') || m.includes('gguf') || m.includes('jundot') || m.includes('qwen3.8')) return false
  return true
}

function readString(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return undefined
}

function readNumber(obj: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v)
  }
  return undefined
}

function readMission(value: unknown): ActiveMission | null {
  if (!value || typeof value !== 'object') return null
  const o = value as Record<string, unknown>
  const id = typeof o.id === 'string' ? o.id : undefined
  const status = o.status
  if (!id || !status || !['running', 'completed', 'failed', 'partial'].includes(String(status))) return null
  return {
    id,
    slot: typeof o.slot === 'number' ? o.slot : Number.isFinite(Number(o.slot)) ? Number(o.slot) : 0,
    status: status as ActiveMission['status'],
    seconds: readNumber(o, 'seconds'),
    workerModel: readString(o, 'workerModel', 'worker_model'),
    workerLabel: readString(o, 'workerLabel', 'worker_label'),
    contextUsed: readNumber(o, 'contextUsed', 'context_used'),
    contextMax: readNumber(o, 'contextMax', 'context_max'),
    tps: readNumber(o, 'tps', 'avg_tps'),
  }
}

export function parseRuntimeEvent(payload: unknown): Partial<LiveRuntime> | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>

  const role = readString(p, 'role')
  if (role && !ROLES.includes(role as RuntimeRole)) return null

  const out: Partial<LiveRuntime> = {}
  if (role) out.role = role as RuntimeRole

  const model = readString(p, 'model')
  if (model) out.model = model

  const rawProvider = readString(p, 'provider')
  if (rawProvider !== undefined) {
    if (isStaleOmlxProvider(rawProvider, model)) {
      out.provider = ''
    } else {
      out.provider = rawProvider
    }
  }

  const baseUrl = readString(p, 'base_url', 'baseUrl')
  if (baseUrl) out.baseUrl = baseUrl

  const contextUsed = readNumber(p, 'context_used', 'contextUsed')
  if (contextUsed !== undefined) out.contextUsed = contextUsed
  const contextMax = readNumber(p, 'context_max', 'contextMax')
  if (contextMax !== undefined) out.contextMax = contextMax
  const tps = readNumber(p, 'tps')
  if (tps !== undefined) out.tps = tps
  const reason = readString(p, 'reason')
  if (reason) out.reason = reason
  const attempt = readNumber(p, 'attempt')
  if (attempt !== undefined) out.attempt = attempt
  const maxAttempts = readNumber(p, 'max_attempts', 'maxAttempts')
  if (maxAttempts !== undefined) out.maxAttempts = maxAttempts

  if (p.previous !== undefined) {
    const prev = p.previous
    if (prev && typeof prev === 'object') {
      const po = prev as Record<string, unknown>
      const pm = readString(po, 'model')
      if (pm) out.previous = { model: pm, why: readString(po, 'why') }
      else out.previous = null
    } else if (prev === null) out.previous = null
  }

  if (p.mission !== undefined) {
    out.mission = p.mission === null ? null : readMission(p.mission)
  }
  if (p.missions !== undefined) {
    if (Array.isArray(p.missions)) {
      out.missions = p.missions.map(readMission).filter((m): m is ActiveMission => m !== null)
    } else out.missions = []
  }

  return out
}

export function reduceLiveRuntime(
  current: LiveRuntime | null,
  event: { type: string; payload: Record<string, unknown> },
  _selectedModel?: string,
): LiveRuntime | null {
  if (event.type === 'message.start') {
    return { role: 'chat', model: '', provider: '', mission: null, missions: [], previous: null, pending: true, updatedAt: Date.now() }
  }

  if (event.type === 'runtime.now') {
    const parsed = parseRuntimeEvent(event.payload)
    if (!parsed) return current
    const merged: LiveRuntime = {
      ...(current ?? { role: 'chat' as RuntimeRole, model: '', provider: '', missions: [], previous: null, pending: false, updatedAt: Date.now() }),
      ...parsed,
      pending: false,
      updatedAt: Date.now(),
    }
    if (parsed.mission === undefined) merged.mission = current?.mission ?? null
    if (parsed.missions === undefined) merged.missions = current?.missions ?? []
    if (parsed.previous === undefined) merged.previous = current?.previous ?? null
    else if (parsed.previous === null) merged.previous = null
    if (parsed.attempt === undefined) delete merged.attempt
    if (parsed.maxAttempts === undefined) delete merged.maxAttempts
    if (parsed.contextMax === undefined && parsed.contextUsed === undefined) {
      const modelChanged = parsed.model && current?.model && !sameModelId(parsed.model, current.model)
      if (modelChanged || parsed.mission === null) {
        delete merged.contextUsed
        delete merged.contextMax
        delete merged.tps
      }
    }
    return merged
  }

  if (event.type === 'session.usage') {
    const p = event.payload || {}
    const usage = (p.usage && typeof p.usage === 'object' ? p.usage as Record<string, unknown> : p) as Record<string, unknown>
    const currentRec = current
    if (currentRec?.role === 'worker' && currentRec?.mission?.status === 'running') {
      // Keep worker identity and mission; refresh only numbers/model fields.
      const model = readString(usage, 'model') ?? currentRec.model
      const providerRaw = readString(usage, 'provider')
      const provider = providerRaw !== undefined ? (isStaleOmlxProvider(providerRaw, model) ? '' : providerRaw) : currentRec.provider
      return {
        ...currentRec,
        model,
        provider,
        pending: false,
        updatedAt: Date.now(),
      }
    }
    const model = readString(usage, 'model') ?? current?.model ?? ''
    const providerRaw = readString(usage, 'provider')
    const provider = providerRaw !== undefined ? (isStaleOmlxProvider(providerRaw, model) ? '' : providerRaw) : (current?.provider ?? '')
    return {
      ...(current ?? { role: 'chat' as RuntimeRole, model: '', provider: '', missions: [], previous: null, updatedAt: Date.now() }),
      model,
      provider,
      contextUsed: undefined,
      contextMax: undefined,
      tps: undefined,
      pending: false,
      updatedAt: Date.now(),
    }
  }

  if (event.type === 'status.update') {
    const fb = parseModelFallback(event.payload?.text)
    if (fb) {
      return {
        role: 'fallback',
        model: fb.toModel,
        provider: fb.toProvider,
        reason: fb.reason || 'fallback',
        previous: { model: fb.fromModel, why: fb.reason || undefined },
        pending: true,
        updatedAt: Date.now(),
      }
    }
    return current
  }

  if (event.type === 'message.complete') {
    if (!current) return null
    return {
      ...current,
      pending: false,
      mission: current.mission ? { ...current.mission, status: current.mission.status === 'running' ? 'completed' : current.mission.status } : current.mission,
    }
  }

  return current
}

export function effectiveContextUsage(
  usage: SessionUsage | null,
  runtime: LiveRuntime | null,
  input: { running: boolean; fresh: boolean; answered: AnsweredBy | null; selectedModel?: string },
): (SessionUsage & { scope?: 'worker' | 'turn' }) | null {
  if (runtime?.mission?.status === 'running' && (runtime.mission.contextMax ?? 0) > 0) {
    const mission = runtime.mission
    return {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextUsed: mission.contextUsed ?? 0,
      contextMax: mission.contextMax!,
      contextPercent: Math.min(100, ((mission.contextUsed ?? 0) / mission.contextMax!) * 100),
      averageTps: mission.tps ?? 0,
      model: mission.workerModel,
      scope: 'worker',
    }
  }

  if (runtime?.pending) return null

  if (runtime && runtime.model) {
    if ((runtime.contextMax ?? 0) > 0) {
      return {
        ...(usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextUsed: 0, contextMax: 0, contextPercent: 0, averageTps: 0 }),
        contextUsed: runtime.contextUsed ?? 0,
        contextMax: runtime.contextMax!,
        contextPercent: Math.min(100, ((runtime.contextUsed ?? 0) / runtime.contextMax!) * 100),
        averageTps: runtime.tps ?? usage?.averageTps ?? 0,
        model: runtime.model,
        provider: runtime.provider || undefined,
        scope: 'turn',
      }
    }
    const base = composerReadout(usage, input)
    if (!base) return null
    if (base.model && !sameModelId(base.model, runtime.model)) return null
    return { ...base, scope: 'turn' }
  }

  const base = composerReadout(usage, input)
  if (!base) return null
  if (input.running && input.selectedModel && !isAutoModel(input.selectedModel) && !isDelegateModel(input.selectedModel) && !input.answered && base.model && !sameModelId(base.model, input.selectedModel)) return null
  return { ...base, scope: 'turn' }
}
