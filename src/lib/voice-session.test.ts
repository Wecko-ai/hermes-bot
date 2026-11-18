import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeDictationEngine } from './dictation-engines'
import { FakeSpeechEngine } from './speech-engines'
import type { PendingPrompt } from './hermes'
import { VoiceSession, type VoiceSessionOptions } from './voice-session'

const tick = () => vi.advanceTimersByTimeAsync(0)

function setup(overrides: Partial<VoiceSessionOptions> = {}) {
  const dictation = new FakeDictationEngine({ finalDelayMs: 50 })
  const speech = new FakeSpeechEngine({ msPerChar: null })
  const sent: { text: string; cutShort: boolean }[] = []
  const answers: { prompt: PendingPrompt; answer: string }[] = []
  const onEnd = vi.fn()
  const session = new VoiceSession({
    dictation,
    speech,
    languageCode: () => 'fr',
    settings: () => ({ voices: { fr: 'demo.fr-FR.thomas' }, rate: 1, speakSteps: true }),
    send: async (text, options) => { sent.push({ text, ...options }); return true },
    answer: async (prompt, answer) => { answers.push({ prompt, answer }); return true },
    onEnd,
    phrase: (key, language) => `${key}:${language}`,
    ...overrides,
  })
  /** One spoken utterance: press, words, the engine ends the listen. */
  const say = async (text: string) => {
    session.pressTalk()
    await tick()
    dictation.emitWords(text)
    dictation.emitDone()
    await tick()
    await tick()
  }
  return { session, dictation, speech, sent, answers, onEnd, say }
}

const clarify = (choices: string[], extra: Partial<PendingPrompt> = {}): PendingPrompt => ({
  sessionId: 's1', kind: 'clarify', promptId: 'p1', generation: 1, question: 'Quelle version veux-tu ?', choices, multiSelect: false, command: '', description: '', ...extra,
})

