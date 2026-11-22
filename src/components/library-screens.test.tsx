import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Bot } from '../types'
import { ConnectorsTab } from './ConnectorsTab'
import { SkillsScreen } from './SkillsScreen'

const bot = (slug: string, name: string): Bot => ({
  slug, name, role: '', section: '', sectionId: '', model: '', status: 'idle', preview: '', timestamp: null, unread: 0, hidden: false,
})

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

describe('connectors and skills', () => {
  const bots = [bot('nova', 'Nova'), bot('orion', 'Orion')]

  it('lists the catalog with a status for each bot and no credential', () => {
    const html = text(renderToStaticMarkup(<ConnectorsTab bots={bots} focusSlug="orion" demo />))
    expect(html).toContain('harbor')
    expect(html).toContain('1 connecté')
    expect(html).toContain('1 à connecter')
    expect(html).not.toMatch(/sekret|password|access_token/i)
  })

  it('lists shared skills and the skills of the chosen bot', () => {
    const html = text(renderToStaticMarkup(<SkillsScreen bots={bots} focusSlug="nova" demo onClose={() => undefined} />))
    expect(html).toContain('Compétences')
    expect(html).toContain('Partagées')
    expect(html).toContain('mail-approval')
    expect(html).toContain('Sur Nova')
    expect(html).toContain('weekly-notes')
    expect(html).toContain('Installer depuis le hub')
  })
})