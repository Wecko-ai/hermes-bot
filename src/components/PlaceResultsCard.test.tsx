import './test-dom'
import { act, createElement, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { i18n } from '../i18n'
import { PlacesBlock, PlaceResultsCard } from './PlaceResultsCard'
import { installTestDom, walkElements } from './test-dom'

type TestContainer = ReturnType<typeof installTestDom>['container']
import type { PlacesBlock as PlacesBlockData } from '../lib/places'

const WALKING = 'https://www.google.com/maps/dir/?api=1&destination=48.8566%2C2.3522&travelmode=walking'

function placeData(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    name: 'Café Central',
    address: '12 rue des Lilas, Paris',
    latitude: 48.8566,
    longitude: 2.3522,
    category: 'café',
    directions_url: WALKING,
    source: { name: 'OpenStreetMap', url: 'https://www.openstreetmap.org/', fetched_at: '2026-11-21T10:00:00Z' },
    ...overrides,
  }
}

function blockData(places: unknown[], extra: Record<string, unknown> = {}): PlacesBlockData {
  return {
    version: 1,
    generated_at: '2026-11-21T10:00:00Z',
    attributions: ['Data © OpenStreetMap contributors'],
    warnings: ['Distances are estimates.'],
    places: places as PlacesBlockData['places'],
    ...extra,
  }
}

async function render(element: ReactElement) {
  const { container } = installTestDom()
  const root = createRoot(container as unknown as Element)
  await act(async () => { root.render(element) })
  return {
    container,
    unmount: async () => {
      await act(async () => { root.unmount() })
    },
  }
}

const queryAll = (container: TestContainer, selector: string) => {
  const found: ReturnType<TestContainer['querySelectorAll']> = []
  walkElements(container, (element) => {
    if (element.matches(selector)) found.push(element)
    return false
  })
  return found
}

beforeEach(async () => { await i18n.changeLanguage('fr') })
afterEach(async () => { await i18n.changeLanguage('fr') })

describe('PlaceResultsCard', () => {
  it('renders three cards with distances, opening, features, rating and reviews', async () => {
    const data = blockData([
      placeData(),
      placeData({
        id: 'p2',
        name: 'Bibliothèque municipale',
        distance: { meters: 1200, seconds: 920, kind: 'route', source: 'OSRM' },
        opening: { status: 'closed', label: 'Fermé · ouvre à 14 h', timezone: 'Europe/Paris' },
        features: { wifi: true, power_outlets: null },
        rating: { value: 4.5, count: 128, source: 'Google Maps' },
        reviews: [{ text: 'Très calme.', author: 'Marie', rating: 5, published_at: '2026-10-02', source: 'Google Maps' }],
        photo: { path: '/media/places/library.jpg', attribution: '© Marie D.' },
      }),
      placeData({
        id: 'p3',
        name: 'Square du Vert-Galant',
        distance: { meters: 300, kind: 'straight_line', source: 'computed' },
        opening: { status: 'unknown', label: 'Horaires inconnus', timezone: 'Europe/Paris' },
        features: { wifi: null, power_outlets: null },
        reviews: [{ text: 'Joli mais bruyant.', source: 'Google Maps', translation: 'Pretty but noisy.' }],
      }),
    ])
    const { container, unmount } = await render(createElement(PlaceResultsCard, { block: data, profile: 'orion', version: 'm-1' }))
    expect(queryAll(container, '.place-card')).toHaveLength(3)
    expect(container.textContent).toContain('Café Central')
    expect(container.textContent).toContain('12 rue des Lilas, Paris')
    // Distances and duration, route vs straight line.
    expect(container.textContent).toContain('1.2 km')
    expect(container.textContent).toContain('15 min')
    expect(container.textContent).toContain('itinéraire')
    expect(container.textContent).toContain('à vol d\'oiseau')
    // Opening status badge keeps the supplied label.
    expect(container.textContent).toContain('Fermé · ouvre à 14 h')
    expect(container.textContent).toContain('Horaires inconnus')
    // Wi-Fi and power: known and unknown states.
    expect(container.textContent).toContain('Wi-Fi: oui')
    expect(container.textContent).toContain('Prises: inconnu')
    // Sourced rating.
    expect(container.textContent).toContain('4.5')
    expect(container.textContent).toContain('128 avis')
    // Reviews: author, date, translation.
    expect(container.textContent).toContain('Avis de Marie')
    expect(container.textContent).toContain('Très calme.')
    expect(container.textContent).toContain('Traduction')
    expect(container.textContent).toContain('Pretty but noisy.')
    // Warnings and attributions.
    expect(container.textContent).toContain('Distances are estimates.')
    expect(container.textContent).toContain('Data © OpenStreetMap contributors')
    // Directions and source links are safe external links.
    const directions = queryAll(container, '.place-directions')
    expect(directions).toHaveLength(3)
    expect(directions[0].getAttribute('href')).toBe(WALKING)
    expect(directions[0].getAttribute('rel')).toContain('noreferrer')
    expect(container.textContent).toContain('Source : OpenStreetMap')
    // The local photo goes through the media proxy, with its attribution; the other cards show the fallback.
    const photos = queryAll(container, '.place-photo')
    const images = queryAll(container, 'img')
    expect(photos).toHaveLength(3)
    expect(queryAll(container, '.place-photo-fallback')).toHaveLength(2)
    expect(images).toHaveLength(1)
    expect(images[0].getAttribute('src')).toContain('/api/media?')
    expect(images[0].getAttribute('src')).toContain(encodeURIComponent('/media/places/library.jpg'))
    expect(container.textContent).toContain('Photo : © Marie D.')
    await unmount()
  })

  it('shows the neutral fallback when a place has no photo', async () => {
    const { container, unmount } = await render(createElement(PlaceResultsCard, { block: blockData([placeData()]), profile: 'orion', version: 'm-2' }))
    expect(queryAll(container, '.place-photo img')).toHaveLength(0)
    expect(queryAll(container, '.place-photo-fallback')).toHaveLength(1)
    await unmount()
  })

  it('translates the card in English', async () => {
    await i18n.changeLanguage('en')
    const data = blockData([
      placeData({ distance: { meters: 300, kind: 'straight_line', source: 'computed' }, features: { wifi: null, power_outlets: true } }),
    ])
    const { container, unmount } = await render(createElement(PlaceResultsCard, { block: data, profile: 'orion', version: 'm-3' }))
    expect(container.textContent).toContain('straight line')
    expect(container.textContent).toContain('Wi-Fi: unknown')
    expect(container.textContent).toContain('Power: yes')
    expect(container.textContent).toContain('Directions')
    expect(container.textContent).toContain('Nearby places')
    await unmount()
  })
})

