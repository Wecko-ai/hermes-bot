import { describe, expect, it } from 'vitest'
import type { Bot } from '../types'
import { botMentionTag, mentionOptions, mentionTokenAt, resolveMentions, withMentionNote, withoutMentionNote } from './mentions'

const bot = (slug: string, name: string, hidden = false): Bot => ({ slug, name, role: '', section: '', sectionId: '', model: '', status: 'idle', preview: '', timestamp: null, unread: 0, hidden })
const bots = [bot('nova', 'Nova'), bot('studio-ai-video', 'Studio AI Video'), bot('secret', 'Secret', true), bot('sage', 'Sage')]

describe('mentions de bots', () => {
  it('trouve le @mot sous le curseur, jamais dans une adresse', () => {
    expect(mentionTokenAt('salut @to', 9)).toEqual({ start: 6, query: 'to' })
    expect(mentionTokenAt('@', 1)).toEqual({ start: 0, query: '' })
    expect(mentionTokenAt('a@to', 4)).toBeNull()
    expect(mentionTokenAt('@to fini', 8)).toBeNull()
  })

  it('propose les autres bots visibles, début de nom d’abord', () => {
    expect(mentionOptions('', bots, 'nova').map((item) => item.bot.slug)).toEqual(['sage', 'studio-ai-video'])
    expect(mentionOptions('vid', bots, 'nova').map((item) => item.tag)).toEqual(['studio-ai-video'])
    expect(mentionOptions('sec', bots, 'nova')).toEqual([])
  })

  it('résout le nom affiché et le profil, sans le code ni les adresses', () => {
    const resolved = (text: string) => resolveMentions(text, bots, 'nova').map((item) => item.slug)
    expect(botMentionTag(bots[1])).toBe('studio-ai-video')
    expect(resolved('demande à @Sage et @studio-ai-video')).toEqual(['studio-ai-video', 'sage'])
    expect(resolved('`@sage` sage@exemple.com @inconnu @nova')).toEqual([])
  })

  it('ajoute la note pour le bot et la retire à l’affichage', () => {
    const sent = withMentionNote('Vois avec @sage', bots, 'nova')
    expect(sent).toContain('@sage = agent profile "sage" ("Sage")')
    expect(sent).toContain('message_agent')
    expect(withoutMentionNote(sent)).toBe('Vois avec @sage')
    expect(withMentionNote('Rien à signaler', bots, 'nova')).toBe('Rien à signaler')
    expect(withoutMentionNote('Rien à signaler')).toBe('Rien à signaler')
  })
})
