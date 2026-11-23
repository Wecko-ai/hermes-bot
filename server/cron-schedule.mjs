/**
 * Natural-language (FR/EN) and raw cron schedules, plus next-fire preview for five-field cron.
 */

function isRawCron(text) {
  const parts = text.trim().split(/\s+/)
  if (parts.length !== 5) return false
  return parts.every((part) => /^[\d*,/\-?A-Za-z]+$/.test(part))
}

const EN_DAYS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 }
const FR_DAYS = { dimanche: 0, lundi: 1, mardi: 2, mercredi: 3, jeudi: 4, vendredi: 5, samedi: 6 }

function parseClock(text) {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim()
  const ampm = normalized.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/)
  if (ampm) {
    let hour = Number(ampm[1])
    const minute = Number(ampm[2] || 0)
    if (ampm[3] === 'pm' && hour < 12) hour += 12
    if (ampm[3] === 'am' && hour === 12) hour = 0
    return { hour, minute }
  }
  const h24 = normalized.match(/\b(\d{1,2})h(?::(\d{2}))?\b/)
  if (h24) return { hour: Number(h24[1]), minute: Number(h24[2] || 0) }
  const colon = normalized.match(/\b(\d{1,2}):(\d{2})\b/)
  if (colon) return { hour: Number(colon[1]), minute: Number(colon[2]) }
  const bare = normalized.match(/\bat\s+(\d{1,2})\b/)
  if (bare) return { hour: Number(bare[1]), minute: 0 }
  return null
}

function weekdayField(text, lang) {
  const table = lang === 'fr' ? FR_DAYS : EN_DAYS
  const word = Object.keys(table).find((day) => text.includes(day))
  return word === undefined ? null : table[word]
}

function parseNaturalSchedule(text, lang = 'en') {
  const source = text.trim()
  if (!source) return { error: 'empty' }
  const lower = source.toLowerCase().replace(/\s+/g, ' ').trim()

  const everyHours = lower.match(/(?:every|toutes les?)\s+(\d+)\s+hours?|(?:every|toutes les?)\s+(\d+)\s+heures?/)
  if (everyHours) {
    const step = Number(everyHours[1] || everyHours[2])
    if (!Number.isFinite(step) || step < 1 || step > 23) return { error: 'invalid_interval' }
    return { expr: `0 */${step} * * *`, display: source, source: 'natural' }
  }
  if (/\bevery hour\b|\bchaque heure\b|\btoutes les heures\b/.test(lower)) {
    return { expr: '0 * * * *', display: source, source: 'natural' }
  }

  const clock = parseClock(lower)
  const daily = /\bevery day\b|\bdaily\b|\btous les jours\b|\bchaque jour\b/.test(lower)
  const weeklyDay = weekdayField(lower, lang)
  const weekly = weeklyDay !== null || /\bevery (monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(lower)
    || /\btous les (lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b/.test(lower)

  if (clock && daily) {
    return { expr: `${clock.minute} ${clock.hour} * * *`, display: source, source: 'natural' }
  }
  if (clock && weekly) {
    const dow = weeklyDay ?? weekdayField(lower, 'en') ?? weekdayField(lower, 'fr')
    if (dow === null) return { error: 'missing_weekday' }
    return { expr: `${clock.minute} ${clock.hour} * * ${dow}`, display: source, source: 'natural' }
  }

  return { error: 'unparseable' }
}

export function parseScheduleInput(text, lang = 'en') {
  const source = String(text || '').trim()
  if (!source) return { error: 'empty' }
  if (isRawCron(source)) return { expr: source, display: source, source: 'cron' }
  return parseNaturalSchedule(source, lang)
}

function expandField(field, min, max) {
  const values = new Set()
  const addRange = (from, to, step = 1) => {
    for (let value = from; value <= to; value += step) values.add(value)
  }
  for (const chunk of field.split(',')) {
    const part = chunk.trim()
    if (!part) continue
  const stepSplit = part.split('/')
  const base = stepSplit[0]
  const step = stepSplit[1] ? Number(stepSplit[1]) : 1
    if (base === '*') addRange(min, max, step)
    else if (base.includes('-')) {
      const [from, to] = base.split('-').map(Number)
      addRange(from, to, step)
    } else {
      const value = Number(base)
      if (Number.isFinite(value)) values.add(value)
    }
  }
  return values
}

function fieldMatches(values, value) {
  return values.has(value)
}

function cronMatches(date, parts) {
  const [minute, hour, dom, month, dow] = parts.map((field, index) => {
    const limits = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]][index]
    return expandField(field, limits[0], limits[1])
  })
  const jsDow = date.getDay()
  return fieldMatches(minute, date.getMinutes())
    && fieldMatches(hour, date.getHours())
    && fieldMatches(dom, date.getDate())
    && fieldMatches(month, date.getMonth() + 1)
    && fieldMatches(dow, jsDow)
}

export function nextCronRuns(expr, count = 5, from = new Date()) {
  const parts = String(expr || '').trim().split(/\s+/)
  if (parts.length !== 5) return []
  const results = []
  const cursor = new Date(from)
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)
  let guard = 0
  while (results.length < count && guard < 525_600) {
    if (cronMatches(cursor, parts)) results.push(new Date(cursor))
    cursor.setMinutes(cursor.getMinutes() + 1)
    guard += 1
  }
  return results.map((value) => value.toISOString())
}

export function previewSchedule(text, lang = 'en', count = 5) {
  const parsed = parseScheduleInput(text, lang)
  if (parsed.error) return parsed
  return { ...parsed, nextRuns: nextCronRuns(parsed.expr, count) }
}