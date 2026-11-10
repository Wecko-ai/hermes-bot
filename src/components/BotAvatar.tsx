import { useTranslation } from 'react-i18next'
import type { Bot, BotStatus } from '../types'
import { getAppConfig } from '../lib/app-config'
import { i18n } from '../i18n'

const colors = ['#7A63C9', '#E8833A', '#3FA66B', '#D9483B', '#3B82C4', '#7B8794', '#C9559A', '#2BA6A0', '#E0A526', '#9A6B4F', '#2F4858']
const shapes = ['blob', 'pebble', 'squircle', 'tablet', 'wedge', 'hex', 'cloud', 'teardrop']
const namedColors: Record<string, string> = {
  black: 'var(--avatar-contrast)', brown: '#9A6B4F', red: '#D9483B', orange: '#E8833A',
  yellow: '#E0A526', green: '#3FA66B', cyan: '#2BA6A0', blue: '#3B82C4',
  violet: '#7A63C9', magenta: '#C9559A', gray: '#7B8794',
}

function hash(value: string) {
  let result = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return Math.abs(result)
}

export function avatarColor(bot: Bot) {
  if (bot.avatar?.color) return namedColors[bot.avatar.color] || bot.avatar.color
  if (getAppConfig().ui.contrastAvatars.includes(bot.slug)) return 'var(--avatar-contrast)'
  const seed = hash(bot.slug || bot.name)
  return colors[(seed >>> 4) % colors.length]
}

function Shape({ shape }: { shape: string }) {
  switch (shape) {
    case 'squircle':
    case 'boxy':
      return <rect x="4" y="4" width="32" height="32" rx="12" />
    case 'tablet':
    case 'nub':
      return <path d="M13 4h14a6 6 0 0 1 6 6v3a7 7 0 0 1 3 6v3a7 7 0 0 1-3 6v3a6 6 0 0 1-6 6H13a6 6 0 0 1-6-6v-3a7 7 0 0 1-3-6v-3a7 7 0 0 1 3-6v-3a6 6 0 0 1 6-6Z" />
    case 'cloud':
      return <path d="M11 34a8 8 0 0 1-2-15 10 10 0 0 1 19-5 8 8 0 0 1 4 15 7 7 0 0 1-6 5Z" />
    case 'wedge':
    case 'triangle':
      return <path d="M17 5a4 4 0 0 1 7 0l12 25a4 4 0 0 1-4 6H8a4 4 0 0 1-4-6Z" />
    case 'hex':
      return <path d="m14 4 12 0 10 16-10 16H14L4 20Z" />
    case 'teardrop':
      return <path d="M20 2c5 8 15 17 15 24a15 15 0 0 1-30 0C5 19 15 10 20 2Z" />
    case 'pebble':
      return <path d="M11 5c8-4 21 0 26 8 5 9 1 20-8 23-10 4-21-1-25-10S3 9 11 5Z" />
    case 'bean':
      return <path d="M29 4c9 4 10 16 4 23S19 40 10 35-2 23 3 14 20 0 29 4Z" />
    case 'egg':
      return <path d="M20 2c9 0 16 13 16 23a16 16 0 0 1-32 0C4 15 11 2 20 2Z" />
    case 'sun':
      return <path d="m20 2 4 5 6-1 2 6 6 3-2 6 2 6-6 3-2 6-6-1-4 5-4-5-6 1-2-6-6-3 2-6-2-6 6-3 2-6 6 1Z" />
    case 'round':
      return <circle cx="20" cy="20" r="17" />
    case 'blobatar':
    case 'organic':
    case 'blob':
    default:
      return <path d="M34 7c5 6 4 17 0 24-4 8-13 9-21 5S0 23 3 14 13 0 22 1c5 0 8 2 12 6Z" />
  }
}

export function statusLabel(status: BotStatus) {
  return i18n.t(`status.${status}`)
}

export function BotAvatar({ bot, size = 36, showStatus = false }: { bot: Bot; size?: number; showStatus?: boolean }) {
  useTranslation() // re-render when the language changes: the label below comes from the global instance
  const seed = hash(bot.slug || bot.name)
  const shape = bot.avatar?.shape || shapes[seed % shapes.length]
  const color = avatarColor(bot)
  const eyeColor = color === '#000000' || color === 'var(--avatar-contrast)' ? 'var(--avatar-on-contrast)' : '#17181b'
  const busy = bot.status === 'thinking' || bot.status === 'working'

  return (
    <span
      className={`bot-avatar is-${bot.status} ${busy ? 'is-busy' : ''}`}
      style={{ width: size, height: size, '--avatar-color': color } as React.CSSProperties}
      role="img"
      aria-label={`${bot.name}, ${statusLabel(bot.status)}`}
    >
      {bot.avatar?.image ? (
        <img className="bot-avatar-image" src={bot.avatar.image} alt="" />
      ) : (
        <svg viewBox="0 0 40 40" width={size} height={size} aria-hidden="true">
          <g fill={color}><Shape shape={shape} /></g>
          <g className="bot-avatar-eyes" fill={eyeColor}>
            <ellipse cx="15" cy="19" rx="1.7" ry="2.7" />
            <ellipse cx="25" cy="19" rx="1.7" ry="2.7" />
          </g>
          {busy && (
            <g className="bot-avatar-thinking" fill={eyeColor}>
              <circle cx="15" cy="19" r="1.8" /><circle cx="20" cy="19" r="1.8" /><circle cx="25" cy="19" r="1.8" />
            </g>
          )}
        </svg>
      )}
      {showStatus && bot.status !== 'idle' && <span className={`bot-avatar-status status-${bot.status}`} />}
    </span>
  )
}
