import fs from 'node:fs'
import path from 'node:path'

const MAX_SECTIONS = 64
const MAX_BOTS_PER_SECTION = 200
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/

export function normalizeUiLayout(raw) {
  const sectionOrder = Array.isArray(raw?.sectionOrder)
    ? raw.sectionOrder.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()).slice(0, MAX_SECTIONS)
    : []
  const rosterOrder = {}
  if (raw?.rosterOrder && typeof raw.rosterOrder === 'object' && !Array.isArray(raw.rosterOrder)) {
    for (const [key, list] of Object.entries(raw.rosterOrder)) {
      if (typeof key !== 'string' || !key.trim() || !Array.isArray(list)) continue
      const slugs = list.filter((item) => typeof item === 'string' && SLUG.test(item)).slice(0, MAX_BOTS_PER_SECTION)
      if (slugs.length) rosterOrder[key.trim()] = slugs
    }
  }
  return { sectionOrder, rosterOrder }
}

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

export function loadUiLayout(configPath) {
  const file = path.join(configPath, 'config.json')
  const config = readJson(file)
  const ui = config.ui && typeof config.ui === 'object' ? config.ui : {}
  return normalizeUiLayout({ sectionOrder: ui.sectionOrder, rosterOrder: ui.rosterOrder })
}

export function saveUiLayout(configPath, layout) {
  const file = path.join(configPath, 'config.json')
  const config = readJson(file)
  const next = normalizeUiLayout(layout)
  config.ui = { ...(config.ui && typeof config.ui === 'object' ? config.ui : {}), sectionOrder: next.sectionOrder, rosterOrder: next.rosterOrder }
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`)
  return next
}