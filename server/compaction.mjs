// Context compaction setting (Settings > Conversations). Hermes compacts a conversation when its context
// reaches `compression.threshold` (a ratio of the model window) or `compression.threshold_tokens` (an
// absolute cap), whichever is lower. Two modes:
//   auto   Hermes decides with the settings of each profile: nothing is written.
//   manual the user's gauge is the limit: Hermes keeps only a safety net (threshold 0.98, no cap), the app
//          warns and blocks at the user's own limit. The previous values are snapshotted to restore later.
// Only these two keys of a profile's config are ever sent to Hermes, built here from numbers: the page
// never sends configuration, only the mode, the gauge and the profile names.

export const SAFETY_NET_THRESHOLD = 0.98
/** What Hermes uses when a profile sets nothing (config_defaults.py). */
export const HERMES_DEFAULT_THRESHOLD = 0.5
export const GAUGE_MIN = 0.1
export const GAUGE_MAX = 1
export const MAX_PROFILES = 300
export const COMPACTION_BODY_MAX_BYTES = 64 * 1024
export const PROFILE_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/

const isRatio = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1
const isTokens = (value) => typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 1e9

/** A gauge kept to two decimals, inside 10 % to 100 %; anything else is refused. */
export function gaugeFrom(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const rounded = Math.round(value * 100) / 100
  return rounded >= GAUGE_MIN && rounded <= GAUGE_MAX ? rounded : null
}

/** One profile's two values, `null` meaning "not set": the shape of a snapshot entry. */
export function compressionFrom(value) {
  const source = value && typeof value === 'object' ? value : {}
  return {
    threshold: isRatio(source.threshold) ? source.threshold : null,
    threshold_tokens: isTokens(source.threshold_tokens) ? source.threshold_tokens : null,
  }
}

/** The setting as kept in the shared settings file: mode, gauge, and the snapshot of each profile. */
export function compactionFrom(value) {
  const source = value && typeof value === 'object' ? value : null
  if (!source) return null
  const gauge = gaugeFrom(source.gauge) ?? 1
  const snapshot = {}
  if (source.snapshot && typeof source.snapshot === 'object') {
    for (const [slug, entry] of Object.entries(source.snapshot).slice(0, MAX_PROFILES)) {
      if (PROFILE_SLUG.test(slug)) snapshot[slug] = compressionFrom(entry)
    }
  }
  return { mode: source.mode === 'manual' ? 'manual' : 'auto', gauge, snapshot }
}

/** Profile names from a request: valid slugs only, no duplicates, a bounded list. */
export function profilesFrom(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((slug) => typeof slug === 'string' && PROFILE_SLUG.test(slug)))].slice(0, MAX_PROFILES)
}

/** What a profile's config says about compaction (`null`: not set there). */
export function compressionOfConfig(config) {
  return compressionFrom(config && typeof config === 'object' ? config.compression : null)
}

/** The body sent to Hermes: these two keys and nothing else. `threshold_tokens: null` means no cap. */
export function compressionBody({ threshold, threshold_tokens: cap }) {
  return { config: { compression: { threshold, threshold_tokens: cap } } }
}

/**
 * What each profile receives, and what the snapshot becomes.
 * `current`: the profile's values now. `previous`: the setting kept so far (null: never saved).
 * Returns `{ write, snapshot }`: `write` is the pair to send (null: nothing to write), `snapshot` the new
 * entry (null: no entry). Pure, so it is tested without a gateway.
 */
export function planProfile({ mode, previous, slug, current }) {
  const entry = previous?.snapshot?.[slug] ?? null
  if (mode === 'manual') {
    // The first snapshot is the one that counts: saving another gauge must not record the safety net.
    // A profile already on the net with no entry (its snapshot was lost) restores to Hermes's defaults later.
    const onNet = current.threshold === SAFETY_NET_THRESHOLD && current.threshold_tokens === null
    return { write: { threshold: SAFETY_NET_THRESHOLD, threshold_tokens: null }, snapshot: entry ?? (onNet ? null : current) }
  }
  if (entry) {
    return { write: { threshold: entry.threshold ?? HERMES_DEFAULT_THRESHOLD, threshold_tokens: entry.threshold_tokens }, snapshot: null }
  }
  // Manual was saved before, but this profile was never snapshotted (created since): Hermes's defaults.
  if (previous?.mode === 'manual') return { write: { threshold: HERMES_DEFAULT_THRESHOLD, threshold_tokens: null }, snapshot: null }
  return { write: null, snapshot: null }
}

/**
 * Applies the setting to the profiles, one after the other. `hermes.read(slug)` returns the profile's
 * config or throws; `hermes.write(slug, body)` throws on failure. A failure of one profile never stops the
 * others: it is listed, and its snapshot entry stays as it was.
 */
export async function applyCompaction({ mode, gauge, profiles, previous, hermes }) {
  const snapshot = { ...(previous?.snapshot ?? {}) }
  const applied = []
  const failed = []
  for (const slug of profiles) {
    try {
      const current = compressionOfConfig(await hermes.read(slug))
      const plan = planProfile({ mode, previous: { ...previous, snapshot }, slug, current })
      if (plan.write) await hermes.write(slug, compressionBody(plan.write))
      if (plan.snapshot) snapshot[slug] = plan.snapshot
      else delete snapshot[slug]
      applied.push(slug)
    } catch {
      failed.push(slug)
    }
  }
  return { settings: { mode, gauge, snapshot }, applied, failed }
}