describe('VoiceSession', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('sends what was said, then speaks the reply sentence by sentence', async () => {
    const { session, speech, sent, say } = setup()
    await say('Résume la journée')
    expect(sent).toEqual([{ text: 'Résume la journée', cutShort: false }])
    expect(session.getSnapshot().phase).toBe('thinking')
    session.turnEnded({ text: 'Trois points aujourd’hui. Le rendu est fini. Il reste la miniature à valider.', meaningful: true })
    await tick()
    expect(speech.said.map((item) => item.text).length).toBeGreaterThanOrEqual(2)
    expect(speech.said[0]).toMatchObject({ voice: 'demo.fr-FR.thomas', language: 'fr-FR', rate: 1 })
    expect(session.getSnapshot().phase).toBe('speaking')
    expect(session.getSnapshot().caption).toBe(speech.said[0].text)
    while (speech.speaking) speech.finish()
    await tick()
    expect(session.getSnapshot().phase).toBe('idle')
  })

  it('never speaks a silent reply, nor a turn it did not start', async () => {
    const { session, speech, say } = setup()
    session.turnEnded({ text: 'Une réponse à un autre bot.', meaningful: true })
    await say('Tu es là ?')
    session.turnEnded({ text: '', meaningful: false })
    await tick()
    expect(speech.said).toEqual([])
    expect(session.getSnapshot().phase).toBe('idle')
  })

  it('skips the turn already running when its message was queued', async () => {
    const { session, speech, say } = setup()
    session.setRunning(true)
    await say('Et après ça, la vidéo')
    session.turnEnded({ text: 'Fin du tour précédent.', meaningful: true })
    await tick()
    expect(speech.said).toEqual([])
    session.turnEnded({ text: 'La vidéo est en rendu.', meaningful: true })
    await tick()
    expect(speech.said.map((item) => item.text)).toEqual(['La vidéo est en rendu.'])
  })

  it('speaks short steps of its own turns only', async () => {
    const { session, speech, say } = setup()
    session.turnStep('Je regarde ça.')
    await say('Cherche le prix')
    session.turnStep('Je lance la recherche.')
    session.turnStep('x'.repeat(400))
    await tick()
    expect(speech.said.map((item) => item.text)).toEqual(['Je lance la recherche.'])
  })

  it('ends on a bare "stop" and cancels on "annule", without sending', async () => {
    const { sent, onEnd, say, session } = setup()
    await say('annule')
    expect(session.getSnapshot().notice).toBe('cancelled')
    await say('Stop.')
    expect(onEnd).toHaveBeenCalledTimes(1)
    expect(sent).toEqual([])
  })

  it('never answers an approval by voice', async () => {
    const { session, speech, answers, sent, say } = setup()
    await say('Supprime les vieux rendus')
    session.prompt({ ...clarify([]), kind: 'approval', question: '', description: 'rm -rf out/' })
    await tick()
    expect(session.getSnapshot().phase).toBe('speaking')
    expect(speech.said[0].text).toContain('approval')
    while (speech.speaking) speech.finish()
    await say('oui')
    expect(answers).toEqual([])
    expect(sent.map((item) => item.text)).toEqual(['Supprime les vieux rendus', 'oui'])
  })

  it('answers a clarify question by the number of a choice', async () => {
    const { session, speech, answers, sent, say } = setup()
    await say('Prépare la vidéo')
    const prompt = clarify(['Courte', 'Longue'])
    session.prompt(prompt)
    await tick()
    expect(speech.said.map((item) => item.text).join(' ')).toContain('Longue')
    while (speech.speaking) speech.finish()
    await say('la deux')
    expect(answers).toEqual([{ prompt, answer: 'Longue' }])
    expect(sent).toHaveLength(1)
    expect(session.getSnapshot().question).toBeNull()
  })

  it('keeps the card when a choice is not understood', async () => {
    const { session, speech, answers, say } = setup()
    await say('Prépare la vidéo')
    session.prompt(clarify(['Courte', 'Longue']))
    while (speech.speaking) speech.finish()
    await say('je ne sais pas')
    expect(answers).toEqual([])
    expect(session.getSnapshot().notice).toBe('noMatch')
    expect(session.getSnapshot().question).not.toBeNull()
  })

  it('cuts the voice when the user talks over it, and tells the bot with the next message', async () => {
    const { session, speech, sent, say } = setup()
    await say('Raconte')
    session.turnEnded({ text: 'Une longue histoire commence ici. Elle continue encore longtemps.', meaningful: true })
    await tick()
    expect(speech.speaking).toBe(true)
    await say('Plus court')
    expect(speech.stopCalls).toBeGreaterThan(0)
    expect(sent[1]).toEqual({ text: 'Plus court', cutShort: true })
  })

  it('forgets the expected reply when the message was not sent', async () => {
    const { session, speech, say } = setup({ send: async () => false })
    await say('Bonjour')
    expect(session.getSnapshot().notice).toBe('notSent')
    expect(session.getSnapshot().phase).toBe('idle')
    session.turnEnded({ text: 'Réponse à autre chose.', meaningful: true })
    await tick()
    expect(speech.said).toEqual([])
  })

  it('holds a reply that arrives while listening, and speaks it after an empty listen', async () => {
    const { session, dictation, speech, say } = setup()
    await say('Quelle heure ?')
    session.pressTalk()
    await tick()
    session.turnEnded({ text: 'Il est midi.', meaningful: true })
    await tick()
    expect(speech.said).toEqual([])
    dictation.emitDone()
    await tick()
    await tick()
    expect(speech.said.map((item) => item.text)).toEqual(['Il est midi.'])
  })

  it('does not stay thinking for ever when a turn end is lost', async () => {
    const { session, say } = setup({ staleTurnMs: 1_000 })
    await say('Bonjour')
    session.setRunning(true)
    session.setRunning(false)
    expect(session.getSnapshot().phase).toBe('thinking')
    await vi.advanceTimersByTimeAsync(1_100)
    expect(session.getSnapshot().phase).toBe('idle')
  })

  it('push-to-talk: a long press ends the listen on release', async () => {
    const dictation = new FakeDictationEngine({ finalDelayMs: 50 })
    let now = 0
    const { session } = setup({ dictation, now: () => now, holdMs: 400 })
    session.pressTalk()
    await tick()
    expect(session.listening).toBe(true)
    now = 1_000
    session.releaseTalk()
    expect(dictation.stopCalls).toBe(1)
    // A short tap does not stop: the pause will.
    await vi.advanceTimersByTimeAsync(100)
    session.pressTalk()
    await tick()
    now = 1_100
    session.releaseTalk()
    expect(dictation.stopCalls).toBe(1)
  })

  it('stops speaking and listening when disposed', async () => {
    const { session, speech, say } = setup()
    await say('Raconte')
    session.turnEnded({ text: 'Une histoire.', meaningful: true })
    await tick()
    session.dispose()
    expect(speech.stopCalls).toBe(1)
  })
})

