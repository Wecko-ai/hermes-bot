import { describe, expect, it } from 'vitest'
import { guessLanguage, matchChoice, splitSentences, toSpokenText, voiceCommand } from './spoken-text'

const fr = (md: string, maxSentences?: number) => toSpokenText(md, { language: 'fr', maxSentences })
const en = (md: string, maxSentences?: number) => toSpokenText(md, { language: 'en', maxSentences })

describe('splitSentences', () => {
  it('splits on terminators followed by a capital, a quote, a digit or the end', () => {
    expect(splitSentences('Bonjour tout le monde. Je suis prêt ! Et toi, es-tu prêt ? « Oui » vraiment. 3 jours plus tard.')).toEqual([
      'Bonjour tout le monde.',
      'Je suis prêt !',
      'Et toi, es-tu prêt ?',
      '« Oui » vraiment.',
      '3 jours plus tard.',
    ])
  })
  it('does not split before a lowercase word', () => {
    expect(splitSentences('Il a fini. puis il est parti sans rien dire.')).toHaveLength(1)
  })
  it('keeps ?! and ellipsis sequences together', () => {
    expect(splitSentences('Vraiment vrai ?! Je ne le crois pas… Tout à fait.')).toEqual(['Vraiment vrai ?!', 'Je ne le crois pas…', 'Tout à fait.'])
  })
  it('splits on newlines', () => {
    expect(splitSentences('première ligne assez longue\nseconde ligne assez longue')).toEqual(['première ligne assez longue', 'seconde ligne assez longue'])
  })
  it('does not split inside numbers or versions', () => {
    expect(splitSentences('La version 1.2.0 fait 3.5 Go de plus que prévu.')).toHaveLength(1)
  })
  it('does not split after abbreviations and initials', () => {
    expect(splitSentences('Demande à Mme. Durand de venir demain.')).toHaveLength(1)
    expect(splitSentences('Ask Dr. Smith about the results today.')).toHaveLength(1)
    expect(splitSentences('Many tools, e.g. Vitest and Vite, work here.')).toHaveLength(1)
    expect(splitSentences('Voir cf. la page suivante pour le détail.')).toHaveLength(1)
    expect(splitSentences('Il y a plusieurs options, p. ex. Vitest ou Jest.')).toHaveLength(1)
    expect(splitSentences('Écrit par J. R. Tolkien il y a longtemps.')).toHaveLength(1)
    expect(splitSentences('It is better than the old one vs. the new one.')).toHaveLength(1)
  })
  it('merges fragments shorter than 12 characters into the next sentence', () => {
    expect(splitSentences('Oui. Bien sûr, voyons cela ensemble.')).toEqual(['Oui. Bien sûr, voyons cela ensemble.'])
  })
  it('merges a short last fragment into the previous sentence', () => {
    expect(splitSentences('Tout est en place pour ce soir. Merci.')).toEqual(['Tout est en place pour ce soir. Merci.'])
  })
  it('cuts sentences longer than 280 characters at a comma', () => {
    const clause = 'une proposition assez longue pour remplir la phrase'
    const long = Array.from({ length: 8 }, () => clause).join(', ') + '.'
    const parts = splitSentences(long)
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(280)
    expect(parts.join(' ').replace(/\s+/g, ' ')).toBe(long)
    expect(parts[0].endsWith(',')).toBe(true)
  })
  it('cuts at a space when there is no punctuation to cut at', () => {
    const parts = splitSentences(Array.from({ length: 80 }, () => 'mot').join(' '))
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(280)
  })
  it('returns nothing for empty text', () => {
    expect(splitSentences('  \n ')).toEqual([])
  })
})

