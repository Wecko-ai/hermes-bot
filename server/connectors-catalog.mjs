import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const NAME = /^name:\s*([A-Za-z0-9_.-]+)/m
const DESCRIPTION = /^description:\s*(.+)$/m
const AUTH_TYPE = /auth:\s*\n(?:[^\n]+\n)*?\s+type:\s*(\w+)/m
const ENV_NAMES = /^\s+-\s+name:\s*([A-Za-z0-9_]+)/gm

function stripQuotes(value) {
  const text = value.trim()
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) {
    return text.slice(1, -1)
  }
  return text
}

function parseManifest(text) {
  const name = text.match(NAME)?.[1]
  if (!name) return null
  const description = stripQuotes(text.match(DESCRIPTION)?.[1] || name)
  const auth = text.match(AUTH_TYPE)?.[1] || 'none'
  const requires = [...text.matchAll(ENV_NAMES)].map((match) => match[1])
  return { name, description, auth, requires }
}

export async function loadConnectorsCatalog(catalogDir) {
  let entries
  try {
    entries = await readdir(catalogDir, { withFileTypes: true })
  } catch {
    return []
  }
  const servers = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const manifestPath = path.join(catalogDir, entry.name, 'manifest.yaml')
    try {
      const info = await stat(manifestPath)
      if (!info.isFile()) continue
      const parsed = parseManifest(await readFile(manifestPath, 'utf8'))
      if (parsed) servers.push(parsed)
    } catch { /* skip unreadable manifests */ }
  }
  return servers.sort((left, right) => left.name.localeCompare(right.name))
}