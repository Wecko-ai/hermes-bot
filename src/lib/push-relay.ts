/** Fire-and-forget iPhone push relay enqueue (server decides focus + debounce). */

export type PushNotifyKind = 'done' | 'question' | 'approval' | 'draft' | 'routine'

export async function enqueuePushRelay(options: { slug: string; title: string; body: string; kind?: PushNotifyKind }) {
  try {
    await fetch('/api/push/enqueue', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: options.slug, title: options.title, body: options.body, kind: options.kind }),
    })
  } catch {
    /* relay is best-effort */
  }
}