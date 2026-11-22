// Shared durable memory for every Hermes profile.
//
// Hermes keeps MEMORY.md and USER.md inside each profile and injects them at session start.
// Those files stay per profile (and are tiny). This store is a separate set of files the user
// owns under the Hermes home, one markdown file per type. A skill in skills.external_dirs makes
// the files available to every profile, and a short marked entry in each profile's MEMORY.md
// points at them so the next session sees them without a Hermes patch.
//
// server/local-memory.mjs is unrelated: it only keeps an Ollama model loaded for the local chat.
// Hindsight, when it is the profile's memory provider, keeps its own bank. This store does not
// copy that bank; the Memory screen only reports that the provider is active.

export const MEMORY_TYPES = ['user', 'behavior', 'people', 'workstream']
export const MEMORY_CHAR_LIMIT = 2200
export const DIGEST_BUDGET = 700
export const FACT_TEXT_MAX = 400
export const FACTS_MAX = 400
export const SHARED_MARKER = '[hermesbot-shared]'
export const SHARED_ROOT = '~/.hermes/shared-memory'
export const SKILL_DIR = '~/.hermes/shared-memory/skill'
export const SKILL_FILE = '~/.hermes/shared-memory/skill/SKILL.md'
export const SKILL_NAME = 'hermesbot-shared-memory'

export const TYPE_FILES = {
  user: '~/.hermes/shared-memory/user-profile.md',
  behavior: '~/.hermes/shared-memory/behavior-rules.md',
  people: '~/.hermes/shared-memory/people.md',
  workstream: '~/.hermes/shared-memory/workstreams.md',
}

const TYPE_TITLES = {
  user: 'User profile',
  behavior: 'Behavior rules',
  people: 'People and organizations',
  workstream: 'Workstreams',
}

const PROFILE_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/
const FACT_ID = /^f[a-z0-9]{4,24}$/
const LEARNED = /^(user|unknown|[a-z0-9][a-z0-9_-]{0,63})$/
const STRUCTURED = /^- (f[a-z0-9]{4,24}) \| learned=(user|unknown|[a-z0-9][a-z0-9_-]{0,63}) \| (\S{10,40}) \| (.{1,400})$/

export const isMemoryType = (value) => MEMORY_TYPES.includes(value)
export const isProfileSlug = (value) => typeof value === 'string' && PROFILE_SLUG.test(value)

export function profileMemoryPath(slug, file) {
  if (slug === 'default') return `~/.hermes/memories/${file}`
  return `~/.hermes/profiles/${slug}/memories/${file}`
}

export function profileSoulPath(slug) {
  if (slug === 'default') return '~/.hermes/SOUL.md'
  return `~/.hermes/profiles/${slug}/SOUL.md`
}

export function hindsightConfigPath(slug) {
  if (slug === 'default') return '~/.hermes/hindsight/config.json'
  return `~/.hermes/profiles/${slug}/hindsight/config.json`
}

/** A new fact id. `random` returns a string of letters and digits. */
export function newFactId(now = Date.now(), random = () => Math.random().toString(36).slice(2, 8)) {
  const stamp = Math.max(0, Math.floor(now)).toString(36)
  const extra = String(random()).replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 6).padEnd(4, '0')
  return `f${stamp}${extra}`.slice(0, 25)
}

export function cleanFactText(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, FACT_TEXT_MAX)
}

export function cleanLearnedBy(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return LEARNED.test(text) ? text : 'user'
}

function cleanTime(value, fallback) {
  if (typeof value !== 'string' || value.length < 10 || value.length > 40) return fallback
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? fallback : new Date(parsed).toISOString()
}

/** One fact as stored. Returns null when the text is empty. */
export function makeFact({ id, type, text, learnedBy, createdAt, updatedAt }, now = new Date()) {
  const clean = cleanFactText(text)
  if (!isMemoryType(type) || !clean || !FACT_ID.test(id)) return null
  const stamp = now.toISOString()
  return {
    id,
    type,
    text: clean,
    learnedBy: cleanLearnedBy(learnedBy),
    createdAt: cleanTime(createdAt, stamp),
    updatedAt: cleanTime(updatedAt, stamp),
  }
}