describe('PlacesBlock', () => {
  const source = JSON.stringify(blockData([placeData()]))

  it('renders a valid fence as cards', async () => {
    const { container, unmount } = await render(createElement(PlacesBlock, { source, profile: 'orion', version: 'm-4', streaming: false }))
    expect(queryAll(container, '.place-card')).toHaveLength(1)
    await unmount()
  })

  it('keeps an invalid or hostile fence inert as a code block', async () => {
    const hostile = JSON.stringify(blockData([placeData({ directions_url: 'javascript:alert(1)' })]))
    const { container, unmount } = await render(createElement(PlacesBlock, { source: hostile, profile: 'orion', version: 'm-5', streaming: false }))
    expect(queryAll(container, '.place-card')).toHaveLength(0)
    expect(queryAll(container, 'pre')).toHaveLength(1)
    expect(container.textContent).toContain('javascript:alert(1)')
    // No link is created from the dangerous URL.
    expect(queryAll(container, 'a')).toHaveLength(0)
    await unmount()
  })

  it('stays inert while streaming', async () => {
    const partial = source.slice(0, source.length - 10)
    const { container, unmount } = await render(createElement(PlacesBlock, { source: partial, profile: 'orion', version: 'm-6', streaming: true }))
    expect(queryAll(container, '.place-card')).toHaveLength(0)
    expect(queryAll(container, 'pre')).toHaveLength(1)
    await unmount()
  })

  it('rejects a remote photo URL and stays inert', async () => {
    const remote = JSON.stringify(blockData([placeData({ photo: { path: 'https://evil.example/x.jpg', attribution: '© X' } })]))
    const { container, unmount } = await render(createElement(PlacesBlock, { source: remote, profile: 'orion', version: 'm-7', streaming: false }))
    expect(queryAll(container, '.place-card')).toHaveLength(0)
    expect(queryAll(container, 'img')).toHaveLength(0)
    expect(queryAll(container, 'pre')).toHaveLength(1)
    await unmount()
  })
})

