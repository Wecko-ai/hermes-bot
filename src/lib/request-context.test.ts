import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../types'
import { plainText, requestContext, shorten } from './request-context'

const message = (role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: `${role}-${content.length}-${Math.random()}`, role, content, createdAt: null, ...extra })

describe('rappel du contexte d’une demande', () => {
  it('retire le Markdown grossièrement', () => {
    expect(plainText('## Étape 2\n\n**Compte** créé sur [le site](https://exemple.org) : `code` *attendu*.\n- un\n- deux\n\n```bash\nls\n```\nMEDIA:/tmp/a.png'))
      .toBe('Étape 2 Compte créé sur le site : code attendu. un deux ls')
    expect(plainText('| a | b |\n|---|---|\n| 1 | 2 |')).toBe('a b 1 2')
    expect(plainText('mon_identifiant et snake_case restent')).toBe('mon_identifiant et snake_case restent')
  })

  it('coupe à 280 caractères sur un mot, avec une ellipse', () => {
    const long = 'mot '.repeat(120).trim()
    const cut = shorten(long)
    expect(cut.length).toBeLessThanOrEqual(280)
    expect(cut.endsWith('…')).toBe(true)
    expect(cut).not.toMatch(/ …$/)
    expect(shorten('court')).toBe('court')
  })

  it('prend la dernière réponse terminée du bot, jamais un message technique, muet ou en cours', () => {
    const messages = [
      message('assistant', 'Je crée le compte sur **exemple.org**.'),
      message('user', 'Vas-y'),
      message('assistant', 'Appel d’outil', { technical: true }),
      message('assistant', 'NOREPLY'),
      message('assistant', 'En train d’écr', { streaming: true }),
    ]
    expect(requestContext(messages)).toBe('Je crée le compte sur exemple.org.')
    expect(requestContext([message('user', 'Bonjour')])).toBeUndefined()
    expect(requestContext(undefined)).toBeUndefined()
  })
})
