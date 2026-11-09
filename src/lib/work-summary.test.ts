import { describe, expect, it } from 'vitest'
import { applyWorkEvent, workLine } from './work-summary'

const run = (events: { type: string; payload?: Record<string, unknown> }[]) =>
  events.reduce<ReturnType<typeof applyWorkEvent>>((summary, event) => applyWorkEvent(summary, event), undefined)

describe('résumé du travail', () => {
  it('montre la tâche en cours et sa progression', () => {
    const summary = run([
      { type: 'message.start' },
      { type: 'todo.updated', payload: { todos: [
        { content: 'Relire le plan', status: 'completed' },
        { content: 'Écrire le **résumé**', status: 'in_progress' },
        { content: 'Publier', status: 'pending' },
        { content: 'Abandonné', status: 'cancelled' },
      ] } },
    ])
    expect(workLine(summary)).toBe('2/3 · Écrire le résumé')
  })

  it('ne montre que le nom du fichier, jamais une commande', () => {
    expect(workLine(run([{ type: 'tool.start', payload: { name: 'read_file', context: '/home/a/docs/plan.md' } }]))).toBe('Lit plan.md')
    const command = run([{ type: 'tool.start', payload: { name: 'terminal', context: 'curl -H "Authorization: Bearer abc" x' } }])
    expect(workLine(command)).toBe('Lance une commande')
  })

  it('garde la première phrase écrite par le bot, sans les silences', () => {
    const note = run([{ type: 'message.interim', payload: { text: 'Je relis le brouillon complet. Ensuite je corrige.' } }])
    expect(workLine(note)).toBe('Je relis le brouillon complet.')
    expect(run([{ type: 'message.interim', payload: { text: 'NOREPLY' } }])).toBeUndefined()
  })

  it('oublie l’étape finie et le résumé à la fin du tour', () => {
    const step = run([{ type: 'tool.start', payload: { name: 'patch', context: 'a.ts' } }, { type: 'tool.complete', payload: { name: 'patch' } }])
    expect(workLine(step, 'Tâche de fond')).toBe('Tâche de fond')
    expect(run([{ type: 'tool.start', payload: { name: 'patch' } }, { type: 'message.complete' }])).toBeUndefined()
  })
})
