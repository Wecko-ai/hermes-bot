import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ViewEmpty } from './ViewEmpty'

describe('ViewEmpty', () => {
  it('renders inline copy for detail panels', () => {
    const html = renderToStaticMarkup(<ViewEmpty variant="inline" description="Nothing here yet." />)
    expect(html).toContain('view-empty-inline')
    expect(html).toContain('details-empty')
    expect(html).toContain('Nothing here yet.')
    expect(html).not.toContain('view-empty-title')
  })

  it('renders a panel block with icon, title, and status role', () => {
    const html = renderToStaticMarkup(
      <ViewEmpty variant="panel" title="Waiting" description="Screen will appear here." icon={<span data-testid="icon" />} />,
    )
    expect(html).toContain('view-empty-panel')
    expect(html).toContain('role="status"')
    expect(html).toContain('view-empty-icon')
    expect(html).toContain('Waiting')
    expect(html).toContain('Screen will appear here.')
  })

  it('keeps the hero variant compatible with the existing chat-empty layout', () => {
    const html = renderToStaticMarkup(
      <ViewEmpty variant="hero" title="Nova" description="Helper" className="room-empty" />,
    )
    expect(html).toContain('chat-empty')
    expect(html).toContain('view-empty-hero')
    expect(html).toContain('room-empty')
    expect(html).toContain('Nova')
  })
})