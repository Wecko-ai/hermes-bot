// Read-only skills catalog: shared hub under HERMES_HOME and per-profile skill folders.

import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/
const NAME_RE = /^name:\s*(.+)$/m
const DESC_RE = /^description:\s*(.+)$/m

export function parseSkillFrontmatter(text) {
  const source = String(text || '')
  const match = source.match(FRONTMATTER)
  if (!match) return { name: '', description: '', body: source.trim() }
  const block = match[1]
  const name = (block.match(NAME_RE)?.[1] || '').trim().replace(/^['"]|['"]$/g, '')
  const description = (block.match(DESC_RE)?.[1] || '').trim().replace(/^['"]|['"]$/g, '')
  return { name, description, body: source.slice(match[0].length).trim() }
}

async function walkSkills(root, scope, shared, prefix = '') {
  const entries = []
  let listing
  try {
    listing = await readdir(root, { withFileTypes: true })
  } catch {
    return entries
  }
  for (const item of listing) {
    if (!item.isDirectory()) continue
    const skillRoot = path.join(root, item.name)
    const skillFile = path.join(skillRoot, 'SKILL.md')
    try {
      const info = await stat(skillFile)
      if (!info.isFile()) continue
      const text = await readFile(skillFile, 'utf8')
      const meta = parseSkillFrontmatter(text)
      const id = prefix ? `${prefix}/${item.name}` : item.name
      entries.push({
        id,
        folder: item.name,
        scope,
        shared,
        name: meta.name || item.name,
        description: meta.description,
        path: skillFile,
      })
    } catch {
      const nested = await walkSkills(skillRoot, scope, shared, prefix ? `${prefix}/${item.name}` : item.name)
      entries.push(...nested)
    }
  }
  return entries
}

export async function listSkillsCatalog({ hermesHome, repoSkillsDir, profile }) {
  const sharedDirs = [
    path.join(hermesHome, 'skills'),
    repoSkillsDir,
  ].filter(Boolean)
  const shared = []
  for (const dir of sharedDirs) {
    shared.push(...await walkSkills(dir, 'shared', true))
  }
  const seen = new Set()
  const dedupedShared = shared.filter((item) => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
  const profileSkills = profile ? await walkSkills(path.join(hermesHome, 'profiles', profile, 'skills'), 'profile', false) : []
  return { shared: dedupedShared, profile: profileSkills }
}

/** Hub install command when no HTTP hub route is available through the gateway. */
export function skillHubCliCommand(skillId) {
  const clean = String(skillId || '').trim().replace(/[^\w./-]/g, '')
  if (!clean || clean.includes('..')) return ''
  return `hermes skills install ${clean}`
}

export function skillToggleBody({ disabled, skillId, enabled }) {
  const list = Array.isArray(disabled) ? [...disabled] : []
  const id = String(skillId || '').trim()
  if (!id) return null
  const index = list.indexOf(id)
  if (enabled && index >= 0) list.splice(index, 1)
  if (!enabled && index < 0) list.push(id)
  return { config: { skills: { disabled: list.slice(0, 500) } } }
}