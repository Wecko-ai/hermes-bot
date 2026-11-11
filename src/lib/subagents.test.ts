import { describe, expect, it } from 'vitest'
import { applySubagentEvent, applySubagentList, chatBackground, formatDuration, isSubagentActive, subagentDuration, type SubagentRow } from './subagents'

// Payloads shaped like the gateway’s `SubagentEventPayload` (tui_gateway/contracts/events.py).
const identity = { goal: 'Comparer trois offres', task_count: 2, task_index: 0, subagent_id: 'sa-1', parent_id: null, depth: 0, model: 'claude-sonnet-5-5', tool_count: 0 }

function run(events: [string, Record<string, unknown>, number][]) {
  return events.reduce<SubagentRow[]>((rows, [type, payload, at]) => applySubagentEvent(rows, type, payload, at), [])
}

describe('événements subagent.*', () => {
  it('suit un sous-agent de la demande à la fin', () => {
    const rows = run([
      ['subagent.spawn_requested', identity, 1_000],
      ['subagent.start', identity, 2_000],
      ['subagent.tool', { ...identity, tool_name: 'web_search', tool_preview: 'prix abonnement', text: 'prix abonnement', tool_count: 1 }, 3_000],
      ['subagent.progress', { ...identity, text: '🔀 web_search', tool_count: 1 }, 3_500],
      ['subagent.complete', { ...identity, status: 'completed', summary: 'L’offre B est la moins chère.', duration_seconds: 42.5, tool_count: 4, output_tail: [{ tool: 'web_search', preview: '3 résultats', is_error: false }] }, 4_000],
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: 'sa-1', goal: 'Comparer trois offres', status: 'completed', startedAt: 2_000, lastTool: 'web_search', toolCount: 4,
      summary: 'L’offre B est la moins chère.', durationSeconds: 42.5, model: 'claude-sonnet-5-5', taskCount: 2,
      outputTail: [{ tool: 'web_search', preview: '3 résultats', isError: false }],
    })
    expect(isSubagentActive(rows[0])).toBe(false)
  })

  it('garde le nom de l’outil, jamais ses arguments', () => {
    const [row] = run([['subagent.tool', { ...identity, tool_name: 'terminal', tool_preview: 'curl -H "Authorization: Bearer x"', text: 'curl …' }, 1_000]])
    expect(row.lastTool).toBe('terminal')
    expect(JSON.stringify(row)).not.toContain('Bearer')
  })

  it('n’affiche pas le raisonnement du sous-agent', () => {
    const [row] = run([['subagent.thinking', { ...identity, text: 'je pense que…' }, 1_000]])
    expect(row.status).toBe('running')
    expect(JSON.stringify(row)).not.toContain('je pense')
  })

  it('ne ramène jamais à la vie un sous-agent fini', () => {
    const rows = run([
      ['subagent.start', identity, 1_000],
      ['subagent.complete', { ...identity, status: 'failed', summary: 'Délai du fournisseur.' }, 2_000],
      ['subagent.tool', { ...identity, tool_name: 'read_file' }, 2_500],
    ])
    expect(rows[0].status).toBe('failed')
  })

  it('reconnaît chaque issue de la gateway, et rien d’autre', () => {
    for (const status of ['completed', 'failed', 'error', 'timeout', 'interrupted']) {
      expect(run([['subagent.complete', { ...identity, status }, 1_000]])[0].status).toBe(status)
    }
    expect(run([['subagent.complete', { ...identity, status: 'bizarre' }, 1_000]])[0].status).toBe('ended')
  })

  it('range un émetteur ancien sans subagent_id par sa place dans la délégation', () => {
    const old = { goal: 'Tâche', task_count: 2, task_index: 1, delegation_id: 'd-9' }
    const rows = run([['subagent.start', old, 1_000], ['subagent.complete', { ...old, status: 'completed' }, 2_000]])
    expect(rows.map((row) => [row.id, row.status])).toEqual([['d-9:1', 'completed']])
  })

  it('ignore les autres événements', () => {
    const rows: SubagentRow[] = []
    expect(applySubagentEvent(rows, 'message.delta', { text: 'x' })).toBe(rows)
    expect(applySubagentEvent(rows, 'subagent.text', identity)).toBe(rows)
  })
})

describe('subagent.list', () => {
  it('ajoute un sous-agent vivant que la fenêtre n’a pas vu partir', () => {
    const rows = applySubagentList([], [{ id: 'sa-2', goal: 'Résumer', status: 'running', startedAt: 5_000, toolCount: 2, lastTool: 'read_file', depth: 0 }], 9_000)
    expect(rows[0]).toMatchObject({ id: 'sa-2', goal: 'Résumer', status: 'running', startedAt: 5_000, lastTool: 'read_file' })
  })

  it('tient pour fini un sous-agent qui n’est plus listé, après un délai de grâce', () => {
    const rows = run([['subagent.start', identity, 1_000]])
    expect(applySubagentList(rows, [], 5_000)[0].status).toBe('running')
    expect(applySubagentList(rows, [], 20_000)[0].status).toBe('ended')
  })

  it('laisse gagner la fin déjà reçue sur une liste un peu en retard', () => {
    const rows = run([['subagent.start', identity, 1_000], ['subagent.complete', { ...identity, status: 'completed', summary: 'Fait.' }, 2_000]])
    const listed = applySubagentList(rows, [{ id: 'sa-1', status: 'running' }], 2_100)
    expect(listed[0]).toMatchObject({ status: 'completed', summary: 'Fait.' })
  })
})

describe('compte de la conversation', () => {
  it('ne compte que les sous-agents de premier niveau encore actifs, et les processus en cours', () => {
    const rows = run([
      ['subagent.start', identity, 1_000],
      ['subagent.start', { ...identity, subagent_id: 'sa-1a', parent_id: 'sa-1', depth: 1 }, 1_100],
      ['subagent.start', { ...identity, subagent_id: 'sa-2' }, 1_200],
      ['subagent.complete', { ...identity, subagent_id: 'sa-2', status: 'completed' }, 1_300],
    ])
    expect(chatBackground(rows, 2)).toEqual({ subagents: 1, processes: 2 })
    expect(chatBackground([], 0)).toBeUndefined()
    expect(chatBackground(undefined, undefined)).toBeUndefined()
  })
})

describe('durées', () => {
  it('écrit secondes, minutes et heures', () => {
    expect(formatDuration(42.4)).toBe('42 s')
    expect(formatDuration(185)).toBe('3 min 05 s')
    expect(formatDuration(3_720)).toBe('1 h 02 min')
  })

  it('compte le temps écoulé d’un sous-agent actif, la durée donnée par la gateway à la fin', () => {
    const [running] = run([['subagent.start', identity, 1_000]])
    expect(subagentDuration(running, 31_000)).toBe(30)
    const [done] = run([['subagent.start', identity, 1_000], ['subagent.complete', { ...identity, status: 'completed', duration_seconds: 12 }, 99_000]])
    expect(subagentDuration(done, 200_000)).toBe(12)
  })
})
