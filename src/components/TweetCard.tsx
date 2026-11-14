import { ExternalLink } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { tweetDisplayName, type TweetPost } from '../lib/tweets'

function XMark({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817-5.964 6.817H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" />
    </svg>
  )
}

/** Links already present in the exact post text. No remote markup, avatar or widget is loaded. */
function TweetText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s]+)/g)
  return (
    <p className="tweet-card-text">
      {parts.map((part, index) => /^https?:\/\//.test(part)
        ? <a key={index} href={part} target="_blank" rel="noreferrer noopener">{part}</a>
        : part)}
    </p>
  )
}

export function TweetCard({ tweet }: { tweet: TweetPost }) {
  const { t } = useTranslation()
  const handle = `@${tweet.handle}`
  return (
    <article className="tweet-card" aria-label={t('tweets.cardLabel', { handle })}>
      <header className="tweet-card-header">
        <span className="tweet-card-avatar" aria-hidden="true">{tweet.handle.charAt(0).toUpperCase()}</span>
        <span className="tweet-card-author">
          <strong>{tweetDisplayName(tweet.handle)}</strong>
          <span>{handle}</span>
        </span>
        <span className="tweet-card-network"><XMark /></span>
      </header>
      <TweetText text={tweet.text} />
      <footer className="tweet-card-footer">
        <a href={tweet.url} target="_blank" rel="noreferrer noopener">
          {t('tweets.open')}<ExternalLink size={13} aria-hidden="true" />
        </a>
      </footer>
    </article>
  )
}
