import { useEffect, useState, type FormEvent } from 'react'
import { Clock3, Mail, Webhook } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Routine, RoutineTrigger } from '../types'
import {
  EVENT_ONLY_SCHEDULE,
  bindRoutineEvents,
  createRoutine,
  dryRunRoutine,
  previewRoutineSchedule,
  regenerateRoutineHookSecret,
  updateRoutine,
  type RoutineDraft,
} from '../lib/routines'
import { BotSheet } from './BotDialogs'

interface RoutineEditorDialogProps {
  profile: string
  routine?: Routine | null
  eventTriggers?: boolean
  onClose: () => void
  onSaved: () => void
}

const empty = (): RoutineDraft => ({
  name: '',
  prompt: '',
  schedule: '',
  trigger: 'schedule',
  auth: 'bearer',
  preset: 'generic',
  emailQuery: '',
  pollMinutes: 5,
})

export function RoutineEditorDialog({ profile, routine, eventTriggers, onClose, onSaved }: RoutineEditorDialogProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<RoutineDraft>(empty)
  const [expr, setExpr] = useState('')
  const [nextRuns, setNextRuns] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [testReport, setTestReport] = useState('')
  const [hookUrl, setHookUrl] = useState('')
  const [hookSecret, setHookSecret] = useState('')

  useEffect(() => {
    if (!routine) {
      setDraft(empty())
      setExpr('')
      setNextRuns([])
      setHookUrl('')
      setHookSecret('')
      return
    }
    setDraft({
      name: routine.name,
      prompt: routine.prompt || '',
      schedule: routine.scheduleText || routine.schedule,
      trigger: routine.trigger || 'schedule',
      auth: routine.event?.auth || 'bearer',
      preset: routine.event?.preset || 'generic',
      emailQuery: routine.event?.emailQuery || '',
      pollMinutes: routine.event?.pollMinutes || 5,
      hookId: routine.event?.hookId,
      hookUrl: routine.event?.hookUrl,
    })
    setExpr(routine.schedule)
    setNextRuns([])
    setHookUrl(routine.event?.hookUrl || '')
    setHookSecret('')
  }, [routine])

  const trigger = draft.trigger || 'schedule'

  const refreshPreview = async (schedule: string) => {
    if (trigger !== 'schedule') {
      setExpr(EVENT_ONLY_SCHEDULE)
      setNextRuns([])
      return
    }
    try {
      const preview = await previewRoutineSchedule(schedule)
      setExpr(preview.expr)
      setNextRuns(preview.nextRuns)
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('routines.error.generic'))
      setExpr('')
      setNextRuns([])
    }
  }

  const copyHook = async () => {
    if (!hookUrl) return
    try {
      await navigator.clipboard.writeText(hookUrl)
      setTestReport(t('routines.hookCopied'))
    } catch {
      setError(t('routines.hookCopyFailed'))
    }
  }

  const regenerateSecret = async () => {
    if (!draft.hookId) return
    setBusy(true)
    setError('')
    try {
      const result = await regenerateRoutineHookSecret(draft.hookId)
      setHookSecret(result.secret)
      setTestReport(t('routines.secretRegenerated'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('routines.error.generic'))
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      const preview = trigger === 'schedule'
        ? await previewRoutineSchedule(draft.schedule)
        : { expr: EVENT_ONLY_SCHEDULE, nextRuns: [] as string[], display: draft.schedule, source: 'cron' as const }
      const payload = { ...draft, scheduleExpr: preview.expr }
      const job = routine?.id
        ? await updateRoutine(profile, routine.id, payload)
        : await createRoutine(profile, payload)
      if (eventTriggers) {
        const bound = await bindRoutineEvents(profile, job.id, {
          ...draft,
          hookId: draft.hookId,
          secret: hookSecret || undefined,
        })
        setHookUrl(bound.hookUrl || '')
        setHookSecret(bound.secret || hookSecret)
        setDraft((current) => ({ ...current, hookId: bound.hookId, hookUrl: bound.hookUrl }))
      }
      onSaved()
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('routines.error.generic'))
    } finally {
      setBusy(false)
    }
  }

  const test = async () => {
    if (trigger !== 'schedule') {
      setTestReport(t('routines.eventDryRun', { trigger: t(`routines.trigger.${trigger}`) }))
      return
    }
    setBusy(true)
    setError('')
    try {
      const result = await dryRunRoutine(profile, draft)
      setTestReport(t('routines.testReport', {
        name: result.job.name,
        schedule: result.job.scheduleDisplay,
        next: result.job.nextRuns[0] || t('routines.testNoNext'),
      }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('routines.error.generic'))
    } finally {
      setBusy(false)
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    void save()
  }

  const setTrigger = (value: RoutineTrigger) => {
    setDraft((current) => ({ ...current, trigger: value }))
    if (value !== 'schedule') {
      setExpr(EVENT_ONLY_SCHEDULE)
      setNextRuns([])
    }
  }

  return (
    <BotSheet
      title={routine ? t('routines.editTitle') : t('routines.createTitle')}
      icon={trigger === 'webhook' ? <Webhook size={22} /> : trigger === 'email' ? <Mail size={22} /> : <Clock3 size={22} />}
      busy={busy}
      onCancel={onClose}
      onSubmit={submit}
    >
      <label>
        <span>{t('routines.fieldName')}</span>
        <input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
      </label>
      <label>
        <span>{t('routines.fieldPrompt')}</span>
        <textarea rows={4} value={draft.prompt} onChange={(event) => setDraft((current) => ({ ...current, prompt: event.target.value }))} />
      </label>
      {eventTriggers && (
        <label>
          <span>{t('routines.fieldTrigger')}</span>
          <select value={trigger} onChange={(event) => setTrigger(event.target.value as RoutineTrigger)}>
            <option value="schedule">{t('routines.trigger.schedule')}</option>
            <option value="webhook">{t('routines.trigger.webhook')}</option>
            <option value="email">{t('routines.trigger.email')}</option>
          </select>
        </label>
      )}
      {trigger === 'schedule' && (
        <label>
          <span>{t('routines.fieldSchedule')}</span>
          <input
            value={draft.schedule}
            onChange={(event) => setDraft((current) => ({ ...current, schedule: event.target.value }))}
            onBlur={() => void refreshPreview(draft.schedule)}
            placeholder={t('routines.schedulePlaceholder')}
          />
        </label>
      )}
      {eventTriggers && trigger === 'webhook' && (
        <>
          <label>
            <span>{t('routines.fieldWebhookAuth')}</span>
            <select value={draft.auth} onChange={(event) => setDraft((current) => ({ ...current, auth: event.target.value as 'bearer' | 'hmac' }))}>
              <option value="bearer">{t('routines.webhookAuth.bearer')}</option>
              <option value="hmac">{t('routines.webhookAuth.hmac')}</option>
            </select>
          </label>
          <label>
            <span>{t('routines.fieldWebhookPreset')}</span>
            <select value={draft.preset} onChange={(event) => setDraft((current) => ({ ...current, preset: event.target.value as 'generic' | 'github' }))}>
              <option value="generic">{t('routines.webhookPreset.generic')}</option>
              <option value="github">{t('routines.webhookPreset.github')}</option>
            </select>
          </label>
          {hookUrl && (
            <div className="routine-webhook">
              <span>{t('routines.fieldWebhookUrl')}</span>
              <code>{hookUrl}</code>
              <div className="routine-actions">
                <button type="button" onClick={() => void copyHook()}>{t('routines.copyWebhook')}</button>
                {draft.hookId && <button type="button" onClick={() => void regenerateSecret()}>{t('routines.regenerateSecret')}</button>}
              </div>
            </div>
          )}
          {hookSecret && <p className="routine-secret-note">{t('routines.secretOnce', { secret: hookSecret })}</p>}
        </>
      )}
      {eventTriggers && trigger === 'email' && (
        <>
          <label>
            <span>{t('routines.fieldEmailQuery')}</span>
            <input value={draft.emailQuery || ''} onChange={(event) => setDraft((current) => ({ ...current, emailQuery: event.target.value }))} placeholder={t('routines.emailQueryPlaceholder')} />
          </label>
          <label>
            <span>{t('routines.fieldPollMinutes')}</span>
            <input type="number" min={5} max={120} value={draft.pollMinutes || 5} onChange={(event) => setDraft((current) => ({ ...current, pollMinutes: Number(event.target.value) || 5 }))} />
          </label>
          <p className="readonly-note">{t('routines.emailWatcherNote')}</p>
        </>
      )}
      {expr && trigger === 'schedule' && <p className="routine-preview"><code>{expr}</code></p>}
      {nextRuns.length > 0 && (
        <ul className="routine-next-runs">
          {nextRuns.map((run) => <li key={run}>{new Date(run).toLocaleString()}</li>)}
        </ul>
      )}
      {testReport && <p className="routine-test-report">{testReport}</p>}
      {error && <p className="request-error" role="alert">{error}</p>}
      <div className="request-actions">
        <button type="button" onClick={() => void test()} disabled={busy}>{t('routines.test')}</button>
        <button type="button" onClick={onClose} disabled={busy}>{t('botMenu.cancel')}</button>
        <button type="submit" className="is-primary" disabled={busy}>{t('routines.save')}</button>
      </div>
    </BotSheet>
  )
}