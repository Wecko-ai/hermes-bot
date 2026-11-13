import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { notificationExcerpt, notificationForRequest, notificationForStatus, sendTestNotification, shouldNotify, turnReply, watchWhileHidden } from './notifications'

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

describe('message d’une fin de tour', () => {
  const now = Date.parse('2026-11-13T10:00:00Z')
  const at = (seconds: number) => new Date(now - seconds * 1000).toISOString()

  it('montre la réponse du bot que le tour vient d’ajouter', () => {
    expect(turnReply([{ role: 'user', content: 'Fais-le', createdAt: at(60) }, { role: 'assistant', content: 'Fait.', createdAt: at(1) }], now)).toBe('Fait.')
  })

  it('ne ressort pas une vieille réponse pour un tour vu seulement par les statuts', () => {
    expect(turnReply([{ role: 'assistant', content: 'Hier.', createdAt: at(86_400) }], now)).toBeUndefined()
    expect(turnReply([{ role: 'assistant', content: 'Avant.', createdAt: at(5) }, { role: 'user', content: 'Et ça ?', createdAt: at(2) }], now)).toBeUndefined()
    expect(turnReply([{ role: 'assistant', content: 'Sans date.', createdAt: null }], now)).toBeUndefined()
    expect(turnReply([], now)).toBeUndefined()
  })

  it('se tait sur un tour silencieux', () => {
    expect(turnReply([{ role: 'assistant', content: 'Avant.', createdAt: at(5) }, { role: 'system', content: '[NO_REPLY]', createdAt: at(1), technical: true }], now)).toBeUndefined()
  })
})

describe('fenêtre cachée', () => {
  it('suit les statuts seulement quand un bot travaille', () => {
    expect(watchWhileHidden([{ status: 'idle' }, { status: 'working' }])).toBe(true)
    expect(watchWhileHidden([{ status: 'thinking' }])).toBe(true)
    expect(watchWhileHidden([{ status: 'idle' }, { status: 'done' }, { status: 'waiting' }])).toBe(false)
    expect(watchWhileHidden([])).toBe(false)
  })
})

describe('notification de test', () => {
  type Handler = (() => void) | null
  class FakeNotification {
    static permission: NotificationPermission = 'granted'
    static requestPermission = vi.fn(async () => FakeNotification.permission)
    static last: FakeNotification | undefined
    onshow: Handler = null
    onerror: Handler = null
    onclick: Handler = null
    close = vi.fn()
    constructor(public title: string, public options: NotificationOptions) { FakeNotification.last = this }
  }

  beforeEach(() => {
    FakeNotification.permission = 'granted'
    FakeNotification.last = undefined
    vi.stubGlobal('Notification', FakeNotification)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('rapporte une notification affichée, avec le même tag à chaque essai', async () => {
    const result = sendTestNotification({ title: 'HermesBot', body: 'Test' })
    await Promise.resolve()
    expect(FakeNotification.last?.options.tag).toBe('hermesbot-test')
    FakeNotification.last?.onshow?.()
    await expect(result).resolves.toBe('shown')
  })

  it('rapporte un refus du système', async () => {
    const result = sendTestNotification({ title: 'HermesBot', body: 'Test' })
    await Promise.resolve()
    FakeNotification.last?.onerror?.()
    await expect(result).resolves.toBe('failed')
  })

  it('rapporte un silence quand macOS ne répond pas (app non signée)', async () => {
    vi.useFakeTimers()
    const result = sendTestNotification({ title: 'HermesBot', body: 'Test', timeoutMs: 1_000 })
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(result).resolves.toBe('silent')
  })

  it('demande la permission au besoin, et s’arrête si elle est refusée', async () => {
    FakeNotification.permission = 'default'
    FakeNotification.requestPermission.mockResolvedValueOnce('denied')
    await expect(sendTestNotification({ title: 'HermesBot', body: 'Test' })).resolves.toBe('failed')
    expect(FakeNotification.last).toBeUndefined()
  })

  it('ramène la fenêtre au clic', async () => {
    const onClick = vi.fn()
    void sendTestNotification({ title: 'HermesBot', body: 'Test', onClick })
    await Promise.resolve()
    FakeNotification.last?.onclick?.()
    expect(onClick).toHaveBeenCalled()
    expect(FakeNotification.last?.close).toHaveBeenCalled()
  })

  it('sans API de notification', async () => {
    vi.stubGlobal('Notification', undefined)
    await expect(sendTestNotification({ title: 'HermesBot', body: 'Test' })).resolves.toBe('unsupported')
  })
})
