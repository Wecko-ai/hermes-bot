import { describe, expect, it } from 'vitest'
import { findPlacesFences, parsePlacesBlock, PLACES_FENCE, validDirectionsUrl, validPhotoPath } from './places'

const WALKING = 'https://www.google.com/maps/dir/?api=1&destination=48.8566%2C2.3522&travelmode=walking'

const basePlace = (overrides: Record<string, unknown> = {}) => ({
  id: 'place-1',
  name: 'Café Central',
  address: '12 rue des Lilas, Paris',
  latitude: 48.8566,
  longitude: 2.3522,
  category: 'cafe',
  directions_url: WALKING,
  source: { name: 'OpenStreetMap', url: 'https://www.openstreetmap.org/', fetched_at: '2026-11-21T10:00:00Z' },
  ...overrides,
})

const block = (places: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({
  version: 1,
  generated_at: '2026-11-21T10:00:00Z',
  attributions: ['Data © OpenStreetMap contributors'],
  warnings: [],
  places,
  ...extra,
})

describe('parsePlacesBlock', () => {
  it('parses a full block with three places', () => {
    const parsed = parsePlacesBlock(block([
      basePlace(),
      basePlace({
        id: 'place-2',
        name: 'Bibliothèque municipale',
        distance: { meters: 850, seconds: 620, kind: 'route', source: 'OSRM' },
        opening: { status: 'open', label: 'Open until 7 PM', timezone: 'Europe/Paris' },
        features: { wifi: true, power_outlets: null },
        rating: { value: 4.5, count: 128, source: 'Google Maps' },
        reviews: [
          { text: 'Quiet and well connected.', rating: 5, published_at: '2026-10-02', author: 'Marie', source: 'Google Maps', url: 'https://maps.google.com/review/1' },
          { text: 'Crowded on Saturdays.', source: 'Google Maps', translation: ' bondé le samedi.' },
          { text: 'Fine.', rating: 3, source: 'Google Maps' },
        ],
        photo: { path: '/media/places/library.jpg', attribution: '© Marie D.', source_url: 'https://example.org/photo' },
      }),
      basePlace({
        id: 'place-3',
        distance: { meters: 300, kind: 'straight_line', source: 'computed' },
        features: { wifi: false, power_outlets: false },
      }),
    ]))
    expect(parsed).not.toBeNull()
    expect(parsed!.places).toHaveLength(3)
    const [first, second, third] = parsed!.places
    expect(first).toMatchObject({ id: 'place-1', name: 'Café Central', latitude: 48.8566, longitude: 2.3522, category: 'cafe' })
    expect(first.distance).toBeUndefined()
    expect(second.distance).toEqual({ meters: 850, seconds: 620, kind: 'route', source: 'OSRM' })
    expect(second.opening).toEqual({ status: 'open', label: 'Open until 7 PM', timezone: 'Europe/Paris' })
    expect(second.features).toEqual({ wifi: true, power_outlets: null })
    expect(second.rating).toEqual({ value: 4.5, count: 128, source: 'Google Maps' })
    expect(second.reviews).toHaveLength(3)
    expect(second.reviews![1]).toMatchObject({ text: 'Crowded on Saturdays.', translation: 'bondé le samedi.' })
    expect(second.photo).toEqual({ path: '/media/places/library.jpg', attribution: '© Marie D.', source_url: 'https://example.org/photo' })
    // A straight-line distance keeps its kind: the card must label it as an estimate.
    expect(third.distance).toEqual({ meters: 300, kind: 'straight_line', source: 'computed' })
  })

  it('parses a minimal single place and omits missing optionals', () => {
    const parsed = parsePlacesBlock(block([basePlace({ id: 'only', address: undefined })]))
    expect(parsed).not.toBeNull()
    const place = parsed!.places[0]
    expect(place.name).toBe('Café Central')
    expect(place.address).toBeUndefined()
    expect(place.distance).toBeUndefined()
    expect(place.opening).toBeUndefined()
    expect(place.features).toBeUndefined()
    expect(place.rating).toBeUndefined()
    expect(place.reviews).toBeUndefined()
    expect(place.photo).toBeUndefined()
  })

  it('keeps Japanese text intact', () => {
    const parsed = parsePlacesBlock(block([basePlace({
      id: 'jp-1',
      name: '珈琲館 藍',
      address: '東京都新宿区西新宿2-8-1',
      category: '喫茶店',
      reviews: [{ text: '静かで電源も使えます。', source: 'Google マップ', translation: 'Quiet, and power outlets work.' }],
    })]))
    expect(parsed).not.toBeNull()
    const place = parsed!.places[0]
    expect(place.name).toBe('珈琲館 藍')
    expect(place.address).toBe('東京都新宿区西新宿2-8-1')
    expect(place.reviews![0].text).toBe('静かで電源も使えます。')
    expect(place.reviews![0].translation).toBe('Quiet, and power outlets work.')
  })

  it('rejects malformed JSON and non-object documents', () => {
    expect(parsePlacesBlock('{not json')).toBeNull()
    expect(parsePlacesBlock('[]')).toBeNull()
    expect(parsePlacesBlock('"hello"')).toBeNull()
    expect(parsePlacesBlock('null')).toBeNull()
  })

  it('rejects bad coordinates', () => {
    expect(parsePlacesBlock(block([basePlace({ latitude: 91 })]))).toBeNull()
    expect(parsePlacesBlock(block([basePlace({ latitude: -90.5 })]))).toBeNull()
    expect(parsePlacesBlock(block([basePlace({ longitude: 181 })]))).toBeNull()
    expect(parsePlacesBlock(block([basePlace({ longitude: '2.35' })]))).toBeNull()
    expect(parsePlacesBlock(block([basePlace({ latitude: Number.NaN })]))).toBeNull()
    expect(parsePlacesBlock(block([basePlace({ latitude: null })]))).toBeNull()
  })

  it('rejects excess places and excess reviews', () => {
    expect(parsePlacesBlock(block([basePlace({ id: 'a' }), basePlace({ id: 'b' }), basePlace({ id: 'c' }), basePlace({ id: 'd' })]))).toBeNull()
    expect(parsePlacesBlock(block([]))).toBeNull()
    const reviews = Array.from({ length: 4 }, (_, index) => ({ text: `Review ${index}`, source: 'Google Maps' }))
    expect(parsePlacesBlock(block([basePlace({ reviews })]))).toBeNull()
  })

  it('rejects dangerous URLs and schemes', () => {
    expect(parsePlacesBlock(block([basePlace({ directions_url: 'javascript:alert(1)' })]))).toBeNull()
    expect(parsePlacesBlock(block([basePlace({ directions_url: 'file:///etc/passwd' })]))).toBeNull()
    expect(parsePlacesBlock(block([basePlace({ directions_url: 'https://evil.example/maps' })]))).toBeNull()
    expect(parsePlacesBlock(block([basePlace({ directions_url: 'http://www.google.com/maps/dir/?api=1&travelmode=walking' })]))).toBeNull()
    // A Google Maps URL that is not a walking route is not a directions URL either.
    expect(parsePlacesBlock(block([basePlace({ directions_url: 'https://www.google.com/maps/place/Caf%C3%A9/@48.85' })]))).toBeNull()
    expect(parsePlacesBlock(block([basePlace({ source: { name: 'OSM', url: 'http://openstreetmap.org/', fetched_at: '2026-11-21T10:00:00Z' } })]))).toBeNull()
    expect(parsePlacesBlock(block([basePlace({ reviews: [{ text: 'Nice', source: 'Maps', url: 'ftp://example.org/x' }] })]))).toBeNull()
    expect(parsePlacesBlock(block([basePlace({ photo: { path: '/media/x.jpg', attribution: '© A', source_url: 'javascript:x' } })]))).toBeNull()
  })

  it('requires the directions destination to match the place coordinates', () => {
    expect(parsePlacesBlock(block([basePlace({
      directions_url: 'https://www.google.com/maps/dir/?api=1&destination=34.0%2C135.0&travelmode=walking',
    })]))).toBeNull()
    expect(parsePlacesBlock(block([basePlace({ directions_url: 'https://maps.app.goo.gl/AbCdEfGh' })]))).toBeNull()
    expect(parsePlacesBlock(block([basePlace()]))).not.toBeNull()
  })

  it('accepts the walking directions variants of the contract', () => {
    expect(validDirectionsUrl('https://www.google.com/maps/dir/?api=1&destination=X&travelmode=walking')).toBeTruthy()
    expect(validDirectionsUrl('https://www.google.com/maps/dir/?api=1&dir_action=walk&destination=X')).toBeTruthy()
    expect(validDirectionsUrl('https://maps.app.goo.gl/AbCdEfGh')).toBeTruthy()
    expect(validDirectionsUrl('https://maps.google.com/maps/dir/data=!4m2!4m1!3e2')).toBeTruthy()
    expect(validDirectionsUrl('https://www.google.com/maps/dir/?api=1&destination=X&travelmode=driving')).toBeNull()
    expect(validDirectionsUrl('not a url')).toBeNull()
  })

  it('rejects remote photos and keeps only local MEDIA paths', () => {
    expect(parsePlacesBlock(block([basePlace({ photo: { path: 'https://evil.example/photo.jpg', attribution: '© A' } })]))).toBeNull()
    expect(parsePlacesBlock(block([basePlace({ photo: { path: 'photo.jpg', attribution: '© A' } })]))).toBeNull()
    expect(parsePlacesBlock(block([basePlace({ photo: { path: '/media/photo.txt', attribution: '© A' } })]))).toBeNull()
    expect(parsePlacesBlock(block([basePlace({ photo: { path: '~/media/photo.webp', attribution: '© A' } })]))).not.toBeNull()
    expect(validPhotoPath('https://evil.example/photo.jpg')).toBeNull()
    expect(validPhotoPath('/media/photo.jpg')).toBe('/media/photo.jpg')
  })

  it('rejects a wrong version and missing top-level fields', () => {
    expect(parsePlacesBlock(block([basePlace()], { version: 2 }))).toBeNull()
    expect(parsePlacesBlock(block([basePlace()], { version: '1' }))).toBeNull()
    expect(parsePlacesBlock(block([basePlace()], { generated_at: 'not a date' }))).toBeNull()
    expect(parsePlacesBlock(block([basePlace()], { places: 'none' }))).toBeNull()
    expect(parsePlacesBlock(block([basePlace()], { attributions: ['ok', 42] }))).toBeNull()
  })
})

describe('findPlacesFences', () => {
  it('finds fenced blocks with their offsets', () => {
    const document = [
      'Here are the quiet cafés I found:',
      '',
      `\`\`\`${PLACES_FENCE}`,
      block([basePlace()]),
      '```',
      '',
      'The first one is the closest.',
    ].join('\n')
    const matches = findPlacesFences(document)
    expect(matches).toHaveLength(1)
    expect(document.slice(matches[0].start, matches[0].end)).toContain(`\`\`\`${PLACES_FENCE}`)
    expect(JSON.parse(matches[0].source).places[0].name).toBe('Café Central')
    // The prose around the fence is untouched.
    expect(document.slice(0, matches[0].start)).toContain('quiet cafés')
    expect(document.slice(matches[0].end)).toContain('closest')
  })

  it('ignores a mention in prose and an indented (code) fence', () => {
    expect(findPlacesFences('use the hermes-places fence here')).toHaveLength(0)
    const indented = `paragraph\n\n    \`\`\`${PLACES_FENCE}\n    {}\n    \`\`\``
    expect(findPlacesFences(indented)).toHaveLength(0)
  })
})