export function renderTypeFile(type, facts) {
  const title = TYPE_TITLES[type]
  const lines = [
    `# ${title}`,
    '',
    `<!-- hermesbot-shared-memory type=${type} -->`,
    '',
    'Facts shared by every bot. One fact per bullet. HermesBot rewrites this file when you edit it in the app; a bot may append a bullet of the form `- id | learned=<profile> | <time> | <text>`.',
    '',
  ]
  for (const fact of facts) {
    if (fact.type !== type) continue
    lines.push(`- ${fact.id} | learned=${fact.learnedBy} | ${fact.updatedAt} | ${fact.text}`)
  }
  if (!facts.some((fact) => fact.type === type)) lines.push('')
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`
}

/** Facts in one type file. A loose bullet (no id) is kept and given an id. */
export function parseTypeFile(type, text, { now = new Date(), random } = {}) {
  if (!isMemoryType(type) || typeof text !== 'string') return []
  const facts = []
  const seen = new Set()
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line.startsWith('- ')) continue
    const structured = STRUCTURED.exec(line)
    if (structured) {
      const fact = makeFact({
        id: structured[1],
        type,
        learnedBy: structured[2],
        updatedAt: structured[3],
        createdAt: structured[3],
        text: structured[4],
      }, now)
      if (!fact || seen.has(fact.id)) continue
      seen.add(fact.id)
      facts.push(fact)
      continue
    }
    const loose = cleanFactText(line.slice(2))
    if (!loose || loose.startsWith('id |')) continue
    let id = newFactId(now.getTime() + facts.length, random)
    while (seen.has(id)) id = newFactId(now.getTime() + facts.length + seen.size, random)
    const fact = makeFact({ id, type, text: loose, learnedBy: 'unknown', createdAt: now.toISOString(), updatedAt: now.toISOString() }, now)
    if (!fact) continue
    seen.add(fact.id)
    facts.push(fact)
  }
  return facts.slice(0, FACTS_MAX)
}

export function skillDocument() {
  return `---
name: ${SKILL_NAME}
description: Shared durable memory for every bot — user profile, behavior rules, people and organizations, workstreams. Read it before acting on the user, people, or ongoing work.
---

# Shared memory

Facts every bot shares live in files the user owns:

- ${TYPE_FILES.user} — user profile
- ${TYPE_FILES.behavior} — behavior rules
- ${TYPE_FILES.people} — people and organizations
- ${TYPE_FILES.workstream} — workstreams

Read the files that match the task. Each bullet is one fact:

\`- id | learned=<profile or user> | <ISO time> | <text>\`

When you learn a durable fact of one of these kinds, append one bullet to the matching file and set \`learned\` to your Hermes profile name. Do not keep that fact only in your private MEMORY.md or USER.md. Do not delete another bot's bullets. To forget a fact, delete its bullet.

Your private MEMORY.md may contain one entry that starts with \`${SHARED_MARKER}\`. Leave that entry in place; HermesBot refreshes it. If Hindsight is this profile's memory provider, you may also retain the same fact with its tools. The files above stay the copy the user edits.
`
}

export function skillNeedsWrite(text) {
  return typeof text !== 'string' || !text.includes(`name: ${SKILL_NAME}`)
}

/** The `skills` config patch that adds the shared skill directory, or null when it is already there. */
export function externalDirPatch(config) {
  const skills = config && typeof config.skills === 'object' && config.skills && !Array.isArray(config.skills) ? { ...config.skills } : {}
  const dirs = Array.isArray(skills.external_dirs) ? skills.external_dirs.filter((item) => typeof item === 'string') : []
  if (dirs.includes(SKILL_DIR)) return null
  return { config: { skills: { ...skills, external_dirs: [...dirs, SKILL_DIR] } } }
}

function splitEntries(text) {
  if (typeof text !== 'string' || !text.trim()) return []
  return text.split(/\n[ \t]*§[ \t]*\n/).map((entry) => entry.trim()).filter(Boolean)
}

function joinEntries(entries) {
  return entries.filter(Boolean).join('\n\n§\n\n')
}

/** A short system-prompt entry. The newest facts of each type, inside DIGEST_BUDGET. */
export function digestLine(facts) {
  const parts = []
  for (const type of MEMORY_TYPES) {
    const own = facts.filter((fact) => fact.type === type)
    if (!own.length) continue
    const sample = own.slice(-3).map((fact) => fact.text).join('; ')
    parts.push(`${TYPE_TITLES[type]}: ${sample}`)
  }
  const body = parts.join(' ').replace(/\s+/g, ' ').trim()
  const prefix = `${SHARED_MARKER} Shared facts for every bot live in ${SHARED_ROOT}. Read them with the ${SKILL_NAME} skill.`
  if (!body) return prefix
  const room = DIGEST_BUDGET - prefix.length - 1
  if (room < 24) return prefix
  const clipped = body.length <= room ? body : `${body.slice(0, room - 1).trim()}…`
  return `${prefix} ${clipped}`
}

