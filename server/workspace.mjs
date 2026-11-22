// Memory, skills and the bot sheet, through the Hermes gateway the app already signs in to.
// Profile files and `/api/config` are the fallback when a newer route is missing, so an
// unpatched Hermes still accepts the edits it already knows how to store.

import {
  FACTS_MAX, MEMORY_TYPES, SKILL_FILE, TYPE_FILES,
  addFact, externalDirPatch, forgetFact, hindsightConfigPath, hindsightSummary, isMemoryType,
  isProfileSlug, parseTypeFile, privateEntries, profileMemoryPath, profileSoulPath, readProviderName,
  renderTypeFile, skillDocument, skillNeedsWrite, updateFact, upsertSharedEntry,
} from './shared-memory.mjs'
import {
  allowedSkillPath, cleanSkillName, disabledNames, disabledSkillsPatch, hubResultsOf, modelOfConfig,
  modelPatch, normalizeSkill, publicDetail, skillFromFile, toolsetsFromConfig, toolsetsOf,
} from './skills-catalog.mjs'

const SOUL_MAX = 64 * 1024
const SKILL_TEXT_MAX = 48_000
const PROFILES_MAX = 12

const missing = (status) => status === 404 || status === 405 || status === 501

function profilesOf(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((slug) => isProfileSlug(slug)))].slice(0, PROFILES_MAX)
}

async function readOk(gateway, file) {
  const read = await gateway.readText(file)
  if (read.status === 200) return { ok: true, text: typeof read.text === 'string' ? read.text : '' }
  if (read.status === 404 || read.status === 0) return { ok: true, text: '' }
  return { ok: false, text: '' }
}