describe('toSpokenText', () => {
  it('returns nothing for silent replies', () => {
    expect(fr('NO_REPLY')).toEqual({ text: '', sentences: [], truncated: false })
    expect(en('[SILENT]').text).toBe('')
  })
  it('drops a trailing silent marker', () => {
    expect(fr('C\'est fait pour aujourd\'hui.\n\nNO_REPLY').text).toBe("C'est fait pour aujourd'hui.")
  })
  it('replaces fenced code with one phrase per language', () => {
    const md = 'Voici la commande à lancer :\n\n```bash\nnpm run build\n```\n\nEnsuite tout est prêt.'
    expect(fr(md).sentences).toContain("(code à l'écran)")
    expect(fr(md).text).not.toContain('npm')
    expect(en(md).sentences).toContain('(code on screen)')
  })
  it('handles an unclosed fence and tilde fences', () => {
    expect(en('Look at this one:\n~~~\ncode\nmore').text).toContain('(code on screen)')
  })
  it('keeps short inline code and drops long inline code', () => {
    expect(en('Run `npm test` before you push.').text).toBe('Run npm test before you push.')
    const long = 'x'.repeat(41)
    expect(en(`Use \`${long}\` before you push it.`).text).not.toContain('xxx')
  })
  it('replaces tables with one phrase', () => {
    const md = 'Les résultats :\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\nC\'est tout pour le moment.'
    const out = fr(md)
    expect(out.sentences.filter((s) => s === "(tableau à l'écran)")).toHaveLength(1)
    expect(en(md).text).toContain('(table on screen)')
  })
  it('keeps link text and drops images, URLs, mailto and MEDIA', () => {
    const md = 'Voir [la documentation](https://example.com/doc) pour plus. ![logo](a.png) Aussi https://example.com/x et mailto:a@b.co ici.\n\nMEDIA:/tmp/photo.png\n\nMEDIA:/tmp/video.mp4 Fin du message.'
    const out = fr(md).text
    expect(out).toContain('la documentation')
    expect(out).not.toMatch(/https?:|mailto|MEDIA|logo|\.png/)
  })
  it('drops HTML tags', () => {
    expect(en('This is <b>bold</b> and <br/> fine.').text).toBe('This is bold and fine.')
  })
  it('turns headings and list items into their own sentences', () => {
    const out = fr('# Plan du jour\n\n- ranger le bureau\n- appeler Marc\n1. envoyer le devis\n\n> Une citation qui compte.')
    expect(out.sentences).toHaveLength(5)
    expect(out.text).toContain('Plan du jour. ranger le bureau. appeler Marc. envoyer le devis.')
    expect(out.text).not.toMatch(/[#>]|^- /)
  })
  it('does not double the period of a list item that already has punctuation', () => {
    expect(en('- Is it ready?\n- Yes it is!').text).toBe('Is it ready? Yes it is!')
  })
  it('strips bold, italic and strike markers', () => {
    expect(en('This is **very** *really* ~~not~~ _good_ news.').text).toBe('This is very really not good news.')
    expect(en('The my_var_name stays intact here.').text).toContain('my_var_name')
  })
  it('removes emoji and collapses whitespace', () => {
    expect(fr('Super 🎉   travail ❤️ aujourd\'hui !').text).toBe("Super travail aujourd'hui !")
  })
  it('joins hard-wrapped paragraph lines', () => {
    expect(en('This sentence is wrapped\nacross two lines properly.').sentences).toEqual(['This sentence is wrapped across two lines properly.'])
  })
  it('truncates after maxSentences and says the rest is on screen', () => {
    const md = Array.from({ length: 10 }, (_, i) => `Voici la phrase numéro ${i + 1} du texte.`).join(' ')
    const out = fr(md, 3)
    expect(out.truncated).toBe(true)
    expect(out.sentences).toHaveLength(4)
    expect(out.sentences[3]).toBe('Le reste est à l\'écran.')
    expect(out.text.endsWith("Le reste est à l'écran.")).toBe(true)
    expect(en(md, 2).sentences[2]).toBe('The rest is on screen.')
  })
  it('defaults to 6 sentences and does not truncate at exactly the limit', () => {
    const six = Array.from({ length: 6 }, (_, i) => `This is sentence number ${i + 1} here.`).join(' ')
    expect(en(six).truncated).toBe(false)
    expect(en(`${six} This is the seventh one here.`).truncated).toBe(true)
  })
})

describe('guessLanguage', () => {
  it('recognises French and English', () => {
    expect(guessLanguage('Bonjour, je voudrais savoir si le projet est prêt pour demain.', 'en')).toBe('fr')
    expect(guessLanguage('Hello, I would like to know if the project is ready for tomorrow.', 'fr')).toBe('en')
  })
  it('uses accents as a small bonus', () => {
    expect(guessLanguage('café déjà été', 'en')).toBe('fr')
  })
  it('falls back on very short text and on ties', () => {
    expect(guessLanguage('ok', 'fr')).toBe('fr')
    expect(guessLanguage('ok', 'en')).toBe('en')
    expect(guessLanguage('xyz qwe rty uio', 'en')).toBe('en')
  })
})

describe('voiceCommand', () => {
  it('detects end commands in both languages, ignoring case, accents and punctuation', () => {
    for (const said of ['Stop', 'stop.', 'Arrête !', 'arrete', 'Fin', 'Terminé', 'termine', 'Au revoir', 'goodbye', 'Bye!', 'End']) expect(voiceCommand(said)).toBe('end')
  })
  it('detects cancel commands', () => {
    for (const said of ['Annule', 'annuler', 'Cancel', 'Laisse tomber', 'never mind', 'Nevermind.', 'Oublie']) expect(voiceCommand(said)).toBe('cancel')
  })
  it('only matches a bare command', () => {
    expect(voiceCommand('stop the video')).toBeNull()
    expect(voiceCommand('arrête de parler de ça')).toBeNull()
    expect(voiceCommand('')).toBeNull()
    expect(voiceCommand('bonjour')).toBeNull()
  })
})

describe('matchChoice', () => {
  const choices = ['Envoyer le mail', 'Modifier le brouillon', 'Annuler']
  it('reads digits with optional prefixes', () => {
    expect(matchChoice('2', choices)).toBe(1)
    expect(matchChoice('le 2', choices)).toBe(1)
    expect(matchChoice('option 3', choices)).toBe(2)
    expect(matchChoice('numéro 1', choices)).toBe(0)
    expect(matchChoice('number 2', choices)).toBe(1)
    expect(matchChoice("l'option 2.", choices)).toBe(1)
  })
  it('reads number and ordinal words in French and English', () => {
    expect(matchChoice('le premier', choices)).toBe(0)
    expect(matchChoice('la deuxième', choices)).toBe(1)
    expect(matchChoice('troisième', choices)).toBe(2)
    expect(matchChoice('un', choices)).toBe(0)
    expect(matchChoice('the first', choices)).toBe(0)
    expect(matchChoice('two', choices)).toBe(1)
    expect(matchChoice('the third', choices)).toBe(2)
    expect(matchChoice('second', choices)).toBe(1)
  })
  it('returns null when out of range', () => {
    expect(matchChoice('4', choices)).toBeNull()
    expect(matchChoice('0', choices)).toBeNull()
    expect(matchChoice('sixième', choices)).toBeNull()
  })
  it('matches a label that equals or is contained in what was said', () => {
    expect(matchChoice('annuler', choices)).toBe(2)
    expect(matchChoice('je veux envoyer le mail', choices)).toBe(0)
    expect(matchChoice('Modifier le brouillon.', choices)).toBe(1)
  })
  it('matches when the label contains what was said (4+ chars label)', () => {
    expect(matchChoice('brouillon', choices)).toBe(1)
    expect(matchChoice('envoyer', choices)).toBe(0)
  })
  it('ignores accents and case', () => {
    expect(matchChoice('MODIFIER LE BROUILLON', choices)).toBe(1)
    expect(matchChoice('Édit', ['Éditer', 'Lire'])).toBeNull()
    expect(matchChoice('editer', ['Éditer', 'Lire'])).toBe(0)
  })
  it('returns null for ambiguous or unrelated answers', () => {
    expect(matchChoice('le', ['le plan', 'le reste'])).toBeNull()
    expect(matchChoice('le mail', ['Envoyer le mail', 'Copier le mail'])).toBeNull()
    expect(matchChoice('peut-être', choices)).toBeNull()
    expect(matchChoice('', choices)).toBeNull()
    expect(matchChoice('1', [])).toBeNull()
  })
  it('prefers an exact label over longer labels that contain it', () => {
    expect(matchChoice('oui', ['Oui', 'Oui, mais plus tard'])).toBe(0)
  })
})
