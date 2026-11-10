import { useEffect, useState, type CSSProperties } from 'react'
import type { Bot } from '../types'
import { BotAvatar, avatarColor, statusLabel } from './BotAvatar'
import { useAppConfig } from '../lib/app-config'
import { useSettings } from '../lib/settings'

export type AvatarPhase = 'working' | 'done' | 'idle'

export const avatarPhase = (bot: Bot): AvatarPhase =>
  bot.status === 'working' || bot.status === 'thinking' ? 'working' : bot.status === 'done' ? 'done' : 'idle'

const reducedMotionQuery = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null

/** « Réduire les animations » de macOS ou des réglages : avatar fixe, le statut reste écrit. */
function useReducedMotion() {
  const { reduceMotion } = useSettings()
  const [reduced, setReduced] = useState(() => reducedMotionQuery?.matches ?? false)
  useEffect(() => {
    if (!reducedMotionQuery) return
    const update = () => setReduced(reducedMotionQuery.matches)
    reducedMotionQuery.addEventListener('change', update)
    return () => reducedMotionQuery.removeEventListener('change', update)
  }, [])
  return reduced || reduceMotion
}

interface LiveAvatarProps {
  bot: Bot
  size?: number
  showStatus?: boolean
}

/**
 * Avatar vivant : au repos, l’avatar SVG net ; au travail, l’animation du bot si elle existe (ou l’avatar
 * qui s’agite) avec un halo à sa couleur ; à la fin du tour, sa célébration. On voit d’un coup d’œil qui travaille.
 */
export function LiveAvatar({ bot, size = 36, showStatus = false }: LiveAvatarProps) {
  const phase = avatarPhase(bot)
  const [failedSource, setFailedSource] = useState('')
  const reducedMotion = useReducedMotion()
  const { animatedBots } = useAppConfig()
  const source = `/animations/${bot.slug}-${phase}.webp`
  const animated = phase !== 'idle' && !reducedMotion && animatedBots.includes(bot.slug) && failedSource !== source
  const color = avatarColor(bot)
  // Un halo noir ressemblerait à une ombre ratée : les bots noir/blanc prennent la couleur d’accent.
  const glow = color === 'var(--avatar-contrast)' || color === '#000000' ? 'var(--accent)' : color
  const style = { width: size, height: size, '--avatar-color': color, '--avatar-glow': glow } as CSSProperties
  return (
    <span className={`live-avatar is-${phase} ${animated ? 'is-animated' : ''}`} style={style}>
      {phase === 'working' && <span className="live-avatar-halo" aria-hidden="true" />}
      {animated ? (
        <img
          key={source}
          className={`live-avatar-motion ${color === 'var(--avatar-contrast)' ? 'is-contrast' : ''}`}
          src={source}
          width={size}
          height={size}
          alt={`${bot.name}, ${statusLabel(bot.status)}`}
          draggable={false}
          onError={() => setFailedSource(source)}
        />
      ) : (
        <BotAvatar bot={bot} size={size} showStatus={showStatus} />
      )}
    </span>
  )
}
