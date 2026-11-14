import { describe, expect, it } from 'vitest'
import { splitTweets, tweetDisplayName } from './tweets'

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
  'https://github.com/Wecko-ai/hermes-bot',
  '```',
  '',
  '- **Audience :** Everyone.',
].join('\n')

describe('vignettes X', () => {
  it('remplace le lien et le texte du post par une carte, sans perdre le reste', () => {
    expect(splitTweets(published)).toEqual([
      { kind: 'markdown', content: 'Le post est publié sur @orion_ai, avec la vidéo.' },
      { kind: 'tweet', tweet: {
        handle: 'orion_ai',
        id: '2121543749021147234',
        url: 'https://x.com/orion_ai/status/2121543749021147234',
        text: 'HermesBot: your agents, in one window.\n\nOpen source, MIT.\n\nhttps://github.com/Wecko-ai/hermes-bot',
      } },
      { kind: 'markdown', content: '- **Audience :** Everyone.' },
    ])
  })

  it('accepte les libellés anglais, twitter.com et un fence text', () => {
    const source = 'Link: https://twitter.com/Some_Bot/status/123/\n\nText:\n```text\nA post.\n```'
    expect(splitTweets(source)).toEqual([{ kind: 'tweet', tweet: {
      handle: 'Some_Bot', id: '123', url: 'https://x.com/Some_Bot/status/123', text: 'A post.',
    } }])
  })

  it('prend plusieurs posts dans une même réponse', () => {
    const one = published.replace('2121543749021147234', '123')
    const two = published.replaceAll('2121543749021147234', '456').replace('@orion_ai', '@other_ai').replace('x.com/orion_ai', 'x.com/other_ai')
    const cards = splitTweets(`${one}\n\n${two}`).filter((part) => part.kind === 'tweet')
    expect(cards.map((part) => part.kind === 'tweet' && part.tweet.id)).toEqual(['123', '456'])
  })

  it('laisse un lien seul ou un exemple dans du code en Markdown ordinaire', () => {
    const bare = 'Post : https://x.com/orion_ai/status/123'
    expect(splitTweets(bare)).toEqual([{ kind: 'markdown', content: bare }])
    const example = `Exemple :\n\n~~~md\n${published}\n~~~`
    expect(splitTweets(example)).toEqual([{ kind: 'markdown', content: example }])
  })

  it('présente un nom de compte lisible sans contacter X', () => {
    expect(tweetDisplayName('orion_ai')).toBe('Orion AI')
    expect(tweetDisplayName('some-account')).toBe('Some Account')
  })
})