export function createWorkspace({ gateway, now = () => new Date(), random, scanLocalSkills } = {}) {
  if (!gateway) throw new Error('gateway_required')

  async function loadFacts() {
    const facts = []
    const unreadable = []
    for (const type of MEMORY_TYPES) {
      const read = await readOk(gateway, TYPE_FILES[type])
      if (!read.ok) { unreadable.push(type); continue }
      facts.push(...parseTypeFile(type, read.text, { now: now(), random }))
    }
    return { facts: facts.slice(0, FACTS_MAX), unreadable }
  }

  async function writeType(type, facts) {
    const wrote = await gateway.writeText(TYPE_FILES[type], renderTypeFile(type, facts.filter((fact) => fact.type === type)))
    if (!wrote.ok) throw Object.assign(new Error('memory_unwritable'), { status: 502 })
  }

  async function publish(profiles, facts) {
    let skill = 'present'
    try {
      const current = await readOk(gateway, SKILL_FILE)
      if (!current.ok) skill = 'failed'
      else if (skillNeedsWrite(current.text)) {
        const wrote = await gateway.writeText(SKILL_FILE, skillDocument())
        skill = wrote.ok ? 'written' : 'failed'
      }
    } catch {
      skill = 'failed'
    }
    const rows = []
    for (const slug of profilesOf(profiles)) {
      const row = { slug, externalDir: 'present', memory: 'same' }
      try {
        const patch = externalDirPatch(await gateway.readConfig(slug))
        if (patch) {
          await gateway.writeConfig(slug, patch)
          row.externalDir = 'added'
        }
      } catch {
        row.externalDir = 'failed'
      }
      try {
        const read = await readOk(gateway, profileMemoryPath(slug, 'MEMORY.md'))
        if (!read.ok) row.memory = 'failed'
        else {
          const next = upsertSharedEntry(read.text, facts)
          row.memory = next.mode === 'same' ? 'same' : next.mode
          if (next.mode === 'digest' || next.mode === 'pointer') {
            const wrote = await gateway.writeText(profileMemoryPath(slug, 'MEMORY.md'), next.text)
            if (!wrote.ok) row.memory = 'failed'
          }
        }
      } catch {
        row.memory = 'failed'
      }
      rows.push(row)
    }
    return { skill, profiles: rows }
  }

  async function providersFor(profiles) {
    const rows = []
    for (const slug of profilesOf(profiles).slice(0, 8)) {
      let provider = ''
      let known = false
      try {
        const response = await gateway.request('GET', `/api/memory?${new URLSearchParams({ profile: slug })}`)
        if (response.status === 200) {
          known = true
          provider = readProviderName(response.body)
        }
      } catch { /* the route is optional */ }
      let bank = ''
      const file = await readOk(gateway, hindsightConfigPath(slug)).catch(() => ({ ok: false, text: '' }))
      if (file.ok && file.text) bank = hindsightSummary(file.text)?.bank || ''
      if (!provider && !known && bank) provider = 'hindsight'
      if (provider || bank) rows.push({ profile: slug, provider, bank, active: provider === 'hindsight' })
    }
    return rows
  }

  async function privateFor(profiles) {
    const entries = []
    for (const slug of profilesOf(profiles)) {
      for (const store of ['memory', 'user']) {
        const file = store === 'memory' ? 'MEMORY.md' : 'USER.md'
        const read = await readOk(gateway, profileMemoryPath(slug, file)).catch(() => ({ ok: false, text: '' }))
        if (read.ok) entries.push(...privateEntries(read.text, slug, store))
      }
    }
    return entries.slice(0, 200)
  }

  async function memoryView({ profiles }) {
    const loaded = await loadFacts()
    const slugs = profilesOf(profiles)
    const [providers, learned] = await Promise.all([providersFor(slugs), privateFor(slugs)])
    return { facts: loaded.facts, unreadable: loaded.unreadable, providers, learned }
  }

  async function memoryChange({ action, profiles, id, type, text, learnedBy }) {
    const loaded = await loadFacts()
    if ((action === 'add' || action === 'share') && isMemoryType(type) && loaded.unreadable.includes(type)) {
      throw Object.assign(new Error('memory_unreadable'), { status: 502 })
    }
    const clock = now()
    let result
    if (action === 'add' || action === 'share') result = addFact(loaded.facts, { type, text, learnedBy }, clock, random)
    else if (action === 'update') result = updateFact(loaded.facts, { id, text }, clock)
    else if (action === 'forget') result = forgetFact(loaded.facts, id)
    else throw Object.assign(new Error('invalid_memory'), { status: 400 })
    if (result.error === 'full') throw Object.assign(new Error('memory_full'), { status: 409 })
    if (result.error === 'invalid') throw Object.assign(new Error('invalid_memory'), { status: 400 })
    if (result.error === 'not_found') throw Object.assign(new Error('memory_not_found'), { status: 404 })
    const changedType = result.fact?.type || loaded.facts.find((fact) => fact.id === id)?.type
    if (isMemoryType(changedType)) await writeType(changedType, result.facts)
    else if (action === 'forget') {
      const previous = loaded.facts.find((fact) => fact.id === id)
      if (previous) await writeType(previous.type, result.facts)
    }
    const published = await publish(profiles, result.facts)
    return { fact: result.fact || null, facts: result.facts, published }
  }

  async function skills({ profile }) {
    if (!isProfileSlug(profile)) throw Object.assign(new Error('invalid_profile'), { status: 400 })
    const response = await gateway.request('GET', `/api/skills?${new URLSearchParams({ profile })}`)
    if (response.status === 200) {
      const list = Array.isArray(response.body) ? response.body : Array.isArray(response.body?.skills) ? response.body.skills : []
      return { supported: true, source: 'gateway', skills: list.map((item) => normalizeSkill(item, { profile })).filter(Boolean) }
    }
    if (!missing(response.status)) return { supported: false, source: 'gateway', error: 'unavailable', skills: [] }
    let disabled = new Set()
    try { disabled = disabledNames(await gateway.readConfig(profile)) } catch { /* the files still list */ }
    const files = scanLocalSkills ? await scanLocalSkills(profile) : []
    return {
      supported: true,
      source: 'files',
      skills: files.map((file) => skillFromFile({ ...file, profile, disabled })).filter(Boolean),
    }
  }

  async function skillFile({ profile, name }) {
    const skill = cleanSkillName(name)
    if (!isProfileSlug(profile) || !skill) throw Object.assign(new Error('invalid_skill'), { status: 400 })
    const listed = await skills({ profile })
    const known = listed.skills.find((item) => item.name === skill)
    const candidates = [
      known?.path,
      `~/.hermes/skills/${skill}/SKILL.md`,
      `~/.hermes/profiles/${profile}/skills/${skill}/SKILL.md`,
      profile === 'default' ? '' : `~/.hermes/profiles/${profile}/skills/${skill}/SKILL.md`,
      SKILL_FILE,
    ].filter((file) => allowedSkillPath(file) || file === SKILL_FILE)
    for (const file of [...new Set(candidates)]) {
      const read = await readOk(gateway, file)
      if (read.ok && read.text) return { name: skill, path: file, text: read.text.slice(0, SKILL_TEXT_MAX) }
    }
    throw Object.assign(new Error('skill_not_found'), { status: 404 })
  }

  async function toggleSkill({ profile, name, enabled }) {
    const skill = cleanSkillName(name)
    if (!isProfileSlug(profile) || !skill || typeof enabled !== 'boolean') throw Object.assign(new Error('invalid_skill'), { status: 400 })
    const response = await gateway.request('PUT', `/api/skills/toggle?${new URLSearchParams({ profile })}`, { name: skill, enabled, profile })
    if (response.status === 200) return { ok: true, via: 'gateway', name: skill, enabled }
    if (!missing(response.status)) throw Object.assign(new Error('skill_toggle_failed'), { status: 502 })
    const config = await gateway.readConfig(profile)
    const patch = disabledSkillsPatch(config, skill, enabled)
    if (patch?.error) throw Object.assign(new Error('invalid_skill'), { status: 400 })
    if (patch) await gateway.writeConfig(profile, patch)
    return { ok: true, via: 'config', name: skill, enabled }
  }

  async function hubSearch({ profile, query }) {
    if (!isProfileSlug(profile)) throw Object.assign(new Error('invalid_profile'), { status: 400 })
    const q = typeof query === 'string' ? query.trim().slice(0, 120) : ''
    if (!q) return { supported: true, results: [] }
    const response = await gateway.request('GET', `/api/skills/hub/search?${new URLSearchParams({ q, profile, source: 'all', limit: '20' })}`)
    if (missing(response.status)) return { supported: false, results: [] }
    if (response.status !== 200) return { supported: true, results: [], error: 'unavailable' }
    return { supported: true, results: hubResultsOf(response.body) }
  }

  async function hubInstall({ profile, identifier }) {
    if (!isProfileSlug(profile)) throw Object.assign(new Error('invalid_profile'), { status: 400 })
    const id = typeof identifier === 'string' ? identifier.trim().slice(0, 200) : ''
    if (!id || /[\u0000-\u001f]/.test(id)) throw Object.assign(new Error('invalid_skill'), { status: 400 })
    const response = await gateway.request('POST', `/api/skills/hub/install?${new URLSearchParams({ profile })}`, { identifier: id, profile })
    if (missing(response.status)) return { supported: false, ok: false }
    const detail = publicDetail(response.body?.detail || response.body?.error || response.body?.message || '')
    if (response.status !== 200 && response.status !== 202) return { supported: true, ok: false, detail }
    return { supported: true, ok: true, detail }
  }

  async function botSheet({ profile }) {
    if (!isProfileSlug(profile)) throw Object.assign(new Error('invalid_profile'), { status: 400 })
    let persona = ''
    let personaVia = 'file'
    const soul = await gateway.request('GET', `/api/profiles/${encodeURIComponent(profile)}/soul`)
    if (soul.status === 200 && typeof soul.body?.content === 'string') {
      persona = soul.body.content.slice(0, SOUL_MAX)
      personaVia = 'api'
    } else {
      const file = await readOk(gateway, profileSoulPath(profile))
      persona = file.ok ? file.text.slice(0, SOUL_MAX) : ''
    }
    let config = {}
    try { config = await gateway.readConfig(profile) } catch { config = {} }
    const model = modelOfConfig(config)
    const toolsets = await gateway.request('GET', `/api/tools/toolsets?${new URLSearchParams({ profile })}`)
    const listed = toolsets.status === 200 ? toolsetsOf(toolsets.body) : []
    return {
      persona,
      personaVia,
      model: model.model,
      provider: model.provider,
      toolsets: listed.length ? listed : toolsetsFromConfig(config),
      toolsetsSupported: toolsets.status === 200,
      toolsetsEditable: toolsets.status === 200,
    }
  }

  async function saveBotSheet({ profile, persona, model, provider, toolsets }) {
    if (!isProfileSlug(profile)) throw Object.assign(new Error('invalid_profile'), { status: 400 })
    const saved = {}
    if (typeof persona === 'string') {
      if (persona.length > SOUL_MAX) throw Object.assign(new Error('persona_too_large'), { status: 413 })
      const put = await gateway.request('PUT', `/api/profiles/${encodeURIComponent(profile)}/soul`, { content: persona })
      if (put.status === 200) saved.persona = 'api'
      else if (missing(put.status) || put.status === 400) {
        const wrote = await gateway.writeText(profileSoulPath(profile), persona)
        if (!wrote.ok) throw Object.assign(new Error('persona_unwritable'), { status: 502 })
        saved.persona = 'file'
      } else throw Object.assign(new Error('persona_unwritable'), { status: 502 })
    }
    if (typeof model === 'string' && model.trim()) {
      const providerName = typeof provider === 'string' ? provider.trim() : ''
      const body = { model: model.trim(), provider: providerName, profile }
      let via = ''
      if (providerName) {
        const put = await gateway.request('PUT', `/api/profiles/${encodeURIComponent(profile)}/model`, body)
        if (put.status === 200) via = 'profile'
        else if (!missing(put.status)) throw Object.assign(new Error('model_unwritable'), { status: 502 })
      }
      if (!via) {
        const post = await gateway.request('POST', `/api/model/set?${new URLSearchParams({ profile })}`, {
          scope: 'main', provider: providerName, model: model.trim(), profile,
        })
        if (post.status === 200) via = 'model-set'
        else if (!missing(post.status)) throw Object.assign(new Error('model_unwritable'), { status: 502 })
      }
      if (!via) {
        const config = await gateway.readConfig(profile)
        const patch = modelPatch(config, { model, provider: providerName })
        if (patch?.error) throw Object.assign(new Error('invalid_model'), { status: 400 })
        if (patch) await gateway.writeConfig(profile, patch)
        via = 'config'
      }
      saved.model = via
    }
    if (Array.isArray(toolsets)) {
      const results = []
      for (const item of toolsets.slice(0, 80)) {
        const name = typeof item?.name === 'string' ? item.name.trim() : ''
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name) || typeof item.enabled !== 'boolean') continue
        const put = await gateway.request('PUT', `/api/tools/toolsets/${encodeURIComponent(name)}?${new URLSearchParams({ profile })}`, { enabled: item.enabled, profile })
        results.push({ name, enabled: item.enabled, ok: put.status === 200 })
      }
      saved.toolsets = results
      if (results.some((item) => !item.ok)) saved.toolsetsPartial = true
    }
    return { ok: true, saved }
  }

  return {
    memoryView,
    memoryChange,
    publish: (profiles) => loadFacts().then((loaded) => publish(profiles, loaded.facts)),
    skills,
    skillFile,
    toggleSkill,
    hubSearch,
    hubInstall,
    botSheet,
    saveBotSheet,
  }
}
