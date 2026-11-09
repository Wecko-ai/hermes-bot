import { describe, expect, it } from 'vitest'
import { cleanPreview, messageDay, relativeTime, shortTime } from './time'

describe('time helpers', () => {
  it('nettoye les aperçus Markdown sans casser le texte', () => {
    expect(cleanPreview('**Bonjour** `code`\n> Suite')).toBe('Bonjour code Suite')
  })

  it('remplace les chemins MEDIA: par un libellé court', () => {
    expect(cleanPreview('La v3 est prête :\n\nMEDIA:/Users/test/videos/demo.mp4')).toBe('La v3 est prête : Vidéo demo.mp4')
  })

  it('affiche une heure pour un message du jour', () => {
    expect(shortTime(new Date().toISOString())).toMatch(/\d{2}:\d{2}/)
  })

  it('gère une date absente', () => {
    expect(shortTime(null)).toBe('')
    expect(relativeTime(null)).toBe('')
    expect(messageDay(null)).toBe('')
  })

  it('produit une date française lisible', () => {
    expect(messageDay('2025-11-08T02:00:00Z')).toContain('novembre')
  })
})
