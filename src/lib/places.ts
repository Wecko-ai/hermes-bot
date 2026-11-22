import { isServablePath } from './media'

/**
 * Shared `hermes-places` contract: a fenced code block labelled `hermes-places` holds a JSON
 * document `{version: 1, generated_at, attributions, warnings, places}` with 1 to 3 places.
 * The parser is strict: anything that does not match the contract returns null and the block
 * stays inert (rendered as a plain code block). Web and review texts are hostile data: they are
 * carried as opaque strings and never interpreted.
 */
export const PLACES_FENCE = 'hermes-places'

export interface PlacePhoto {
  /** Absolute path on the gateway's machine, served through the local media proxy only. */
  path: string
  attribution: string
  source_url?: string
}

export interface PlaceReview {
  text: string
  rating?: number
  published_at?: string
  author?: string
  source: string
  url?: string
  translation?: string
}

export interface PlaceRating {
  value: number
  count: number
  source: string
}

export interface PlaceDistance {
  meters: number
  seconds?: number
  kind: 'route' | 'straight_line'
  source: string
}

export interface PlaceOpening {
  status: 'open' | 'closed' | 'unknown'
  label: string
  timezone: string
}

export interface PlaceFeatures {
  wifi: boolean | null
  power_outlets: boolean | null
}

export interface PlaceSource {
  name: string
  url?: string
  fetched_at: string
}

export interface Place {
  id: string
  name: string
  address?: string
  latitude: number
  longitude: number
  category: string
  directions_url: string
  source: PlaceSource
  distance?: PlaceDistance
  opening?: PlaceOpening
  features?: PlaceFeatures
  rating?: PlaceRating
  reviews?: PlaceReview[]
  photo?: PlacePhoto
}

export interface PlacesBlock {
  version: 1
  generated_at: string
  attributions: string[]
  warnings: string[]
  places: Place[]
}

export interface PlacesFenceMatch {
  /** Offsets of the whole fenced block in the original Markdown. */
  start: number
  end: number
  /** The JSON text between the fences. */
  source: string
}

const MAX_PLACES = 3
const MAX_REVIEWS = 3
const MAX_LIST = 10
const MAX_METERS = 5_000_000
const MAX_SECONDS = 1_000_000

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ][0-9:.]+)?(?:Z|[+-]\d{2}:?\d{2})?$/
const PHOTO_EXTENSION = /\.(?:png|jpe?g|webp|gif|avif|heic|heif)$/i

const asObject = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null

/** A non-empty string within a sane display size. Returned trimmed; content is kept as data. */
const text = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed && trimmed.length <= max ? trimmed : null
}

const numberIn = (value: unknown, min: number, max: number): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null

const isoDate = (value: unknown): string | null =>
  typeof value === 'string' && ISO_DATE.test(value.trim()) && !Number.isNaN(Date.parse(value)) ? value : null

/** HTTPS URL only: nothing else ever becomes a link target from a fence. */
export const httpsUrl = (value: unknown, max = 2000): string | null => {
  if (typeof value !== 'string' || value.length > max) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? value : null
  } catch {
    return null
  }
}

/**
 * A directions link must be a Google Maps walking URL, served over HTTPS. `maps.app.goo.gl`
 * short links always resolve to Maps; longer google.com links must point at /maps and carry a
 * walking mode (`travelmode=walking`, `dir_action=walk` or the `!3e2` flag in `data=` URLs).
 */
