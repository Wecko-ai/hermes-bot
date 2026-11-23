export function startEmailWatcher({ store, adapter, fire, fetchGateway, pollMs = 60_000 }) {
  let timer = null
  let busy = false

  const tick = async () => {
    if (busy) return
    busy = true
    try {
      const hooks = await store.listEmailHooks()
      for (const hook of hooks) {
        const interval = Math.max(5, hook.pollMinutes || 5) * 60_000
        const last = hook.lastPollAt ? Date.parse(hook.lastPollAt) : 0
        if (Date.now() - last < interval) continue
        const messages = await adapter.search(hook.emailQuery)
        const seen = new Set(hook.seenMessageIds || [])
        const fresh = messages.filter((row) => row?.id && !seen.has(row.id))
        if (!fresh.length) {
          await store.markSeen(hook.hookId, [])
          continue
        }
        for (const mail of fresh.slice(0, 5)) {
          const body = [`From: ${mail.from || ''}`, `Subject: ${mail.subject || ''}`, '', mail.snippet || ''].join('\n')
          await fire({
            fetchGateway,
            profile: hook.profile,
            jobId: hook.jobId,
            source: 'email',
            extraText: body,
            appendRun: store.appendRun.bind(store),
          })
        }
        await store.markSeen(hook.hookId, fresh.map((row) => row.id))
      }
    } finally {
      busy = false
    }
  }

  return {
    start() {
      if (timer) return
      timer = setInterval(() => { tick().catch(() => {}) }, pollMs)
      timer.unref?.()
      tick().catch(() => {})
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    tick,
  }
}