/**
 * Puts the shared entry into a profile's MEMORY.md and leaves every other entry alone.
 * `digest` when the entry fits, `pointer` when only a one-line pointer fits, `unchanged` when
 * the file is already at Hermes's character limit, `same` when the text would not change.
 */
export function upsertSharedEntry(memoryText, facts) {
  const current = typeof memoryText === 'string' ? memoryText : ''
  const others = splitEntries(current).filter((entry) => !entry.includes(SHARED_MARKER))
  const digest = digestLine(facts)
  const withDigest = joinEntries([...others, digest])
  if (withDigest.length <= MEMORY_CHAR_LIMIT) {
    return { text: withDigest ? `${withDigest}\n` : `${digest}\n`, mode: current.trim() === withDigest.trim() ? 'same' : 'digest' }
  }
  const pointer = `${SHARED_MARKER} Shared facts for every bot: ${SHARED_ROOT}. Read them with the ${SKILL_NAME} skill.`
  const withPointer = joinEntries([...others, pointer])
  if (withPointer.length <= MEMORY_CHAR_LIMIT) {
    return { text: `${withPointer}\n`, mode: current.trim() === withPointer.trim() ? 'same' : 'pointer' }
  }
  return { text: current, mode: 'unchanged' }
}

/** Private Hermes entries (MEMORY.md / USER.md), without the shared marker. */
export function privateEntries(text, profile, store) {
  if (!isProfileSlug(profile) && profile !== 'default') return []
  if (store !== 'memory' && store !== 'user') return []
  return splitEntries(text)
    .filter((entry) => !entry.includes(SHARED_MARKER))
    .slice(0, 40)
    .map((entry) => ({ profile, store, text: cleanFactText(entry).slice(0, FACT_TEXT_MAX) }))
    .filter((entry) => entry.text)
}

const SECRET_KEY = /key|token|secret|password|credential/i

/** Bank id from a Hindsight config file. Secret-looking fields are never returned. */
export function hindsightSummary(text) {
  if (typeof text !== 'string' || !text.trim()) return null
  let json
  try { json = JSON.parse(text) } catch { return null }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null
  for (const key of ['bank_id', 'bank', 'profile']) {
    const value = json[key]
    if (typeof value !== 'string') continue
    const bank = value.trim()
    if (!bank || bank.length > 80 || SECRET_KEY.test(key) || SECRET_KEY.test(bank)) continue
    return { bank }
  }
  return { bank: '' }
}

/** Provider name from `GET /api/memory`. Empty when the payload has none. */
export function readProviderName(body) {
  if (!body || typeof body !== 'object') return ''
  const active = body.active
  const candidates = [
    body.provider,
    body.active_provider,
    body.memory_provider,
    active && typeof active === 'object' ? active.name : '',
    active && typeof active === 'object' ? active.id : '',
    typeof active === 'string' ? active : '',
  ]
  for (const value of candidates) {
    if (typeof value === 'string' && /^[a-z0-9_-]{1,40}$/.test(value)) return value
  }
  return ''
}

export function replaceFacts(facts, type, next) {
  return [...facts.filter((fact) => fact.type !== type), ...next].slice(0, FACTS_MAX)
}

export function addFact(facts, input, now = new Date(), random) {
  if (facts.length >= FACTS_MAX) return { error: 'full' }
  const ids = new Set(facts.map((fact) => fact.id))
  let id = FACT_ID.test(input.id) ? input.id : newFactId(now.getTime(), random)
  while (ids.has(id)) id = newFactId(now.getTime() + ids.size, random)
  const fact = makeFact({ ...input, id, createdAt: now.toISOString(), updatedAt: now.toISOString() }, now)
  if (!fact) return { error: 'invalid' }
  return { facts: [...facts, fact], fact }
}

export function updateFact(facts, { id, text }, now = new Date()) {
  const index = facts.findIndex((fact) => fact.id === id)
  if (index < 0) return { error: 'not_found' }
  const fact = makeFact({ ...facts[index], text, updatedAt: now.toISOString() }, now)
  if (!fact) return { error: 'invalid' }
  const next = facts.slice()
  next[index] = fact
  return { facts: next, fact }
}

export function forgetFact(facts, id) {
  if (!facts.some((fact) => fact.id === id)) return { error: 'not_found' }
  return { facts: facts.filter((fact) => fact.id !== id) }
}