describe('VoiceSession speech refusals', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('tries once more when the voice is refused, then says it could not speak', async () => {
    const { session, speech, say } = setup()
    await say('Bonjour')
    speech.refuse = true
    session.turnEnded({ text: 'Salut.', meaningful: true })
    await tick()
    expect(session.getSnapshot().phase).toBe('speaking')
    speech.refuse = false
    await vi.advanceTimersByTimeAsync(450)
    expect(speech.said.map((item) => item.text)).toEqual(['Salut.'])
    while (speech.speaking) speech.finish()
    await tick()
    speech.refuse = true
    await say('Encore')
    session.turnEnded({ text: 'Toujours là.', meaningful: true })
    await vi.advanceTimersByTimeAsync(450)
    expect(session.getSnapshot().notice).toBe('speechFailed')
    expect(session.getSnapshot().phase).toBe('idle')
  })
})

describe('VoiceSession hands-free', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  function handsFree(overrides: Partial<VoiceSessionOptions> = {}) {
    const conversation = { opens: 0, closes: 0, allow: true }
    const parts = setup({
      initialMode: 'handsfree',
      conversation: { open: async () => { conversation.opens += 1; return conversation.allow }, close: () => { conversation.closes += 1 } },
      followUpMs: 3_000,
      firstListenMs: 5_000,
      relistenDelayMs: 100,
      ...overrides,
    })
    /** Words heard in the listen that is open now, then the end of the listen. */
    const hear = async (text: string) => {
      parts.dictation.emitWords(text)
      parts.dictation.emitDone()
      await tick()
      await tick()
    }
    return { ...parts, conversation, hear }
  }

  it('listens at once without a press, and again after each spoken reply', async () => {
    const { session, dictation, speech, sent, conversation, hear } = handsFree()
    session.begin()
    await tick()
    await tick()
    expect(conversation.opens).toBe(1)
    expect(dictation.listenCalls).toBe(1)
    expect(dictation.withoutGesture).toBe(true)
    expect(session.getSnapshot().phase).toBe('listening')
    await hear('Quoi de neuf ?')
    expect(sent.map((item) => item.text)).toEqual(['Quoi de neuf ?'])
    session.turnEnded({ text: 'Rien de spécial aujourd’hui.', meaningful: true })
    await tick()
    expect(dictation.listenCalls).toBe(1)
    while (speech.speaking) speech.finish()
    await vi.advanceTimersByTimeAsync(150)
    expect(dictation.listenCalls).toBe(2)
    expect(session.getSnapshot().phase).toBe('listening')
  })

  it('goes to standby when nothing is said in time, until a press', async () => {
    const { session, dictation, conversation } = handsFree()
    session.begin()
    await tick()
    await tick()
    await vi.advanceTimersByTimeAsync(5_100)
    expect(session.getSnapshot()).toMatchObject({ phase: 'idle', standby: true })
    session.pressTalk()
    await tick()
    await tick()
    expect(conversation.opens).toBe(2)
    expect(dictation.listenCalls).toBe(2)
    expect(session.getSnapshot().standby).toBe(false)
  })

  it('does not listen while the bot is still working after a spoken step', async () => {
    const { session, dictation, speech, hear } = handsFree()
    session.begin()
    await tick()
    await tick()
    await hear('Cherche le prix')
    session.turnStep('Je lance la recherche.')
    await tick()
    while (speech.speaking) speech.finish()
    await vi.advanceTimersByTimeAsync(500)
    expect(dictation.listenCalls).toBe(1)
    expect(session.getSnapshot().phase).toBe('thinking')
    session.turnEnded({ text: 'Trente euros.', meaningful: true })
    while (speech.speaking) speech.finish()
    await vi.advanceTimersByTimeAsync(150)
    expect(dictation.listenCalls).toBe(2)
  })

  it('drops the bot’s own voice heard back by the microphone', async () => {
    const { session, speech, sent, dictation, hear } = handsFree()
    session.begin()
    await tick()
    await tick()
    await hear('Donne-moi la météo')
    session.turnEnded({ text: 'Il fera beau et chaud demain après-midi.', meaningful: true })
    while (speech.speaking) speech.finish()
    await vi.advanceTimersByTimeAsync(150)
    await hear('il fera beau et chaud demain')
    expect(sent).toHaveLength(1)
    expect(dictation.listenCalls).toBe(3)
  })

  it('never listens again after an approval request', async () => {
    const { session, speech, dictation, hear } = handsFree()
    session.begin()
    await tick()
    await tick()
    await hear('Supprime les vieux rendus')
    session.prompt({ ...clarify([]), kind: 'approval', question: '', description: 'rm' })
    while (speech.speaking) speech.finish()
    await vi.advanceTimersByTimeAsync(500)
    expect(dictation.listenCalls).toBe(1)
  })

  it('a refused conversation means standby; push mode closes it', async () => {
    const refused = handsFree()
    refused.conversation.allow = false
    refused.session.begin()
    await tick()
    await tick()
    expect(refused.session.getSnapshot().standby).toBe(true)
    expect(refused.dictation.listenCalls).toBe(0)

    const { session, conversation, dictation } = handsFree()
    session.begin()
    await tick()
    await tick()
    session.setMode('push')
    await tick()
    expect(conversation.closes).toBe(1)
    expect(dictation.cancelCalls).toBe(1)
    expect(session.getSnapshot().mode).toBe('push')
    session.dispose()
    expect(conversation.closes).toBe(1)
  })

  it('without a conversation, hands-free is not offered', () => {
    const { session } = setup({ initialMode: 'handsfree' })
    expect(session.getSnapshot().mode).toBe('push')
  })
})