export function validDirectionsUrl(value: unknown, latitude?: number, longitude?: number): string | null {
  const candidate = httpsUrl(value)
  if (!candidate) return null
  let url: URL
  try { url = new URL(candidate) } catch { return null }
  const host = url.hostname.toLowerCase()
  const googleHost = host === 'google.com' || host.endsWith('.google.com') || host === 'maps.app.goo.gl'
  if (!googleHost) return null
  if (host === 'maps.app.goo.gl') {
    // A short link hides its destination: it cannot be tied to the place's coordinates.
    return latitude === undefined && longitude === undefined ? candidate : null
  }
  if (!url.pathname.startsWith('/maps')) return null
  if (latitude !== undefined || longitude !== undefined) {
    if (latitude === undefined || longitude === undefined || url.pathname !== '/maps/dir/') return null
    const destination = url.searchParams.get('destination')?.split(',').map(Number)
    if (!destination || destination.length !== 2 || destination.some((part) => !Number.isFinite(part))) return null
    const tolerance = 0.000001
    if (Math.abs(destination[0] - latitude) > tolerance || Math.abs(destination[1] - longitude) > tolerance) return null
  }
  const walking = url.searchParams.get('travelmode') === 'walking'
    || url.searchParams.get('dir_action') === 'walk'
    || /(^|[!&#?/])3e2([!&#/$]|$)/.test(`${url.pathname}${url.search}${url.hash}`)
  return walking ? candidate : null
}

/** Photos come from the local MEDIA proxy: absolute paths with an image extension, never a URL. */
export function validPhotoPath(value: unknown): string | null {
  const path = text(value, 1000)
  return path && isServablePath(path) && PHOTO_EXTENSION.test(path) ? path : null
}

const stringList = (value: unknown, maxItems: number, maxLength: number): string[] | null => {
  if (!Array.isArray(value)) return null
  if (value.length > maxItems) return null
  const items: string[] = []
  for (const entry of value) {
    const item = text(entry, maxLength)
    if (item === null) return null
    items.push(item)
  }
  return items
}

function parseFeatures(value: unknown): PlaceFeatures | null {
  const object = asObject(value)
  if (!object) return null
  // `undefined` and `null` mean unknown; a boolean is the fact itself; anything else is invalid.
  const flag = (entry: unknown): { ok: boolean; value: boolean | null } =>
    entry === undefined || entry === null ? { ok: true, value: null }
    : typeof entry === 'boolean' ? { ok: true, value: entry }
    : { ok: false, value: null }
  const wifi = flag(object.wifi)
  const power = flag(object.power_outlets)
  if (!wifi.ok || !power.ok) return null
  return { wifi: wifi.value, power_outlets: power.value }
}

function parseDistance(value: unknown): PlaceDistance | null {
  const object = asObject(value)
  if (!object) return null
  const meters = numberIn(object.meters, 0, MAX_METERS)
  const kind = object.kind === 'route' || object.kind === 'straight_line' ? object.kind : null
  const source = text(object.source, 200)
  let seconds: number | undefined
  if (object.seconds !== undefined) {
    const parsed = numberIn(object.seconds, 0, MAX_SECONDS)
    if (parsed === null) return null
    seconds = parsed
  }
  if (meters === null || !kind || source === null) return null
  return seconds === undefined ? { meters, kind, source } : { meters, seconds, kind, source }
}

function parseOpening(value: unknown): PlaceOpening | null {
  const object = asObject(value)
  if (!object) return null
  const status = object.status === 'open' || object.status === 'closed' || object.status === 'unknown' ? object.status : null
  const label = text(object.label, 300)
  const timezone = text(object.timezone, 100)
  return status && label !== null && timezone !== null ? { status, label, timezone } : null
}

function parseRating(value: unknown): PlaceRating | null {
  const object = asObject(value)
  if (!object) return null
  const rating = numberIn(object.value, 0, 5)
  const count = numberIn(object.count, 0, 1_000_000)
  const source = text(object.source, 200)
  return rating === null || count === null || count !== Math.round(count) || source === null ? null : { value: rating, count, source }
}

function parseReview(value: unknown): PlaceReview | null {
  const object = asObject(value)
  if (!object) return null
  const body = text(object.text, 2000)
  const source = text(object.source, 200)
  if (body === null || source === null) return null
  // A supplied field that does not parse makes the whole block inert: nothing is silently rewritten.
  let rating: number | undefined
  if (object.rating !== undefined) {
    const parsed = numberIn(object.rating, 0, 5)
    if (parsed === null) return null
    rating = parsed
  }
  let publishedAt: string | undefined
  if (object.published_at !== undefined) {
    const parsed = isoDate(object.published_at)
    if (parsed === null) return null
    publishedAt = parsed
  }
  let author: string | undefined
  if (object.author !== undefined) {
    const parsed = text(object.author, 100)
    if (parsed === null) return null
    author = parsed
  }
  let url: string | undefined
  if (object.url !== undefined) {
    const parsed = httpsUrl(object.url)
    if (!parsed) return null
    url = parsed
  }
  let translation: string | undefined
  if (object.translation !== undefined) {
    const parsed = text(object.translation, 2000)
    if (parsed === null) return null
    translation = parsed
  }
  return { text: body, rating, published_at: publishedAt, author, source, url, translation }
}

function parsePhoto(value: unknown): PlacePhoto | null {
  const object = asObject(value)
  if (!object) return null
  const path = validPhotoPath(object.path)
  const attribution = text(object.attribution, 300)
  if (!path || attribution === null) return null
  let sourceUrl: string | undefined
  if (object.source_url !== undefined) {
    const parsed = httpsUrl(object.source_url)
    if (!parsed) return null
    sourceUrl = parsed
  }
  return { path, attribution, source_url: sourceUrl }
}

function parseSource(value: unknown): PlaceSource | null {
  const object = asObject(value)
  if (!object) return null
  const name = text(object.name, 200)
  const fetchedAt = isoDate(object.fetched_at)
  if (name === null || fetchedAt === null) return null
  let url: string | undefined
  if (object.url !== undefined) {
    const parsed = httpsUrl(object.url)
    if (!parsed) return null
    url = parsed
  }
  return { name, url, fetched_at: fetchedAt }
}

function parsePlace(value: unknown): Place | null {
  const object = asObject(value)
  if (!object) return null
  const id = text(object.id, 200)
  const name = text(object.name, 200)
  const category = text(object.category, 100)
  const latitude = numberIn(object.latitude, -90, 90)
  const longitude = numberIn(object.longitude, -180, 180)
  const directions = latitude === null || longitude === null ? null : validDirectionsUrl(object.directions_url, latitude, longitude)
  const source = parseSource(object.source)
  if (!id || !name || !category || latitude === null || longitude === null || !directions || !source) return null
  const place: Place = { id, name, category, latitude, longitude, directions_url: directions, source }
  const address = object.address === undefined ? undefined : text(object.address, 300)
  if (object.address !== undefined && address === null) return null
  if (address !== null && address !== undefined) place.address = address
  if (object.distance !== undefined) {
    const distance = parseDistance(object.distance)
    if (!distance) return null
    place.distance = distance
  }
  if (object.opening !== undefined) {
    const opening = parseOpening(object.opening)
    if (!opening) return null
    place.opening = opening
  }
  if (object.features !== undefined) {
    const features = parseFeatures(object.features)
    if (!features) return null
    place.features = features
  }
  if (object.rating !== undefined) {
    const rating = parseRating(object.rating)
    if (!rating) return null
    place.rating = rating
  }
  if (object.reviews !== undefined) {
    if (!Array.isArray(object.reviews) || object.reviews.length > MAX_REVIEWS) return null
    const reviews: PlaceReview[] = []
    for (const entry of object.reviews) {
      const review = parseReview(entry)
      if (!review) return null
      reviews.push(review)
    }
    place.reviews = reviews
  }
  if (object.photo !== undefined) {
    const photo = parsePhoto(object.photo)
    if (!photo) return null
    place.photo = photo
  }
  return place
}

/**
 * The JSON between the fences, or null when it does not satisfy the contract. Strict on
 * purpose: an invalid or hostile block must stay inert rather than render half of its data.
 */
export function parsePlacesBlock(source: string): PlacesBlock | null {
  let document: unknown
  try {
    document = JSON.parse(source)
  } catch {
    return null
  }
  const root = asObject(document)
  if (!root || root.version !== 1) return null
  const generatedAt = isoDate(root.generated_at)
  const attributions = stringList(root.attributions, MAX_LIST, 500)
  const warnings = stringList(root.warnings, MAX_LIST, 500)
  if (generatedAt === null || attributions === null || warnings === null) return null
  if (!Array.isArray(root.places) || root.places.length < 1 || root.places.length > MAX_PLACES) return null
  const places: Place[] = []
  for (const entry of root.places) {
    const place = parsePlace(entry)
    if (!place) return null
    places.push(place)
  }
  return { version: 1, generated_at: generatedAt, attributions, warnings, places }
}

const FENCE = /(^|\n) {0,3}`{3,}hermes-places[ \t]*\r?\n([\s\S]*?)\r?\n {0,3}`{3,}[ \t]*(?=\n|$)/g

/** Every complete `hermes-places` fence in the Markdown, with the offsets of the whole block. */
export function findPlacesFences(markdown: string): PlacesFenceMatch[] {
  const matches: PlacesFenceMatch[] = []
  const pattern = new RegExp(FENCE.source, FENCE.flags)
  let match: RegExpExecArray | null
  while ((match = pattern.exec(markdown))) {
    const start = match.index + match[1].length
    matches.push({ start, end: pattern.lastIndex, source: match[2] })
  }
  return matches
}
