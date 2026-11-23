import { describe, expect, it } from 'vitest'
import { nextCronRuns, parseScheduleInput, previewSchedule } from './cron-schedule.mjs'

describe('parseScheduleInput', () => {
  it('accepts raw cron', () => {
    expect(parseScheduleInput('0 9 * * *')).toEqual({ expr: '0 9 * * *', display: '0 9 * * *', source: 'cron' })
  })

  it('parses English natural language', () => {
    expect(parseScheduleInput('every day at 9am', 'en').expr).toBe('0 9 * * *')
    expect(parseScheduleInput('every monday 8am', 'en').expr).toBe('0 8 * * 1')
    expect(parseScheduleInput('every 2 hours', 'en').expr).toBe('0 */2 * * *')
  })

  it('parses French natural language', () => {
    expect(parseScheduleInput('tous les jours à 9h', 'fr').expr).toBe('0 9 * * *')
    expect(parseScheduleInput('tous les lundis à 8h', 'fr').expr).toBe('0 8 * * 1')
    expect(parseScheduleInput('toutes les 2 heures', 'fr').expr).toBe('0 */2 * * *')
  })
})

describe('nextCronRuns', () => {
  it('previews upcoming fires', () => {
    const runs = nextCronRuns('0 9 * * *', 2, new Date('2025-01-06T12:00:00Z'))
    expect(runs.length).toBe(2)
    expect(new Date(runs[0]).getHours()).toBe(9)
  })

  it('returns preview for a natural phrase', () => {
    const preview = previewSchedule('every day at 9am', 'en', 1)
    expect(preview.error).toBeUndefined()
    expect(preview.nextRuns?.length).toBe(1)
  })
})