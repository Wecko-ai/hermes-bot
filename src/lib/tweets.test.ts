import { describe, expect, it } from 'vitest'
import { findTweets, tweetDisplayName } from './tweets'

const published = [
  'Le post est publié sur @orion_ai, avec la vidéo.',
  '',
  '**Lien :** https://x.com/orion_ai/status/2121543749021147234',
  '',
  '**Texte :**',
  '```',
  'HermesBot: your agents, in one window.',
  '',
  'Open source, MIT.',
  '',
  'https://example.com/hermes',
  '```',
  '',
  '- **Audience :** Everyone.',
].join('\n')

describe('vignettes X', () => {
  it('repère le post et les bornes exactes de son bloc dans le Markdown', () => {
    const tweets = findTweets(published)
    expect(tweets).toHaveLength(1)
    expect(tweets[0]).toMatchObject({
      handle: 'orion_ai',
      id: '2121543749021147234',
      url: 'https://x.com/orion_ai/status/2121543749021147234',
      text: 'HermesBot: your agents, in one window.\n\nOpen source, MIT.\n\nhttps://example.com/hermes',
    })
    expect(published.slice(tweets[0].start, tweets[0].end)).toContain('**Texte :**')
    expect(published.slice(0, tweets[0].start)).toContain('Le post est publié')
    expect(published.slice(tweets[0].end)).toContain('Audience')
  })

  it('accepte les libellés anglais, twitter.com, les paramètres et un fence text', () => {
    const source = 'Link: https://twitter.com/Some_Bot/status/123/?s=20\n\nText:\n```text\nA post.\n```'
    expect(findTweets(source)).toHaveLength(1)
    expect(findTweets(source)[0]).toMatchObject({ handle: 'Some_Bot', id: '123', url: 'https://x.com/Some_Bot/status/123', text: 'A post.' })
  })

  it('prend plusieurs posts dans une même réponse', () => {
    const one = published.replace('2121543749021147234', '123')
    const two = published.replaceAll('2121543749021147234', '456').replace('@orion_ai', '@other_ai').replace('x.com/orion_ai', 'x.com/other_ai')
    expect(findTweets(`${one}\n\n${two}`).map((tweet) => tweet.id)).toEqual(['123', '456'])
  })

  it('laisse un lien seul ou un exemple dans du code en Markdown ordinaire', () => {
    expect(findTweets('Post : https://x.com/orion_ai/status/123')).toEqual([])
    expect(findTweets(`Exemple :\n\n~~~md\n${published}\n~~~`)).toEqual([])
    expect(findTweets(`Exemple :\n\n${published.split('\n').map((line) => `    ${line}`).join('\n')}`)).toEqual([])
    expect(findTweets(`Exemple :\n\n\`\`\`\`md\n\`\`\`\n${published}\n\`\`\`\`\``)).toEqual([])
    expect(findTweets(published.replace('avec la vidéo.\n\n**Lien', 'avec la vidéo.\n**Lien'))).toEqual([])
  })

  it('présente un nom de compte lisible sans contacter X', () => {
    expect(tweetDisplayName('orion_ai')).toBe('Orion AI')
    expect(tweetDisplayName('some-account')).toBe('Some Account')
  })
})