describe('VoiceSession end of speech', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('never cuts a held Talk, even through long pauses; the release sends', async () => {
    const { session, dictation, sent } = setup()
    session.pressTalk()
    await tick()
    await vi.advanceTimersByTimeAsync(2_500)
    dictation.emitWords('Bonjour')
    await vi.advanceTimersByTimeAsync(4_000)
    dictation.emitWords('Bonjour, prépare la vidéo')
    await vi.advanceTimersByTimeAsync(4_000)
    expect(dictation.stopCalls).toBe(0)
    expect(session.listening).toBe(true)
    session.releaseTalk()
    expect(dictation.stopCalls).toBe(1)
    dictation.emitDone()
    await tick()
    await tick()
    expect(sent.map((item) => item.text)).toEqual(['Bonjour, prépare la vidéo'])
  })

  it('a tap listens until a silence after the words, however late they start', async () => {
    const { session, dictation } = setup()
    session.pressTalk()
    await tick()
    session.releaseTalk()
    // Slow to start: nothing is cut before the first words.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(dictation.stopCalls).toBe(0)
    dictation.emitWords('Quoi de prévu')
    await vi.advanceTimersByTimeAsync(1_000)
    dictation.emitWords('Quoi de prévu demain')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(dictation.stopCalls).toBe(0)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(dictation.stopCalls).toBe(1)
  })

  it('a tap with nothing said gives up after the no-speech window', async () => {
    const { session, dictation } = setup({ noSpeechMs: 6_000 })
    session.pressTalk()
    await tick()
    session.releaseTalk()
    await vi.advanceTimersByTimeAsync(5_800)
    expect(dictation.cancelCalls).toBe(0)
    await vi.advanceTimersByTimeAsync(500)
    expect(dictation.cancelCalls).toBe(1)
  })

  it('hands-free already listening: a quick tap with nothing heard keeps listening, with words it sends', async () => {
    const conversation = { open: async () => true, close: () => {} }
    const { session, dictation } = setup({ initialMode: 'handsfree', conversation, firstListenMs: 15_000 })
    session.begin()
    await tick()
    await tick()
    expect(session.listening).toBe(true)
    session.pressTalk()
    await vi.advanceTimersByTimeAsync(100)
    session.releaseTalk()
    expect(dictation.stopCalls).toBe(0)
    expect(session.listening).toBe(true)
    dictation.emitWords('Allô')
    session.pressTalk()
    await vi.advanceTimersByTimeAsync(100)
    session.releaseTalk()
    expect(dictation.stopCalls).toBe(1)
  })
})
