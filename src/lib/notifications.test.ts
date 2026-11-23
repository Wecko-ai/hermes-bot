import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { forgetTurn, noteTurnEvent, noteTurnInput, noteTurnSilence, cleanNotificationText, notificationBody, notificationExcerpt, notificationForRequest, notificationForStatus, notificationForWaiting, resetTurns, sendTestNotification, shouldNotify, turnEndsFromRows, turnForUser, turnReply, watchWhileHidden } from './notifications'

describe('notifications', () => {
  it('ne notifie pas un tour entre bots ni un tour fini en silence', () => {
    resetTurns()
    // No user row yet: the finish cannot be classified, so it does not notify.
    expect(turnForUser('orion')).toBe(false)
    noteTurnEvent('orion', { type: 'message.start', payload: {} })
    noteTurnInput('orion', 'Message from 🤖 Nova (@nova): relis le plan')
    noteTurnEvent('orion', { type: 'message.complete', payload: { text: 'Plan relu, OK.' } })
    expect(turnForUser('orion')).toBe(false)
    noteTurnEvent('orion', { type: 'message.start', payload: {} })
    noteTurnInput('orion', 'Fais-moi le point.')
    noteTurnEvent('orion', { type: 'message.complete', payload: { text: 'Voici le point.' } })
    expect(turnForUser('orion')).toBe(true)
    noteTurnEvent('orion', { type: 'message.start', payload: {} })
    noteTurnInput('orion', 'Un rapport.')
    noteTurnEvent('orion', { type: 'message.complete', payload: { text: '[SILENT]' } })
    expect(turnForUser('orion')).toBe(false)
    // A reply missing from the frame is unknown, not silent.
    noteTurnEvent('orion', { type: 'message.start', payload: {} })
    noteTurnInput('orion', 'Et maintenant ?')
    noteTurnEvent('orion', { type: 'message.complete', payload: {} })
    expect(turnForUser('orion')).toBe(true)
  })

  it('ignore un message.start vide et le drapeau du tour précédent', () => {
    resetTurns()
    noteTurnEvent('orion', { type: 'message.start', payload: {} })
    noteTurnInput('orion', 'Message from 🤖 Nova (@nova): réveille-toi')
    noteTurnEvent('orion', { type: 'message.complete', payload: { text: 'Je suis là.' } })
    expect(turnForUser('orion')).toBe(false)
    // The next turn starts with an empty message.start. The old fromBot flag must not survive.
    noteTurnEvent('orion', { type: 'message.start', payload: {} })
    expect(turnForUser('orion')).toBe(false)
    noteTurnInput('orion', 'Quel est le point ?')
    noteTurnEvent('orion', { type: 'message.complete', payload: { text: 'Le voici.' } })
    expect(turnForUser('orion')).toBe(true)
    // Status path: no message.start, a new user row replaces the previous flag.
    noteTurnInput('orion', 'Message from 🤖 Nova (@nova): encore')
    expect(turnForUser('orion')).toBe(false)
    forgetTurn('orion')
    expect(turnForUser('orion')).toBe(false)
    noteTurnInput('orion', 'Écris-moi le résumé.')
    expect(turnForUser('orion')).toBe(true)
    // The input could not be read: do not notify, and do not keep the previous answer.
    noteTurnInput('orion', null)
    expect(turnForUser('orion')).toBe(false)
  })

  it('lit la ligne utilisateur de l’historique, pas un message.start vide', () => {
    const rows = [
      { role: 'user', content: 'Ancien message.' },
      { role: 'assistant', content: 'Ancienne réponse.' },
      { type: 'message.start', payload: {} },
      { role: 'user', text: 'Message from 🤖 Nova (@nova): relis le plan' },
      { type: 'message.complete', payload: { text: 'Plan relu.' } },
    ]
    expect(turnEndsFromRows(rows)).toEqual({
      input: 'Message from 🤖 Nova (@nova): relis le plan',
      reply: 'Plan relu.',
    })
    expect(turnEndsFromRows([{ type: 'message.start', payload: {} }, { role: 'user', content: 'À moi.' }])).toEqual({
      input: 'À moi.',
      reply: null,
    })
    expect(turnEndsFromRows([])).toEqual({ input: null, reply: null })
    expect(turnEndsFromRows([{ role: 'user', content: [{ type: 'text', text: 'Message from 🤖 Nova (@nova): relis le plan' }] }])).toEqual({
      input: 'Message from 🤖 Nova (@nova): relis le plan',
      reply: null,
    })
  })

  it('reprend le texte du tampon quand la complétion est vide', () => {
    resetTurns()
    noteTurnEvent('orion', { type: 'message.start', payload: {} })
    noteTurnInput('orion', 'Écris-moi le résumé.')
    noteTurnEvent('orion', { type: 'message.complete', payload: { text: '' } })
    expect(turnForUser('orion')).toBe(false)
    noteTurnSilence('orion', 'Voici le résumé.')
    expect(turnForUser('orion')).toBe(true)
    noteTurnSilence('orion', '[SILENT]')
    expect(turnForUser('orion')).toBe(false)
  })

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

  it('distingue approbation et question quand le bot attend', () => {
    expect(notificationForWaiting('chat-orion', [{ sessionId: 'chat-orion', kind: 'approval' }])).toBe('approval')
    expect(notificationForWaiting('chat-orion', [{ sessionId: 'chat-orion', kind: 'clarify' }])).toBe('question')
    expect(notificationForWaiting('chat-nova', [{ sessionId: 'chat-orion', kind: 'approval' }])).toBe('question')
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

  it('retire le markdown, le code et les appels d’outils du texte notifié', () => {
    expect(cleanNotificationText('**C’est en place** : les replies sont prêts.')).toBe('C’est en place : les replies sont prêts.')
    expect(cleanNotificationText("[Tool call] Shell command: python3 <<'PY' im\nLe rendu est prêt.")).toBe('Le rendu est prêt.')
    expect(cleanNotificationText('Voici le plan.\n```json\n{"a":1}\n```')).toBe('Voici le plan.')
    expect(notificationExcerpt("[Tool call] Shell command: python3 <<'PY' import os")).toBe('')
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

  it('ignore une étape d’outil et reprend la vraie réponse', () => {
    expect(turnReply([
      { role: 'assistant', content: 'Le rendu est lancé.', createdAt: at(8) },
      { role: 'assistant', content: "[Tool call] Shell command: python3 <<'PY' import os", createdAt: at(1), progress: true },
    ], now)).toBe('Le rendu est lancé.')
  })
})

describe('corps de notification', () => {
  const now = Date.parse('2026-11-13T10:00:00Z')
  const at = (seconds: number) => new Date(now - seconds * 1000).toISOString()

  it('prend le texte final, sans markdown', () => {
    expect(notificationBody({
      recorded: '**C’est en place** : les replies sont prêts.',
      messages: [],
      fallback: 'A terminé sa tâche',
    })).toBe('C’est en place : les replies sont prêts.')
  })

  it('ignore un appel d’outil et reprend la dernière phrase utile', () => {
    expect(notificationBody({
      recorded: "[Tool call] Shell command: python3 <<'PY' import os",
      messages: [
        { role: 'assistant', content: 'Le premier exemple est prêt.', createdAt: at(3) },
        { role: 'assistant', content: "[Tool call] Shell command: python3 <<'PY' import os", createdAt: at(1), progress: true },
      ],
      fallback: 'A terminé sa tâche',
      now,
    })).toBe('Le premier exemple est prêt.')
  })

  it('utilise le résumé si aucune phrase n’est disponible', () => {
    expect(notificationBody({
      recorded: "[Tool call] Shell command: python3 <<'PY' import os",
      messages: [{ role: 'assistant', content: '[Tool call] Shell command: ls', createdAt: at(1), progress: true }],
      fallback: 'A terminé sa tâche',
      now,
    })).toBe('A terminé sa tâche')
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

describe('recorded reply of a finished turn', () => {
  it('returns the reply recorded at the end of the turn, never an older one', async () => {
    const { noteTurnReply, recordedReply, forgetTurn } = await import('./notifications')
    noteTurnReply('nova', 'Reprise terminée.', 1_000)
    noteTurnReply('nova', 'Travail de fond terminé.\n\nNO_REPLY', 2_000)
    expect(recordedReply('nova', 3_000)).toBe('Travail de fond terminé.')
    expect(recordedReply('nova', 2_000 + 3 * 60_000)).toBeUndefined()
    noteTurnReply('nova', '[SILENT]', 4_000)
    expect(recordedReply('nova', 5_000)).toBeUndefined()
    noteTurnReply('nova', 'Fini.', 6_000)
    forgetTurn('nova')
    expect(recordedReply('nova', 7_000)).toBeUndefined()
  })
})
