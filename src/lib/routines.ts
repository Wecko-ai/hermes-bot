import { i18n } from '../i18n'
import type { Routine, RoutineEventBinding, RoutineRun, RoutineTrigger } from '../types'

export const EVENT_ONLY_SCHEDULE = '0 0 1 1 *'

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', ...init })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = typeof body.error === 'string' ? body.error : i18n.t('routines.error.generic')
    throw new Error(message)
  }
  return body as T
}

function asString(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function mapJob(job: Record<string, unknown>): Routine {
  const schedule = job.schedule && typeof job.schedule === 'object' ? job.schedule as Record<string, unknown> : {}
  return {
    id: asString(job.id),
    name: asString(job.name, i18n.t('hermes.routineDefault')),
    prompt: asString(job.prompt) || asString(job.prompt_preview),
    schedule: asString(job.schedule_display || schedule.display || schedule.expr),
    scheduleText: asString(job.schedule_display || schedule.display || schedule.expr, i18n.t('hermes.scheduled')),
    enabled: job.enabled === true,
    nextRunAt: typeof job.next_run_at === 'string' ? job.next_run_at : null,
    lastRunAt: typeof job.last_run_at === 'string' ? job.last_run_at : null,
  }
}

export interface RoutineDraft {
  name: string
  prompt: string
  schedule: string
  trigger?: RoutineTrigger
  auth?: 'bearer' | 'hmac'
  preset?: 'generic' | 'github'
  emailQuery?: string
  pollMinutes?: number
  hookId?: string
  hookUrl?: string
  secret?: string
}

export interface SchedulePreview {
  expr: string
  display: string
  source: 'cron' | 'natural'
  nextRuns: string[]
}

export async function previewRoutineSchedule(schedule: string): Promise<SchedulePreview> {
  const lang = i18n.language?.startsWith('fr') ? 'fr' : 'en'
  return fetchJson('/api/routines/schedule', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ schedule, lang }),
  })
}

export async function dryRunRoutine(profile: string, draft: RoutineDraft): Promise<{ job: RoutineDraft & { scheduleDisplay: string; nextRuns: string[] } }> {
  const lang = i18n.language?.startsWith('fr') ? 'fr' : 'en'
  return fetchJson('/api/routines/dry-run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile, lang, ...draft }),
  })
}

function cronUrl(path: string, profile: string) {
  return `/api/hermes/cron/jobs${path}?profile=${encodeURIComponent(profile)}`
}

export async function createRoutine(profile: string, draft: RoutineDraft & { scheduleExpr: string }) {
  const payload = {
    name: draft.name.trim(),
    prompt: draft.prompt.trim(),
    schedule: draft.scheduleExpr.trim(),
    deliver: 'local',
  }
  const job = await fetchJson<Record<string, unknown>>(cronUrl('', profile), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return mapJob(job)
}

export async function updateRoutine(profile: string, id: string, draft: RoutineDraft & { scheduleExpr: string }) {
  const payload = {
    updates: {
      name: draft.name.trim(),
      prompt: draft.prompt.trim(),
      schedule: draft.scheduleExpr.trim(),
    },
  }
  const job = await fetchJson<Record<string, unknown>>(cronUrl(`/${encodeURIComponent(id)}`, profile), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return mapJob(job)
}

export async function pauseRoutine(profile: string, id: string) {
  return fetchJson(cronUrl(`/${encodeURIComponent(id)}/pause`, profile), { method: 'POST', body: '{}' })
}

export async function resumeRoutine(profile: string, id: string) {
  return fetchJson(cronUrl(`/${encodeURIComponent(id)}/resume`, profile), { method: 'POST', body: '{}' })
}

export async function triggerRoutine(profile: string, id: string) {
  return fetchJson(cronUrl(`/${encodeURIComponent(id)}/trigger`, profile), { method: 'POST', body: '{}' })
}

export async function deleteRoutine(profile: string, id: string) {
  return fetchJson(cronUrl(`/${encodeURIComponent(id)}`, profile), { method: 'DELETE' })
}

export async function loadRoutineEventBindings(profile: string): Promise<Record<string, RoutineEventBinding>> {
  const body = await fetchJson<{ enabled: boolean; bindings: Record<string, RoutineEventBinding> }>(`/api/routines/events?${new URLSearchParams({ profile })}`)
  return body.enabled ? body.bindings : {}
}

export async function loadRoutineRuns(profile: string, jobId: string): Promise<RoutineRun[]> {
  const body = await fetchJson<{ runs: RoutineRun[] }>(`/api/routines/events/runs?${new URLSearchParams({ profile, jobId })}`)
  return body.runs || []
}

export async function bindRoutineEvents(profile: string, jobId: string, draft: RoutineDraft) {
  return fetchJson<{
    hookId?: string
    secret?: string
    hookUrl?: string
    trigger: RoutineTrigger
    auth?: 'bearer' | 'hmac'
    preset?: 'generic' | 'github'
    emailQuery?: string
    pollMinutes?: number
  }>('/api/routines/events/bind', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      profile,
      jobId,
      trigger: draft.trigger || 'schedule',
      auth: draft.auth,
      preset: draft.preset,
      emailQuery: draft.emailQuery,
      pollMinutes: draft.pollMinutes,
      hookId: draft.hookId,
      secret: draft.secret,
    }),
  })
}

export async function regenerateRoutineHookSecret(hookId: string) {
  return fetchJson<{ secret: string }>('/api/routines/events/regenerate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hookId }),
  })
}

export async function enrichRoutines(profile: string, routines: Routine[]): Promise<Routine[]> {
  let bindings: Record<string, RoutineEventBinding> = {}
  try {
    bindings = await loadRoutineEventBindings(profile)
  } catch {
    return routines
  }
  const enriched = await Promise.all(routines.map(async (routine) => {
    const event = bindings[routine.id]
    const trigger = event?.trigger || 'schedule'
    let runs: RoutineRun[] = []
    if (trigger !== 'schedule') {
      try { runs = await loadRoutineRuns(profile, routine.id) } catch { runs = [] }
    }
    return { ...routine, trigger, event, runs }
  }))
  return enriched
}