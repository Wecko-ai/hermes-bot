import type { ReactNode } from 'react'

export type ViewEmptyVariant = 'hero' | 'panel' | 'inline'

interface ViewEmptyProps {
  variant?: ViewEmptyVariant
  className?: string
  icon?: ReactNode
  title?: string
  description?: string
  action?: ReactNode
  role?: string
}

/** Calm placeholder for lists, panels, and the main chat when there is nothing to show yet. */
export function ViewEmpty({
  variant = 'inline',
  className = '',
  icon,
  title,
  description,
  action,
  role,
}: ViewEmptyProps) {
  const root =
    variant === 'hero' ? 'view-empty view-empty-hero chat-empty'
    : variant === 'panel' ? 'view-empty view-empty-panel'
    : 'view-empty view-empty-inline details-empty'
  const classes = [root, className].filter(Boolean).join(' ')
  return (
    <div className={classes} role={role ?? (variant === 'panel' ? 'status' : undefined)}>
      {icon && <span className="view-empty-icon" aria-hidden="true">{icon}</span>}
      {title && <p className="view-empty-title">{title}</p>}
      {description && <p className="view-empty-text">{description}</p>}
      {action && <div className="view-empty-action">{action}</div>}
    </div>
  )
}