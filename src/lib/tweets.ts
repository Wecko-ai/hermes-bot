export interface TweetPost {
  url: string
  handle: string
  id: string
  text: string
}

export type TweetSegment =
  | { kind: 'markdown'; content: string }
  | { kind: 'tweet'; tweet: TweetPost }

// The X bots already report a published post as a status link followed by its exact text.
// Only that complete pair becomes a card: a bare X link stays an ordinary link.
const TWEET_BLOCK = /^[ \t]*(?:\*\*)?(?:Lien|Link)[ \t]*:[ \t]*(?:\*\*)?[ \t]*https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/([A-Za-z0-9_]{1,15})\/status\/(\d+)\/?[ \t]*\r?\n(?:[ \t]*\r?\n)*[ \t]*(?:\*\*)?(?:Texte|Text)[ \t]*:[ \t]*(?:\*\*)?[ \t]*\r?\n[ \t]*```[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```[ \t]*(?=\r?\n|$)/gim

/** Do not turn an example inside a fenced code block into a live card. */
function insideFence(source: string, offset: number): boolean {
  let fence = ''
  for (const line of source.slice(0, offset).split(/\r?\n/)) {
    const match = line.match(/^\s*(`{3,}|~{3,})/)
    if (!match) continue
    const marker = match[1][0]
    if (!fence) fence = marker
    else if (fence === marker) fence = ''
  }
  return Boolean(fence)
}

export function splitTweets(source: string): TweetSegment[] {
  const segments: TweetSegment[] = []
  const pattern = new RegExp(TWEET_BLOCK.source, TWEET_BLOCK.flags)
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source))) {
    if (insideFence(source, match.index) || !match[3].trim()) continue
    const before = source.slice(cursor, match.index).trim()
    if (before) segments.push({ kind: 'markdown', content: before })
    const [handle, id, text] = [match[1], match[2], match[3]]
    segments.push({ kind: 'tweet', tweet: { handle, id, text, url: `https://x.com/${handle}/status/${id}` } })
    cursor = pattern.lastIndex
  }
  if (!segments.length) return [{ kind: 'markdown', content: source }]
  const after = source.slice(cursor).trim()
  if (after) segments.push({ kind: 'markdown', content: after })
  return segments
}

/** A readable local fallback for the account name; X remains the source of truth on click. */
export function tweetDisplayName(handle: string): string {
  return handle.split(/[_-]+/).filter(Boolean).map((part) => {
    if (part.toLowerCase() === 'ai') return 'AI'
    return part.charAt(0).toUpperCase() + part.slice(1)
  }).join(' ') || handle
}
