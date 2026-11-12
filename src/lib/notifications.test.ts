import { describe, expect, it } from 'vitest'
import { notificationExcerpt, notificationForRequest, notificationForStatus, shouldNotify } from './notifications'

describe('notifications', () => {
  it('notifie la fin d’un tour et une question, pas le reste', () => {
    expect(notificationForStatus('working', 'done')).toBe('done')
    expect(notificationForStatus('thinking', 'done')).toBe('done')
    expect(notificationForStatus('working', 'waiting')).toBe('question')
    expect(notificationForStatus('idle', 'waiting')).toBe('question')
    expect(notificationForStatus('waiting', 'waiting')).toBeNull()
    expect(notificationForStatus('done', 'idle')).toBeNull()
    expect(notificationForStatus('idle', 'working')).toBeNull()
    expect(notificationForStatus('idle', 'done')).toBeNull()
    expect(notificationForStatus(undefined, 'waiting')).toBeNull()
  })

  it('classe les demandes de la gateway', () => {
    expect(notificationForRequest('approval')).toBe('approval')
    expect(notificationForRequest('vault.unlock_prompt')).toBe('question')
    expect(notificationForRequest('autre')).toBeNull()
  })

  it('se tait seulement quand le chat du bot est sous les yeux', () => {
    expect(shouldNotify({ enabled: true, focused: true, viewing: true })).toBe(false)
    expect(shouldNotify({ enabled: true, focused: false, viewing: true })).toBe(true)
    expect(shouldNotify({ enabled: true, focused: true, viewing: false })).toBe(true)
    expect(shouldNotify({ enabled: false, focused: false, viewing: false })).toBe(false)
  })

  it('coupe un long message sur une ligne', () => {
    expect(notificationExcerpt('  a\n\nb  ')).toBe('a b')
    expect(notificationExcerpt('x'.repeat(200), 10)).toBe(`${'x'.repeat(9)}…`)
    expect(notificationExcerpt(undefined)).toBe('')
  })
})
