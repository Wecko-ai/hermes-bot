import { describe, expect, it } from 'vitest'
import { BOT_KICKOFF_TEXT, isKickoffMessage, isKickoffPreview, kickoffApiText, newBotSoul } from './bot-kickoff'

describe('premier tour d’un bot créé ici', () => {
  it('garde une phrase courte, que Hermes ne coupe pas en aperçu', () => {
    expect(BOT_KICKOFF_TEXT.length).toBeLessThanOrEqual(60)
  })

  it('reconnaît la phrase exacte, et rien d’autre', () => {
    expect(isKickoffMessage(BOT_KICKOFF_TEXT)).toBe(true)
    expect(isKickoffMessage(`  ${BOT_KICKOFF_TEXT}\n`)).toBe(true)
    expect(isKickoffMessage(`${BOT_KICKOFF_TEXT} Merci.`)).toBe(false)
    expect(isKickoffMessage('New bot')).toBe(false)
    expect(isKickoffMessage('Présente-toi.')).toBe(false)
  })

  it('reconnaît l’aperçu coupé par Hermes, pas un début trop court ni un autre texte', () => {
    expect(isKickoffPreview(BOT_KICKOFF_TEXT)).toBe(true)
    expect(isKickoffPreview(`${BOT_KICKOFF_TEXT.slice(0, 30)}...`)).toBe(true)
    expect(isKickoffPreview(`${BOT_KICKOFF_TEXT.slice(0, 30)}…`)).toBe(true)
    expect(isKickoffPreview('New...')).toBe(false)
    expect(isKickoffPreview('New bot: tell me a joke...')).toBe(false)
  })

  it('donne au modèle son nom, son profil et la langue de l’interface, pour ce tour', () => {
    const fr = kickoffApiText({ title: 'Léa  "Martin"\n', slug: 'lea-martin', language: 'fr' })
    expect(fr.startsWith(`${BOT_KICKOFF_TEXT}\n\n[HermesBot onboarding:`)).toBe(true)
    expect(fr).toContain('Your name is "Léa \\"Martin\\""')
    expect(fr).toContain('"lea-martin"')
    expect(fr).toContain('in French')
    expect(fr).toContain('record that role durably')
    expect(fr).toContain('Do nothing else until your role is known.')
    expect(kickoffApiText({ title: 'Iris', slug: 'iris', language: 'en' })).toContain('in English')
  })

  it('naît avec une identité et un rôle à définir dans son SOUL.md', () => {
    const soul = newBotSoul({ title: 'Léa Martin', slug: 'lea-martin' })
    expect(soul.split('\n')[0]).toBe('# Léa Martin')
    expect(soul).toContain('profile `lea-martin`')
    expect(soul).toContain('## Role')
    expect(newBotSoul({ title: '  ', slug: 'iris' }).split('\n')[0]).toBe('# iris')
  })
})
