import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../types'
import { delegationTasks, parseDelegationCompletion, plainPreview, sameGoal, subagentHistory, subagentTitle } from './subagent-history'
import type { SubagentRow } from './subagents'

const BACKEND = 'Implement the BACKEND of the affiliate program exactly as specified in /Users/test/projects/site/docs/affiliation/SPEC.md, until npm test is green.'
const FRONTEND = 'Implement the FRONTEND of the affiliate program.'

// As `_format_batch_delegation` of Hermes writes it.
const BATCH = `[ASYNC DELEGATION BATCH COMPLETE — deleg_200fe48f]
A background fan-out unit you dispatched earlier — 2 subagent(s) — has finished; its consolidated results are below.

Dispatched: 2026-11-13 17:12:38 (41m31s ago)
Role: leaf   Model: claude-opus-5-5   Total duration: 2491.94s

--- ⚠ TASK 1/2: ${BACKEND}  (status=completed, api_calls=250, 2491.62s, TRUNCATED: hit max_iterations — work may be incomplete) ---
[TRUNCATED — subagent hit its iteration cap; the summary below may be incomplete. Verify before relying on it, or re-dispatch the unfinished part.]
## Summary

Backend done, **tests green**.
Full live transcript (complete tool/assistant trace): /tmp/deleg/task-0.log

--- ✗ TASK 2/2: ${FRONTEND}  (status=error, 12.5s) ---
(no summary — status=error: model refused)`

const SINGLE = `[ASYNC DELEGATION COMPLETE — deleg_1]
A background subagent you dispatched earlier has finished. You may have moved on since dispatching it; the full task source is below so you can act on the result or re-dispatch if things have changed.

Dispatched: 2026-11-13 10:00:00 (2m ago)
Original goal: Compare the hosting offers
Context you provided: Budget 20 € a month.
Two regions only.
Role: leaf   Model: claude-sonnet-5-5
Status: completed   API calls: 9   Duration: 64.2s
--- RESULT ---
Offer B is 20 % cheaper.`

const FAILED = `[ASYNC DELEGATION TASK FAILED — deleg_9, task 2/3]
One subagent in a background fan-out you dispatched has failed while its siblings are still running.
Task: Read the reviews
Status: timeout   Duration: 600s
Error: no answer in 10 minutes`

const message = (id: string, extra: Partial<ChatMessage>): ChatMessage => ({ id, role: 'user', content: '', createdAt: '2026-11-13T10:00:00.000Z', ...extra })
const row = (extra: Partial<SubagentRow>): SubagentRow => ({ id: 'sa-1', goal: '', status: 'running', updatedAt: Date.parse('2026-11-13T10:01:00Z'), depth: 0, taskIndex: 0, taskCount: 1, ...extra })

describe('appel delegate_task', () => {
  it('lit les tâches, la forme ancienne à un seul but, et ignore les actions de contrôle', () => {
    expect(delegationTasks({ tasks: [{ goal: ' A ', context: 'ctx' }, { goal: 'B' }, { goal: '' }] })).toEqual([{ goal: 'A', context: 'ctx' }, { goal: 'B' }])
    expect(delegationTasks('{"goal":"Seul","context":""}')).toEqual([{ goal: 'Seul' }])
    expect(delegationTasks({ action: 'steer', subagent_id: 'x', message: 'plus vite' })).toEqual([])
    expect(delegationTasks('pas du json')).toEqual([])
  })
})

describe('message de fin de la gateway', () => {
  it('lit un lot : statut, durée, appels, modèle, résultat sans les notes de la gateway', () => {
    const [backend, frontend] = parseDelegationCompletion(BATCH)
    expect(backend).toMatchObject({ goal: BACKEND, taskIndex: 0, taskCount: 2, status: 'completed', truncated: true, apiCalls: 250, durationSeconds: 2491.62, model: 'claude-opus-5-5' })
    expect(backend.result).toBe('## Summary\n\nBackend done, **tests green**.')
    expect(frontend).toMatchObject({ goal: FRONTEND, taskIndex: 1, status: 'error', truncated: false, durationSeconds: 12.5, error: 'model refused' })
    expect(frontend.result).toBeUndefined()
  })

  it('lit une fin unique avec son contexte sur plusieurs lignes', () => {
    expect(parseDelegationCompletion(SINGLE)).toEqual([{
      goal: 'Compare the hosting offers', context: 'Budget 20 € a month.\nTwo regions only.', taskIndex: 0, taskCount: 1,
      status: 'completed', truncated: false, apiCalls: 9, durationSeconds: 64.2, model: 'claude-sonnet-5-5', result: 'Offer B is 20 % cheaper.',
    }])
  })

  it('lit l’alerte d’échec d’un enfant en avance sur le lot', () => {
    expect(parseDelegationCompletion(FAILED)).toEqual([{ goal: 'Read the reviews', taskIndex: 1, taskCount: 3, status: 'timeout', truncated: false, durationSeconds: 600, error: 'no answer in 10 minutes', early: true }])
  })

  it('ignore tout autre message', () => {
    expect(parseDelegationCompletion('[IMPORTANT: Background process proc_1 completed')).toEqual([])
  })
})

