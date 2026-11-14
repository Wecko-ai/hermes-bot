export interface TweetPost {
  url: string
  handle: string
  id: string
  text: string
}

export interface TweetMatch extends TweetPost {
  /** Offsets of the whole link + label + code block in the original Markdown. */
  start: number
  end: number
}

// The X bots already report a published post as a status link followed by its exact text.
// Only that complete pair becomes a card: a bare X link stays an ordinary link. Four spaces
// of indentation are never accepted: that is an indented code block in CommonMark.
const TWEET_BLOCK = /^ {0,3}(?:\*\*)?(?:Lien|Link)[ \t]*:[ \t]*(?:\*\*)?[ \t]*https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/([A-Za-z0-9_]{1,15})\/status\/(\d+)\/?(?:[?#][^ \t\r\n]+)?[ \t]*\r?\n(?:[ \t]*\r?\n)* {0,3}(?:\*\*)?(?:Texte|Text)[ \t]*:[ \t]*(?:\*\*)?[ \t]*\r?\n {0,3}```[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n {0,3}```[ \t]*(?=\r?\n|$)/gim

/** Do not turn an example inside a fenced code block into a live card. */
function insideFence(source: string, offset: number): boolean {
  let marker = ''
  let length = 0
  for (const line of source.slice(0, offset).split(/\r?\n/)) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (!match) continue
    if (!marker) {
      marker = match[1][0]
      length = match[1].length
      continue
    }
    // A closing fence has the same marker, at least the opening length, and no info string.
    if (match[1][0] === marker && match[1].length >= length && !match[2].trim()) {
      marker = ''
      length = 0
    }
  }
  return Boolean(marker)
}

/** The link label must start a Markdown paragraph, not follow prose on the preceding line. */
function startsBlock(source: string, offset: number): boolean {
  return offset === 0 || /\r?\n[ \t]*\r?\n$/.test(source.slice(0, offset))
}

export function findTweets(source: string): TweetMatch[] {
  const tweets: TweetMatch[] = []
  const pattern = new RegExp(TWEET_BLOCK.source, TWEET_BLOCK.flags)
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source))) {
    if (!startsBlock(source, match.index) || insideFence(source, match.index) || !match[3].trim()) continue
    const [handle, id, text] = [match[1], match[2], match[3]]
    tweets.push({ handle, id, text, url: `https://x.com/${handle}/status/${id}`, start: match.index, end: pattern.lastIndex })
  }
  return tweets
}

/** A readable local fallback for the account name; X remains the source of truth on click. */
export function tweetDisplayName(handle: string): string {
  return handle.split(/[_-]+/).filter(Boolean).map((part) => {
    if (part.toLowerCase() === 'ai') return 'AI'
    return part.charAt(0).toUpperCase() + part.slice(1)
  }).join(' ') || handle
}
