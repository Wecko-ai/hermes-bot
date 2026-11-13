import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DictationController,
  formatTimer,
  joinTranscript,
  preferredLocaleId,
  type DictationAccess,
  type DictationEngine,
  type DictationNotice,
} from './dictation'
import { BrowserDictationEngine, browserErrorCode, createDictationEngine, DesktopDictationEngine, DEMO_DICTATION, FakeDictationEngine, type DictationBridge, type DictationBridgeEvent } from './dictation-engines'
import { barCount, quantizeLevel, stillBars, WaveSampler } from './dictation-wave'

let field = ''
let language = 'fr'
let offline = false
let notices: DictationNotice[] = []

const make = (engine: DictationEngine, extra: Partial<ConstructorParameters<typeof DictationController>[0]> = {}) => new DictationController({
  engine,
  languageCode: () => language,
  getText: () => field,
  setText: (text) => { field = text },
  isOffline: () => offline,
  onNotice: (notice) => notices.push(notice),
  ...extra,
})

beforeEach(() => {
  vi.useFakeTimers()
  field = ''
  language = 'fr'
  offline = false
  notices = []
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('helpers', () => {
  it('formate le minuteur en m:ss', () => {
    expect(formatTimer(0)).toBe('0:00')
    expect(formatTimer(999)).toBe('0:00')
    expect(formatTimer(10_000)).toBe('0:10')
    expect(formatTimer(61_500)).toBe('1:01')
    expect(formatTimer(600_000)).toBe('10:00')
    expect(formatTimer(-5)).toBe('0:00')
    expect(formatTimer(Number.NaN)).toBe('0:00')
  })

  it('suit la langue de l’interface, jamais celle du système', () => {
    expect(preferredLocaleId('fr')).toBe('fr-FR')
    expect(preferredLocaleId('en')).toBe('en-US')
    expect(preferredLocaleId('de')).toBe('en-US')
  })

  it('colle la transcription après le texte, avec une espace', () => {
    expect(joinTranscript('Hier', 'resto 25')).toBe('Hier resto 25')
    expect(joinTranscript('', 'resto')).toBe('resto')
    expect(joinTranscript('Hier', '')).toBe('Hier')
  })
})

describe('écoute', () => {
  it('repos, écoute : langue de l’interface, transcription en direct, niveau', async () => {
    const engine = new FakeDictationEngine()
    const controller = make(engine)
    expect(controller.phase).toBe('idle')
    await controller.start()
    expect(controller.phase).toBe('listening')
    expect(controller.getSnapshot().listeningSince).not.toBeNull()
    expect(engine.lastLocaleId).toBe('fr-FR')
    expect(engine.lastOnDevice).toBe(true)
    expect(engine.lastListenForMs).toBe(60_000)
    expect(engine.lastPauseForMs).toBe(4_500)
    engine.emitWords('4,50 €')
    expect(field).toBe('4,50 €')
    engine.emitWords('4,50 € café')
    expect(field).toBe('4,50 € café')
    engine.emitLevel(0.7)
    expect(controller.level).toBe(0.7)
    engine.emitLevel(Number.NaN)
    expect(controller.level).toBe(0)
    engine.emitLevel(4)
    expect(controller.level).toBe(1)
  })

  it('interface en anglais : en-US', async () => {
    language = 'en'
    const engine = new FakeDictationEngine()
    await make(engine).start()
    expect(engine.lastLocaleId).toBe('en-US')
  })

  it('sans modèle local : reconnaissance du système (onDevice faux)', async () => {
    const engine = new FakeDictationEngine({ onDevice: false })
    const controller = make(engine)
    await controller.start()
    expect(controller.phase).toBe('listening')
    expect(engine.lastOnDevice).toBe(false)
  })

  it('la transcription s’ajoute au texte déjà tapé, après une espace', async () => {
    field = 'Hier '
    const engine = new FakeDictationEngine()
    await make(engine).start()
    engine.emitWords('resto 25')
    expect(field).toBe('Hier resto 25')
  })

  it('rien entendu : le champ ne bouge pas', async () => {
    field = 'Café '
    const engine = new FakeDictationEngine()
    const controller = make(engine)
    await controller.start()
    const stopped = controller.stop()
    await vi.advanceTimersByTimeAsync(700)
    await stopped
    expect(controller.phase).toBe('idle')
    expect(field).toBe('Café ')
    expect(notices).toEqual([])
  })

  it('dictée, puis une seconde : repart du texte du champ (y compris ce qui a été retouché)', async () => {
    const engine = new FakeDictationEngine()
    const controller = make(engine)
    await controller.start()
    engine.emitWords('café 3')
    const stopped = controller.stop()
    await vi.advanceTimersByTimeAsync(700)
    await stopped
    field = `${field} (corrigé)`
    await controller.start()
    engine.emitWords('croissant 2')
    expect(field).toBe('café 3 (corrigé) croissant 2')
  })

  it('un rappel d’une ancienne session est ignoré', async () => {
    const engine = new FakeDictationEngine()
    const controller = make(engine)
    await controller.start()
    const oldEmit = (text: string) => engine.emitWords(text)
    controller.cancel()
    // The engine is dropped: even a stray callback of the first session writes nothing.
    oldEmit('fantôme')
    expect(field).toBe('')
    await controller.start()
    engine.emitWords('vrai')
    expect(field).toBe('vrai')
  })
})

describe('arrêt', () => {
  it('stop : attend le résultat final, garde le texte, retour au repos', async () => {
    const engine = new FakeDictationEngine({ finalDelayMs: 120 })
    const controller = make(engine)
    await controller.start()
    engine.emitWords('hier resto')
    const stopped = controller.stop()
    expect(controller.phase).toBe('finishing')
    expect(engine.stopCalls).toBe(1)
    await vi.advanceTimersByTimeAsync(200)
    await stopped
    expect(controller.phase).toBe('idle')
    expect(field).toBe('hier resto')
  })

  it('le résultat final remplace le partiel', async () => {
    const engine = new FakeDictationEngine({ finalDelayMs: null })
    const controller = make(engine)
    await controller.start()
    engine.emitWords('hier rest')
    const stopped = controller.stop()
    engine.emitWords('hier resto', true)
    await stopped
    expect(controller.phase).toBe('idle')
    expect(field).toBe('hier resto')
  })

  it('sans résultat final, la fin tient au plus 600 ms', async () => {
    const engine = new FakeDictationEngine({ finalDelayMs: null })
    const controller = make(engine)
    await controller.start()
    engine.emitWords('hier')
    const stopped = controller.stop()
    await vi.advanceTimersByTimeAsync(599)
    expect(controller.phase).toBe('finishing')
    await vi.advanceTimersByTimeAsync(2)
    await stopped
    expect(controller.phase).toBe('idle')
    expect(field).toBe('hier')
  })

  it('finish (Envoyer) arrête une seule fois, même appelé deux fois', async () => {
    const engine = new FakeDictationEngine({ finalDelayMs: null })
    const controller = make(engine)
    await controller.start()
    engine.emitWords('bonjour')
    const first = controller.finish()
    const second = controller.finish()
    engine.emitWords('bonjour tout', true)
    await Promise.all([first, second])
    expect(engine.stopCalls).toBe(1)
    expect(field).toBe('bonjour tout')
    expect(controller.phase).toBe('idle')
  })

  it('arrêt automatique (silence, durée maximale) : comme un stop', async () => {
    const engine = new FakeDictationEngine({ finalDelayMs: null })
    const controller = make(engine)
    await controller.start()
    engine.emitWords('un deux')
    engine.emitDone(false)
    expect(controller.phase).toBe('finishing')
    engine.emitWords('un deux trois', true)
    await vi.advanceTimersByTimeAsync(0)
    expect(controller.phase).toBe('idle')
    expect(field).toBe('un deux trois')
  })

  it('fin de session sans final : retour au repos tout de suite', async () => {
    const engine = new FakeDictationEngine()
    const controller = make(engine)
    await controller.start()
    engine.emitWords('un')
    engine.emitDone()
    await vi.advanceTimersByTimeAsync(0)
    expect(controller.phase).toBe('idle')
    expect(field).toBe('un')
  })

  it('le silence met fin à la session tout seul (faux moteur fidèle à la pause)', async () => {
    const engine = new FakeDictationEngine({ text: 'un deux', honorPause: true, wordEveryMs: 100, finalDelayMs: 0 })
    const controller = make(engine)
    await controller.start()
    await vi.advanceTimersByTimeAsync(300)
    expect(field).toBe('un deux')
    expect(controller.phase).toBe('listening')
    await vi.advanceTimersByTimeAsync(4_600)
    expect(controller.phase).toBe('idle')
    expect(field).toBe('un deux')
  })

  it('stop pendant le démarrage (alerte d’autorisation) : rien n’écoute ensuite', async () => {
    let grant: (access: DictationAccess) => void = () => {}
    const engine = new FakeDictationEngine()
    engine.initialize = () => new Promise<DictationAccess>((resolve) => { grant = resolve })
    const controller = make(engine)
    const starting = controller.start()
    expect(controller.phase).toBe('starting')
    await controller.stop()
    expect(controller.phase).toBe('idle')
    grant('granted')
    await starting
    expect(engine.listenCalls).toBe(0)
    expect(controller.phase).toBe('idle')
  })

  it('stop pendant l’ouverture du micro : le micro est rendu', async () => {
    const engine = new FakeDictationEngine()
    let open: (started: boolean) => void = () => {}
    engine.listen = () => new Promise<boolean>((resolve) => { open = resolve })
    const controller = make(engine)
    const starting = controller.start()
    await vi.advanceTimersByTimeAsync(0)
    await controller.stop()
    open(true)
    await starting
    expect(engine.cancelCalls).toBe(1)
    expect(controller.phase).toBe('idle')
  })

  it('cancel : le texte déjà écrit reste, plus rien n’arrive', async () => {
    const engine = new FakeDictationEngine()
    const controller = make(engine)
    await controller.start()
    engine.emitWords('un')
    controller.cancel()
    expect(controller.phase).toBe('idle')
    expect(engine.cancelCalls).toBe(1)
    engine.emitWords('un deux')
    expect(field).toBe('un')
  })

  it('dispose pendant l’écoute : micro rendu, aucun rappel ne passe', async () => {
    const engine = new FakeDictationEngine()
    const controller = make(engine)
    await controller.start()
    controller.dispose()
    expect(engine.cancelCalls).toBe(1)
    engine.emitWords('tard')
    expect(field).toBe('')
  })

  it('prévient les abonnés à chaque changement d’état', async () => {
    const engine = new FakeDictationEngine()
    const controller = make(engine)
    const phases: string[] = []
    controller.subscribe(() => phases.push(controller.phase))
    await controller.start()
    const stopped = controller.stop()
    await vi.advanceTimersByTimeAsync(200)
    await stopped
    expect(phases).toEqual(['starting', 'listening', 'finishing', 'idle'])
  })
})

describe('refus et erreurs', () => {
  it('autorisation refusée : bloqué, message, un clic le répète sans redemander à l’OS', async () => {
    const engine = new FakeDictationEngine({ access: 'denied' })
    const controller = make(engine)
    await controller.start()
    expect(controller.phase).toBe('idle')
    expect(controller.blocked).toBe('permission')
    expect(notices).toEqual(['permission'])
    await controller.start()
    expect(notices).toEqual(['permission', 'permission'])
    expect(engine.initializeCalls).toBe(1)
    // Back from System Settings: the next click asks again.
    controller.recheckAccess()
    expect(controller.blocked).toBeNull()
    engine.access = 'granted'
    await controller.start()
    expect(controller.phase).toBe('listening')
    expect(engine.initializeCalls).toBe(2)
  })

  it('reconnaissance indisponible : bloqué, et le retour de fenêtre ne le lève pas', async () => {
    const controller = make(new FakeDictationEngine({ access: 'unavailable' }))
    await controller.start()
    expect(controller.blocked).toBe('unavailable')
    expect(notices).toEqual(['unavailable'])
    controller.recheckAccess()
    expect(controller.blocked).toBe('unavailable')
  })

  it('pas de micro : son propre message, levé au retour de fenêtre', async () => {
    const engine = new FakeDictationEngine({ access: 'noMicrophone' })
    const controller = make(engine)
    await controller.start()
    expect(controller.blocked).toBe('noMicrophone')
    expect(notices).toEqual(['noMicrophone'])
    controller.recheckAccess()
    expect(controller.blocked).toBeNull()
  })

  it('langue absente : bloqué, jamais une autre langue', async () => {
    const engine = new FakeDictationEngine({ localeAvailable: false })
    const controller = make(engine)
    await controller.start()
    expect(controller.blocked).toBe('language')
    expect(notices).toEqual(['language'])
    expect(engine.listenCalls).toBe(0)
  })

  it('hors ligne sans modèle local : message, bouton réutilisable', async () => {
    offline = true
    const engine = new FakeDictationEngine({ onDevice: false })
    const controller = make(engine)
    await controller.start()
    expect(controller.phase).toBe('idle')
    expect(controller.blocked).toBeNull()
    expect(notices).toEqual(['offline'])
    offline = false
    await controller.start()
    expect(controller.phase).toBe('listening')
  })

  it('reconnaissance du système injoignable : message réseau', async () => {
    const engine = new FakeDictationEngine({ onDevice: false, serverReachable: false })
    await make(engine).start()
    expect(notices).toEqual(['offline'])
  })

  it('hors ligne avec modèle local : la dictée marche', async () => {
    offline = true
    const controller = make(new FakeDictationEngine({ onDevice: true }))
    await controller.start()
    expect(controller.phase).toBe('listening')
    expect(notices).toEqual([])
  })

  it('aucune correspondance, délai, occupé : repos sans message', async () => {
    for (const code of ['error_no_match', 'error_speech_timeout', 'error_busy']) {
      const engine = new FakeDictationEngine()
      const controller = make(engine)
      await controller.start()
      engine.emitError(code)
      expect(controller.phase).toBe('idle')
      expect(controller.blocked).toBeNull()
    }
    expect(notices).toEqual([])
  })

  it('erreur réseau sans modèle local et rien entendu : message réseau', async () => {
    const engine = new FakeDictationEngine({ onDevice: false })
    const controller = make(engine)
    await controller.start()
    engine.emitError('error_network')
    expect(controller.phase).toBe('idle')
    expect(notices).toEqual(['offline'])
  })

  it('erreur après des mots : le texte reste, pas de message', async () => {
    const engine = new FakeDictationEngine({ onDevice: false })
    const controller = make(engine)
    await controller.start()
    engine.emitWords('bonjour')
    engine.emitError('error_network')
    expect(controller.phase).toBe('idle')
    expect(field).toBe('bonjour')
    expect(notices).toEqual([])
  })

  it('autorisation retirée pendant l’écoute : bloqué', async () => {
    const engine = new FakeDictationEngine()
    const controller = make(engine)
    await controller.start()
    engine.emitError('error_permission')
    expect(controller.blocked).toBe('permission')
    expect(notices).toEqual(['permission'])
  })

  it('micro débranché pendant l’écoute : bloqué, message propre', async () => {
    const engine = new FakeDictationEngine()
    const controller = make(engine)
    await controller.start()
    engine.emitError('error_no_microphone')
    expect(controller.blocked).toBe('noMicrophone')
    expect(notices).toEqual(['noMicrophone'])
  })

  it('langue absente signalée par le moteur, rien entendu : bloqué', async () => {
    const engine = new FakeDictationEngine()
    const controller = make(engine)
    await controller.start()
    engine.emitError('error_language_unavailable')
    expect(controller.blocked).toBe('language')
  })

  it('l’écoute ne démarre pas : message, bouton réutilisable', async () => {
    const engine = new FakeDictationEngine({ startSucceeds: false })
    const controller = make(engine)
    await controller.start()
    expect(controller.phase).toBe('idle')
    expect(controller.blocked).toBeNull()
    expect(notices).toEqual(['failed'])
  })

  it('listen lève : message, aucune exception', async () => {
    const engine = new FakeDictationEngine()
    engine.listen = () => Promise.reject(new Error('boom'))
    const controller = make(engine)
    await controller.start()
    expect(controller.phase).toBe('idle')
    expect(notices).toEqual(['failed'])
  })

  it('initialize lève : indisponible', async () => {
    const engine = new FakeDictationEngine()
    engine.initialize = () => Promise.reject(new Error('boom'))
    const controller = make(engine)
    await controller.start()
    expect(controller.blocked).toBe('unavailable')
  })

  it('error_listen_failed rien entendu : message', async () => {
    const engine = new FakeDictationEngine()
    const controller = make(engine)
    await controller.start()
    engine.emitError('error_listen_failed')
    expect(notices).toEqual(['failed'])
  })
})

describe('moteurs', () => {
  it('le faux dicte mot à mot avec un niveau synthétique', async () => {
    const engine = new FakeDictationEngine({ text: 'un deux trois', wordEveryMs: 100, levelEveryMs: 20 })
    const controller = make(engine)
    await controller.start()
    await vi.advanceTimersByTimeAsync(110)
    expect(field).toBe('un')
    await vi.advanceTimersByTimeAsync(200)
    expect(field).toBe('un deux trois')
    expect(controller.level).toBeGreaterThan(0)
  })

  it('pont du bureau : prepare une fois, puis start avec la langue de l’interface', async () => {
    const listeners = new Set<(event: DictationBridgeEvent) => void>()
    const bridge: DictationBridge = {
      prepare: vi.fn(async () => ({ access: 'granted' as const, microphone: true, exists: true, onDevice: true, available: true })),
      start: vi.fn(async () => true),
      stop: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      onEvent: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    }
    const emit = (event: DictationBridgeEvent) => listeners.forEach((listener) => listener(event))
    const controller = make(new DesktopDictationEngine(bridge, () => language))
    await controller.start()
    expect(bridge.prepare).toHaveBeenCalledTimes(1)
    expect(bridge.prepare).toHaveBeenCalledWith('fr-FR')
    expect(bridge.start).toHaveBeenCalledWith({ localeId: 'fr-FR', onDevice: true, listenForMs: 60_000, pauseForMs: 4_500 })
    emit({ type: 'level', value: 0.5 })
    expect(controller.level).toBe(0.5)
    emit({ type: 'words', text: 'salut', final: false })
    expect(field).toBe('salut')
    const stopped = controller.stop()
    emit({ type: 'words', text: 'salut tout le monde', final: true })
    await stopped
    expect(bridge.stop).toHaveBeenCalled()
    expect(field).toBe('salut tout le monde')
    emit({ type: 'done' })
    expect(listeners.size).toBe(0)
    controller.dispose()
  })

  it('pont du bureau : refus, pas de micro, langue absente, hors ligne', async () => {
    const base: Awaited<ReturnType<DictationBridge['prepare']>> = { access: 'granted', microphone: true, exists: true, onDevice: true, available: true }
    const run = async (answer: Partial<typeof base>) => {
      notices = []
      const bridge: DictationBridge = {
        prepare: async () => ({ ...base, ...answer }),
        start: async () => true,
        stop: async () => {},
        cancel: async () => {},
        onEvent: () => () => {},
      }
      const controller = make(new DesktopDictationEngine(bridge, () => language))
      await controller.start()
      return { controller, notices: [...notices] }
    }
    expect((await run({ access: 'denied' })).notices).toEqual(['permission'])
    expect((await run({ access: 'unavailable' })).notices).toEqual(['unavailable'])
    expect((await run({ microphone: false })).notices).toEqual(['noMicrophone'])
    expect((await run({ exists: false })).notices).toEqual(['language'])
    expect((await run({ onDevice: false, available: false })).notices).toEqual(['offline'])
    expect((await run({})).controller.phase).toBe('listening')
  })

  it('pont du bureau : start refusé, message', async () => {
    const bridge: DictationBridge = {
      prepare: async () => ({ access: 'granted', microphone: true, exists: true, onDevice: true, available: true }),
      start: async () => false,
      stop: async () => {},
      cancel: async () => {},
      onEvent: () => () => {},
    }
    await make(new DesktopDictationEngine(bridge, () => language)).start()
    expect(notices).toEqual(['failed'])
  })

  it('erreurs du navigateur : codes du contrôleur', () => {
    expect(browserErrorCode('not-allowed')).toBe('error_permission')
    expect(browserErrorCode('service-not-allowed')).toBe('error_permission')
    expect(browserErrorCode('audio-capture')).toBe('error_no_microphone')
    expect(browserErrorCode('network')).toBe('error_network')
    expect(browserErrorCode('no-speech')).toBe('error_speech_timeout')
    expect(browserErrorCode('language-not-supported')).toBe('error_language_not_supported')
    expect(browserErrorCode(undefined)).toBe('error_listen_failed')
  })

  it('choix du moteur : démo, pont, navigateur, ou rien', async () => {
    const context = { demo: false, language: 'fr' as const, languageCode: () => 'fr' }
    vi.stubGlobal('window', {})
    expect(createDictationEngine(context)).toBeNull()
    vi.stubGlobal('window', { webkitSpeechRecognition: class {} })
    expect(createDictationEngine(context)).toBeInstanceOf(BrowserDictationEngine)
    // In the desktop app the Web Speech API is never used.
    vi.stubGlobal('window', { hermesBot: { platform: 'electron' }, webkitSpeechRecognition: class {} })
    expect(createDictationEngine(context)).toBeNull()
    vi.stubGlobal('window', { hermesBot: { platform: 'electron', dictation: {} } })
    expect(createDictationEngine(context)).toBeInstanceOf(DesktopDictationEngine)
    const demo = createDictationEngine({ ...context, demo: true }) as FakeDictationEngine
    expect(demo).toBeInstanceOf(FakeDictationEngine)
    expect(demo.text).toBe(DEMO_DICTATION.fr)
  })
})

describe('onde', () => {
  it('compte les barres qui tiennent dans la largeur', () => {
    expect(barCount(0)).toBe(0)
    expect(barCount(3)).toBe(1)
    expect(barCount(72)).toBe(12)
  })

  it('garde les plus récents à droite, avec un lissage léger', () => {
    const sampler = new WaveSampler()
    sampler.push(1)
    sampler.push(0)
    const recent = sampler.recent(3)
    expect(recent).toHaveLength(3)
    expect(recent[0]).toBe(0)
    expect(recent[1]).toBeCloseTo(0.6)
    expect(recent[2]).toBeCloseTo(0.24)
  })

  it('retombe en points au silence', () => {
    const sampler = new WaveSampler()
    for (let index = 0; index < 5; index += 1) sampler.push(1)
    for (let index = 0; index < 30; index += 1) sampler.push(0)
    expect(Math.max(...sampler.recent(8))).toBeLessThan(0.01)
  })

  it('réduire les animations : quatre paliers, forme fixe', () => {
    expect(quantizeLevel(0)).toBe(0)
    expect(quantizeLevel(0.2)).toBe(1)
    expect(quantizeLevel(0.5)).toBe(2)
    expect(quantizeLevel(1)).toBe(3)
    expect(quantizeLevel(Number.NaN)).toBe(0)
    expect(stillBars(0, 4)).toEqual([0, 0, 0, 0])
    const full = stillBars(3, 3)
    expect(full[0]).toBeCloseTo(0.45)
    expect(stillBars(3, 12)).toEqual(stillBars(3, 12))
  })
})