describe('historique des sous-agents', () => {
  it('relie chaque appel à sa fin : prompt complet, résultat entier, plus récent d’abord', () => {
    const entries = subagentHistory([
      message('m1', { role: 'tool', technical: true, createdAt: '2026-11-13T10:00:00.000Z', delegation: [{ goal: BACKEND, context: 'Repo: site' }, { goal: FRONTEND }] }),
      message('m2', { content: BATCH, technical: true, createdAt: '2026-11-13T10:41:00.000Z' }),
      message('m3', { role: 'tool', technical: true, createdAt: '2026-11-13T11:00:00.000Z', delegation: [{ goal: 'Write the docs' }] }),
    ], [])
    expect(entries.map((entry) => [entry.goal, entry.status])).toEqual([['Write the docs', 'ended'], [FRONTEND, 'error'], [BACKEND, 'completed']])
    expect(entries[2]).toMatchObject({ id: 'm1:0', context: 'Repo: site', truncated: true, apiCalls: 250, model: 'claude-opus-5-5', finishedAt: Date.parse('2026-11-13T10:41:00Z') })
    expect(entries[2].result).toContain('tests green')
  })

  it('garde une fin sans appel (appel résumé par une compaction)', () => {
    const [entry] = subagentHistory([message('m9', { content: SINGLE, technical: true, createdAt: '2026-11-13T10:02:00.000Z' })], [])
    expect(entry).toMatchObject({ goal: 'Compare the hosting offers', context: 'Budget 20 € a month.\nTwo regions only.', status: 'completed', startedAt: Date.parse('2026-11-13T10:02:00Z') - 64_200 })
  })

  it('le résultat du lot remplace l’alerte d’échec', () => {
    const later = '[ASYNC DELEGATION BATCH COMPLETE — deleg_9]\nintro\n\nRole: leaf\n\n--- ✗ TASK 2/3: Read the reviews  (status=timeout, 600s) ---\n(timeout: no answer in 10 minutes)\nPartial output:\nHalf of them read.'
    const entries = subagentHistory([
      message('a', { role: 'tool', delegation: [{ goal: 'Read the reviews' }] }),
      message('b', { content: FAILED, createdAt: '2026-11-13T10:10:00.000Z' }),
      message('c', { content: later, createdAt: '2026-11-13T10:20:00.000Z' }),
    ], [])
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ id: 'a:0', status: 'timeout', error: 'no answer in 10 minutes', result: 'Half of them read.', finishedAt: Date.parse('2026-11-13T10:20:00Z') })
  })

  it('suit la ligne vivante d’un enfant en cours, et ne ressuscite pas un enfant fini', () => {
    const history = [
      message('m1', { role: 'tool', delegation: [{ goal: 'Compare the hosting offers', context: 'Budget' }] }),
      message('m2', { content: SINGLE, createdAt: '2026-11-13T10:02:00.000Z' }),
    ]
    // Same goal sent again: a new child runs while the first one is done.
    const live = [row({ id: 'sa-2', goal: 'Compare the hosting offers', status: 'running', startedAt: Date.parse('2026-11-13T11:00:00Z'), lastTool: 'web_search' })]
    const entries = subagentHistory(history, live)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ id: 'live:sa-2', status: 'running' })
    expect(entries[0].live?.lastTool).toBe('web_search')
    expect(entries[1]).toMatchObject({ id: 'm1:0', status: 'completed', context: 'Budget' })
  })

  it('un appel encore en cours prend l’état de sa ligne vivante, puis sa fin', () => {
    const history = [message('m1', { role: 'tool', delegation: [{ goal: 'Résumer les avis clients' }] })]
    const running = subagentHistory(history, [row({ goal: 'Résumer les avis clients', status: 'running' })])
    expect(running[0]).toMatchObject({ id: 'm1:0', status: 'running', finishedAt: undefined })
    const done = subagentHistory(history, [row({ goal: 'Résumer les avis clients', status: 'completed', summary: 'Rapide, cher.', durationSeconds: 64, updatedAt: 5 })])
    expect(done[0]).toMatchObject({ id: 'm1:0', status: 'completed', result: 'Rapide, cher.', durationSeconds: 64, finishedAt: 5 })
  })

  it('reconnaît un but coupé par la gateway', () => {
    expect(sameGoal(BACKEND, `${BACKEND.slice(0, 60)}…`)).toBe(true)
    expect(sameGoal('Short goal', 'Short goal and more')).toBe(false)
  })
})

describe('affichage', () => {
  it('titre court : première phrase, longs chemins raccourcis', () => {
    const title = subagentTitle(BACKEND)
    expect(title).toBe('Implement the BACKEND of the affiliate program exactly as specified in…')
    expect(subagentTitle('Fix /Users/test/projects/site/docs/affiliation/SPEC.md now.')).toBe('Fix …/affiliation/SPEC.md now.')
    expect(subagentTitle('Read the reviews. Then sum them up.')).toBe('Read the reviews. Then sum them up.')
    expect(subagentTitle('Compare the hosting offers in detail. Then pick one.')).toBe('Compare the hosting offers in detail.')
  })

  it('aperçu du résultat sans Markdown ni tableau', () => {
    expect(plainPreview('## Summary\n\n| a | b |\n|---|---|\n| 1 | 2 |\n- **Done**: `npm test` green')).toBe('Summary · Done: npm test green')
  })
})
