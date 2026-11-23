import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../types'
import { i18n } from '../i18n'
import { threadItems } from './progress'
import { expandToolMessage, parseToolTranscript, toolTranscriptPreview, transcriptStepLabel } from './tool-transcript'

const RUSH = readFileSync(new URL('../../tests/fixtures/tool-transcript-rush.txt', import.meta.url), 'utf8')

const say = (id: string, content: string): ChatMessage => ({ id, role: 'assistant', content, createdAt: null })

const SAMPLE = [
  'Je vérifie la durée de l’intro.',
  '[Tool call] Shell command: ffprobe -v error -show_entries format=duration -of csv=p=0 1112.mov',
  '[Tool result] Shell (exit 0)',
  '28.402000',
  '',
  'L’intro dure environ 28 secondes.',
].join('\n')

const HEREDOC = [
  'Piste `1112.mov` (~28 min) et je vérifie si l’intro a les joueurs en rond.',
  '[Tool call] Shell',
  "  command: python3 <<'PY'",
  'import subprocess',
  'print(1)',
  'PY',
  "  description: Mesure l'intro",
  '  block_until_ms: 120000',
  '',
  '[Tool result] Shell',
  'ok',
  '',
  'C’est bon.',
].join('\n')

describe('tool transcript', () => {
  it('lifts a shell call out of a French reply and drops the result dump', () => {
    const parsed = parseToolTranscript(SAMPLE)
    expect(parsed.visible).toBe('Je vérifie la durée de l’intro.\n\nL’intro dure environ 28 secondes.')
    expect(parsed.steps).toEqual([
      { kind: 'shell', title: 'Shell', detail: expect.stringMatching(/^ffprobe -v error/) },
    ])
    expect(parsed.visible).not.toMatch(/\[Tool|28\.402/)
    expect(parsed.steps[0].detail).not.toContain('28.402000')
    expect(transcriptStepLabel(parsed.steps[0])).toBe(`Commande lancée : ${parsed.steps[0].detail}`)
    expect(i18n.t('progress.ranShell', { lng: 'en', what: 'ffprobe' })).toBe('Ran shell command: ffprobe')
    expect(i18n.t('progress.readFile', { lng: 'en', name: 'App.tsx' })).toBe('Read file App.tsx')
  })

  it('reads a multi-line heredoc call and keeps only its description', () => {
    const parsed = parseToolTranscript(HEREDOC)
    expect(parsed.visible).toBe('Piste `1112.mov` (~28 min) et je vérifie si l’intro a les joueurs en rond.\n\nC’est bon.')
    expect(parsed.steps).toEqual([{ kind: 'shell', title: 'Shell', detail: "Mesure l'intro" }])
    expect(parsed.visible).not.toContain('python3')
    expect(parsed.visible).not.toContain('import subprocess')
    expect(parsed.visible).not.toMatch(/\[Tool/)
  })

  it('hides a marker that is still streaming and labels the call so far', () => {
    const partial = parseToolTranscript('Je vérifie.\n[Tool call] Shell command: ffprobe -v err')
    expect(partial.visible).toBe('Je vérifie.')
    expect(partial.open).toBe(true)
    expect(partial.steps[0]).toMatchObject({ kind: 'shell', detail: 'ffprobe -v err' })

    const cut = parseToolTranscript('Je vérifie.\n[Tool')
    expect(cut.visible).toBe('Je vérifie.')
    expect(cut.steps).toEqual([])
    expect(cut.open).toBe(true)
    expect(cut.visible).not.toContain('[Tool')
  })

  it('names a file read and a gateway text fallback without the raw arguments', () => {
    const read = parseToolTranscript('[Tool call] Read\n  path: /tmp/projects/src/App.tsx\n\nFait.')
    expect(read.visible).toBe('Fait.')
    expect(read.steps[0]).toMatchObject({ kind: 'read', detail: 'App.tsx' })

    const gateway = parseToolTranscript([
      'Voici.',
      '[Tool calls:',
      '  terminal({"command": "ffprobe -v error"})',
      ']',
      '[Tool result call_1]: 28.4',
      '',
      'Terminé.',
    ].join('\n'))
    expect(gateway.visible).toBe('Voici.\n\nTerminé.')
    expect(gateway.steps[0]).toMatchObject({ kind: 'shell' })
    expect(gateway.steps[0].detail).toContain('ffprobe')
    expect(gateway.visible).not.toContain('28.4')
  })

  it('folds the call into the collapsed progress steps and leaves it out of the bubble', () => {
    const [row] = expandToolMessage(say('a1', SAMPLE))
    expect(row.progress).toBe(true)
    expect(row.content).not.toMatch(/\[Tool/)
    const items = threadItems([
      { id: 'u', role: 'user', content: 'Go', createdAt: null },
      say('a1', SAMPLE),
    ], false, 'rush', true)
    const turn = items[1]
    expect(turn.kind).toBe('turn')
    if (turn.kind !== 'turn') return
    expect(turn.collapsed).toBe(true)
    expect(turn.progress.map((item) => item.content).join('\n')).not.toMatch(/\[Tool|28\.402/)
    expect(turn.progress[0].content).toMatch(/^Commande lancée : ffprobe/)
    expect(turn.progress.some((item) => /Résultat/.test(item.content))).toBe(false)
    expect(turn.answer?.content).toBe('Je vérifie la durée de l’intro.\n\nL’intro dure environ 28 secondes.')
    expect(turn.answer?.content).not.toMatch(/\[Tool|28\.402/)
  })

  it('keeps a shell line after a heredoc inside the call (Rush session shape)', () => {
    const parsed = parseToolTranscript(RUSH)
    expect(parsed.visible).toBe('Piste `1112.mov` (~28 min) et je vérifie si l’intro a les joueurs en rond.')
    expect(parsed.visible).not.toMatch(/python3|import subprocess|sha256|block_until|\[Tool/)
    expect(parsed.steps).toEqual([{ kind: 'shell', title: 'Shell', detail: 'Find 25–31 min vlog masters' }])
    expect(transcriptStepLabel(parsed.steps[0])).toBe('Commande lancée : Find 25–31 min vlog masters')
    expect(toolTranscriptPreview(RUSH)).toBe(parsed.visible)
    expect(toolTranscriptPreview('Bonjour.')).toBe('Bonjour.')
  })

  it('keeps a fenced command and a fenced result out of the answer', () => {
    const fenced = [
      'Je liste.',
      '[Tool call] Shell',
      '  command: cat <<EOF',
      '```bash',
      'ls -la',
      '```',
      'EOF',
      '  description: List the folder',
      '',
      '[Tool result] Shell',
      '```',
      'total 2',
      '```',
      '',
      'Le rendu est prêt.',
    ].join('\n')
    const parsed = parseToolTranscript(fenced)
    expect(parsed.visible).toBe('Je liste.\n\nLe rendu est prêt.')
    expect(parsed.visible).not.toMatch(/ls -la|total 2|```/)
    expect(parsed.steps).toEqual([expect.objectContaining({ kind: 'shell', detail: 'List the folder' })])
  })

  it('splits a glued gateway result and leaves an ordinary note alone', () => {
    const glued = 'Voici.][Tool result tool_abc]: 28.4[Tool calls:\n  terminal({"command": "ls -la"})\n]\n\nLe rendu est prêt.'
    const parsed = parseToolTranscript(glued)
    expect(parsed.visible).toBe('Voici.\n\nLe rendu est prêt.')
    expect(parsed.visible).not.toMatch(/\[Tool|28\.4|ls -la/)
    expect(parsed.steps.map((step) => step.kind)).toEqual(['shell'])
    expect(parseToolTranscript('Une [Note] pour plus tard.')).toMatchObject({
      visible: 'Une [Note] pour plus tard.',
      steps: [],
    })
  })

  it('strips the markers even when the progress list is hidden', () => {
    const items = threadItems([
      { id: 'u', role: 'user', content: 'Go', createdAt: null },
      say('a1', RUSH),
    ], false, 'rush', false)
    const text = items.map((item) => (item.kind === 'message' ? item.message.content : '')).join('\n')
    expect(text).toContain('joueurs en rond')
    expect(text).not.toMatch(/\[Tool|python3|sha256|block_until/)
  })
})
