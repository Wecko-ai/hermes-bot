// Bot profile sheet: SOUL text, toolsets and ui_meta card. Only whitelisted keys go to Hermes.

import path from 'node:path'

export const PROFILE_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/
export const SOUL_MAX_BYTES = 96 * 1024
export const TEMPLATE_MAX_BYTES = 256 * 1024

const SECRET_KEY = /(password|secret|token|api[_-]?key|private[_-]?key|credential|auth)/i
const SECRET_VALUE = /^sk-[A-Za-z0-9]{8,}$|^[A-Za-z0-9+/]{32,}={0,2}$/

export function soulPath(slug) {
  return `~/.hermes/profiles/${slug}/SOUL.md`
}

export function sanitizeExport(value, depth = 0) {
  if (depth > 8) return '[truncated]'
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    if (SECRET_VALUE.test(value.trim())) return '[redacted]'
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => sanitizeExport(item, depth + 1))
  if (typeof value === 'object') {
    const out = {}
    for (const [key, entry] of Object.entries(value).slice(0, 200)) {
      if (SECRET_KEY.test(key)) out[key] = '[redacted]'
      else out[key] = sanitizeExport(entry, depth + 1)
    }
    return out
  }
  return String(value)
}

export function exportTemplate({ slug, soul, config, card }) {
  return {
    version: 1,
    profile: slug,
    exported_at: new Date().toISOString(),
    soul: String(soul || ''),
    config: sanitizeExport({
      model: config?.model,
      toolsets: config?.toolsets,
      skills: config?.skills,
    }),
    card: sanitizeExport(card || {}),
  }
}

export function importTemplateBody(template) {
  if (!template || typeof template !== 'object') return null
  const soul = typeof template.soul === 'string' ? template.soul.slice(0, SOUL_MAX_BYTES) : ''
  const config = template.config && typeof template.config === 'object' ? template.config : {}
  const toolsets = config.toolsets && typeof config.toolsets === 'object' ? config.toolsets : undefined
  const skills = config.skills && typeof config.skills === 'object' ? config.skills : undefined
  const out = { config: {} }
  if (toolsets) out.config.toolsets = sanitizeExport(toolsets)
  if (skills) out.config.skills = sanitizeExport(skills)
  if (config.model && typeof config.model === 'object') {
    out.config.model = sanitizeExport(config.model)
  }
  return { soul, configBody: out }
}

export function toolsetsFromConfig(config) {
  const source = config && typeof config === 'object' ? config : {}
  const raw = source.toolsets && typeof source.toolsets === 'object' ? source.toolsets : {}
  const enabled = Array.isArray(raw.enabled) ? raw.enabled.filter((item) => typeof item === 'string') : []
  const disabled = Array.isArray(raw.disabled) ? raw.disabled.filter((item) => typeof item === 'string') : []
  return { enabled, disabled }
}

export function toolsetsBody({ enabled, disabled }) {
  const clean = (list) => [...new Set(list.filter((item) => typeof item === 'string' && item.length > 0 && item.length < 80))].slice(0, 64)
  return { config: { toolsets: { enabled: clean(enabled || []), disabled: clean(disabled || []) } } }
}

export function modelFromConfig(config) {
  const model = config?.model && typeof config.model === 'object' ? config.model : {}
  const provider = typeof model.provider === 'string' ? model.provider : ''
  const name = typeof model.default === 'string' ? model.default : ''
  return { provider, default: name, label: provider && name ? `${provider}/${name}` : name || provider }
}

export function diffLines(before, after) {
  const left = String(before || '').split('\n')
  const right = String(after || '').split('\n')
  const max = Math.max(left.length, right.length)
  const lines = []
  for (let i = 0; i < max; i += 1) {
    const a = left[i], b = right[i]
    if (a === b) lines.push({ kind: 'same', text: a ?? '' })
    else {
      if (a !== undefined) lines.push({ kind: 'remove', text: a })
      if (b !== undefined) lines.push({ kind: 'add', text: b })
    }
  }
  return lines
}

export function repoSkillsDir(root) {
  return path.join(root, 'skills')
}