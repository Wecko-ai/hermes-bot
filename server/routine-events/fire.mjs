const PROMPT_TAIL = '\n\n---\n'

export async function fetchJobPrompt(fetchGateway, profile, jobId) {
  const response = await fetchGateway(`/api/cron/jobs/${encodeURIComponent(jobId)}?profile=${encodeURIComponent(profile)}`)
  if (!response.ok) return ''
  const job = await response.json().catch(() => ({}))
  return typeof job.prompt === 'string' ? job.prompt : (typeof job.prompt_preview === 'string' ? job.prompt_preview : '')
}

export async function fireRoutineWithExtra({ fetchGateway, profile, jobId, source, extraText, appendRun }) {
  const base = await fetchJobPrompt(fetchGateway, profile, jobId)
  const merged = `${base}${PROMPT_TAIL}[Routine event: ${source}]\n${extraText}`.slice(0, 120_000)
  const params = `profile=${encodeURIComponent(profile)}`
  const restoreBody = JSON.stringify({ updates: { prompt: base } })
  const runBody = JSON.stringify({ updates: { prompt: merged } })
  try {
    const put = await fetchGateway(`/api/cron/jobs/${encodeURIComponent(jobId)}?${params}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: runBody,
    })
    if (!put.ok) {
      await appendRun({ profile, jobId, source, ok: false, at: new Date().toISOString(), detail: 'prompt_update_failed' })
      return { ok: false, status: put.status }
    }
    const trigger = await fetchGateway(`/api/cron/jobs/${encodeURIComponent(jobId)}/trigger?${params}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    const ok = trigger.ok
    await appendRun({ profile, jobId, source, ok, at: new Date().toISOString(), detail: ok ? '' : 'trigger_failed' })
    return { ok, status: trigger.status }
  } finally {
    await fetchGateway(`/api/cron/jobs/${encodeURIComponent(jobId)}?${params}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: restoreBody,
    }).catch(() => {})
  }
}