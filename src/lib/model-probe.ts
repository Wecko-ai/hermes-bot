/** What the local server learned by asking the model for a tiny reply (server/model-probe.mjs). */
export type ModelProbe =
  | { checked: false }
  | { checked: true; ok: true }
  | { checked: true; ok: false; reason: 'quota' | 'error'; message: string }

/**
 * Asks the local server whether `model` answers right now. Only the model prefixes the installation
 * configured are tried; anything else, or a server that cannot tell, answers `{checked: false}`.
 */
export async function probeModel(model: string): Promise<ModelProbe> {
  try {
    const response = await fetch('/api/model-probe', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    })
    if (!response.ok) return { checked: false }
    const body = await response.json() as Partial<{ checked: boolean; ok: boolean; reason: string; message: string }>
    if (body.checked !== true) return { checked: false }
    if (body.ok === true) return { checked: true, ok: true }
    return { checked: true, ok: false, reason: body.reason === 'quota' ? 'quota' : 'error', message: typeof body.message === 'string' ? body.message : '' }
  } catch {
    return { checked: false }
  }
}
