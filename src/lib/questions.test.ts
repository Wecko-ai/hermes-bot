import { describe, expect, it } from 'vitest'
import { answersPrompt, findQuestions, hasAnswer, splitLooseQuestions, splitOpenQuestions } from './questions'

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

const Q1 = 'Le repli en cascade (LLM Stats, puis ECI, puis Arena pour la ligne 1) te va, ou tu veux le repli strict sur le meilleur score LLM Stats ?'
const Q2 = 'Carbon : on garde l’article ou on le retire ?'
const Q3 = 'Tu veux voir la carte sur stage toi-même avant la prod, comme tu l’as écrit, ou mon contrôle desktop et mobile suffit ?'
const EXPECTED = [Q1, Q2, Q3]

describe('questions sans titre dédié', () => {
  it('numérotées, avec un titre libre', () => {
    const found = splitLooseQuestions(`J’ai fini.\n\nTes réponses avant de lancer\n\n1. ${Q1}\n2. ${Q2}\n3. ${Q3}`)
    expect(found?.heading).toBe('Tes réponses avant de lancer')
    expect(found?.questions).toEqual(EXPECTED)
    expect(found?.before).toBe('J’ai fini.')
    expect(found?.after).toBe('')
  })

  it('à puces, en gras, avec des lignes vides entre les items', () => {
    const found = splitLooseQuestions(`**Tes réponses avant de lancer :**\n- **${Q1}**\n\n- ${Q2}\n\n* ${Q3}`)
    expect(found?.heading).toBe('Tes réponses avant de lancer')
    expect(found?.questions).toEqual(EXPECTED)
  })

  it('en lignes simples ou en paragraphes', () => {
    const lines = splitLooseQuestions(`Tes réponses avant de lancer\n${Q1}\n${Q2}\n${Q3}`)
    expect(lines?.questions).toEqual(EXPECTED)
    expect(lines?.before).toBe('')
    const paragraphs = splitLooseQuestions(`## Avant de lancer\n\n${Q1}\n\n${Q2}`)
    expect(paragraphs?.heading).toBe('Avant de lancer')
    expect(paragraphs?.questions).toEqual([Q1, Q2])
  })

  it('garde le texte après le bloc et les continuations d’item', () => {
    const found = splitLooseQuestions('Voilà.\n\n1. Première\n   suite ?\n2. Seconde ?\n\nDis-moi et je lance.')
    expect(found?.questions).toEqual(['Première suite ?', 'Seconde ?'])
    expect(found?.after).toBe('Dis-moi et je lance.')
    expect(found?.heading).toBe('')
    expect(found?.before).toBe('Voilà.')
  })

  it('prend le dernier bloc seulement', () => {
    const found = splitLooseQuestions('A ?\nB ?\n\nTexte entre.\n\nC ?\nD ?')
    expect(found?.questions).toEqual(['C ?', 'D ?'])
    expect(found?.before).toBe('A ?\nB ?\n\nTexte entre.')
  })

  it('n’utilise pas comme titre une question, une phrase ou une longue ligne', () => {
    expect(splitLooseQuestions('Prêt ?\n1. A ?\n2. B ?')?.heading).toBe('')
    expect(splitLooseQuestions('Voici ce qui reste.\n1. A ?\n2. B ?')?.heading).toBe('')
    expect(splitLooseQuestions(`${'x'.repeat(81)}\n1. A ?\n2. B ?`)?.heading).toBe('')
    expect(splitLooseQuestions('Voici ce qui reste.\n1. A ?\n2. B ?')?.before).toBe('Voici ce qui reste.')
  })

  it('accepte l’espace avant le point d’interrogation, y compris insécable', () => {
    expect(splitLooseQuestions('1. Ça suffit\u00a0?\n2. Ou pas\u202f?')?.questions).toEqual(['Ça suffit\u00a0?', 'Ou pas\u202f?'])
  })

  it('retire les marqueurs mais garde le code et le texte des liens', () => {
    const found = splitLooseQuestions('1. **Garde** `npm run build` ?\n2. Voir [la doc](https://example.com/a?b=1) ?')
    expect(found?.questions).toEqual(['Garde `npm run build` ?', 'Voir la doc ?'])
  })

  it('ne déclenche pas pour une seule question finale', () => {
    expect(splitLooseQuestions('J’ai tout fait.\n\nOn lance ?')).toBeNull()
    expect(splitLooseQuestions('Un.\n\n1. fait\n2. fait\n\nOn lance ?')).toBeNull()
  })

  it('ne déclenche pas pour une liste d’options avec une seule question', () => {
    expect(splitLooseQuestions('Quelle option ?\n- A\n- B\n- C')).toBeNull()
    expect(splitLooseQuestions('Options :\n1. A\n2. B ?\n3. C')).toBeNull()
  })

  it('ignore les questions dans un bloc de code et les ? des URL', () => {
    expect(splitLooseQuestions('```\n1. A ?\n2. B ?\n```')).toBeNull()
    expect(splitLooseQuestions('- https://a.test/x?y=1\n- https://a.test/z?w=2')).toBeNull()
  })

  it('laisse en texte des paragraphes qui contiennent une question sans finir dessus', () => {
    expect(splitLooseQuestions('Pourquoi ce choix ? Parce que c’est plus simple.\n\nEt le coût ? Il reste le même.')).toBeNull()
    expect(splitLooseQuestions('On garde **Carbon ?**\nEt « la carte ? »')?.questions).toEqual(['On garde Carbon ?', 'Et « la carte ? »'])
  })

  it('une phrase sans point d’interrogation interrompt une suite de lignes', () => {
    const found = splitLooseQuestions('Un texte.\nPremière ?\nUne remarque.\nSeconde ?\nTroisième ?')
    expect(found?.questions).toEqual(['Seconde ?', 'Troisième ?'])
    expect(found?.before).toBe('Un texte.\nPremière ?\nUne remarque.')
  })
})

describe('findQuestions', () => {
  it('garde la règle du titre pour tous les messages et la règle large pour le dernier seulement', () => {
    expect(findQuestions(reply, false)?.heading).toBe('Questions ouvertes')
    const loose = '1. A ?\n2. B ?'
    expect(findQuestions(loose, false)).toBeNull()
    expect(findQuestions(loose, true)?.questions).toEqual(['A ?', 'B ?'])
    expect(findQuestions(reply, true)?.heading).toBe('Questions ouvertes')
  })
})
