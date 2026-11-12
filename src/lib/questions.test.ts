import { describe, expect, it } from 'vitest'
import { answersPrompt, hasAnswer, splitOpenQuestions } from './questions'

const reply = [
  'Voici la page.',
  '',
  'Rien n’est parti : ce tour est encore en mode Brain.',
  '',
  '## Questions ouvertes',
  '1. Avec quoi le client est-il reparti au bout des 5 jours ? J’en ai besoin pour écrire l’offre.',
  '2. L’Intensif est-il pour une seule personne,',
  '   ou son équipe peut-elle assister ?',
  '3. Le bloc dirigeants reste-t-il au tutoiement ?',
].join('\n')

describe('questions ouvertes', () => {
  it('trouve la liste sous le titre et garde le texte qui précède', () => {
    const found = splitOpenQuestions(reply)
    expect(found?.heading).toBe('Questions ouvertes')
    expect(found?.questions).toEqual([
      'Avec quoi le client est-il reparti au bout des 5 jours ? J’en ai besoin pour écrire l’offre.',
      'L’Intensif est-il pour une seule personne, ou son équipe peut-elle assister ?',
      'Le bloc dirigeants reste-t-il au tutoiement ?',
    ])
    expect(found?.before).toBe('Voici la page.\n\nRien n’est parti : ce tour est encore en mode Brain.')
    expect(found?.after).toBe('')
  })

  it('accepte un titre en gras, des puces et une ligne vide, et garde la suite', () => {
    const found = splitOpenQuestions('**Open questions:**\n\n- One?\n\n- Two?\n\nThen the rest.')
    expect(found?.questions).toEqual(['One?', 'Two?'])
    expect(found?.after).toBe('Then the rest.')
  })

  it('ignore un titre sans liste, un titre dans du code et une phrase ordinaire', () => {
    expect(splitOpenQuestions('## Questions ouvertes\nAucune pour l’instant.')).toBeNull()
    expect(splitOpenQuestions('```\nQuestions ouvertes\n1. a\n```')).toBeNull()
    expect(splitOpenQuestions('J’ai des questions ouvertes sur ce point.\n1. a')).toBeNull()
  })

  it('compose la réponse avec les seules questions remplies', () => {
    const text = answersPrompt('Mes réponses :', ['Q1 ?', 'Q2 ?', 'Q3 ?'], ['Oui', ' ', 'Non\n\nMais plus tard'])
    expect(text).toBe('Mes réponses :\n\n1. Q1 ?\n   Oui\n\n3. Q3 ?\n   Non\n\n   Mais plus tard')
    expect(hasAnswer(['', '  '])).toBe(false)
    expect(hasAnswer(['', 'x'])).toBe(true)
  })
})
