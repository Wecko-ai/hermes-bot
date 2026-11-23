import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { listSkillsCatalog, parseSkillFrontmatter, skillHubCliCommand, skillToggleBody } from './skills-catalog.mjs'

describe('skills catalog', () => {
  it('lit le frontmatter d’un SKILL.md', () => {
    const meta = parseSkillFrontmatter(`---\nname: mail-approval\ndescription: Approve outbound mail\n---\n\nBody.`)
    expect(meta).toMatchObject({ name: 'mail-approval', description: 'Approve outbound mail', body: 'Body.' })
  })

  it('liste les skills partagées et de profil', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'hb-skills-'))
    const home = path.join(root, 'home')
    mkdirSync(path.join(home, 'skills', 'web', 'coffre-chrome'), { recursive: true })
    writeFileSync(path.join(home, 'skills', 'web', 'coffre-chrome', 'SKILL.md'), '---\nname: browser-vault\ndescription: Shared vault\n---\n')
    mkdirSync(path.join(home, 'profiles', 'nova', 'skills', 'local'), { recursive: true })
    writeFileSync(path.join(home, 'profiles', 'nova', 'skills', 'local', 'SKILL.md'), '---\nname: local-only\ndescription: Profile skill\n---\n')
    const catalog = await listSkillsCatalog({ hermesHome: home, repoSkillsDir: '', profile: 'nova' })
    expect(catalog.shared[0].id).toBe('web/coffre-chrome')
    expect(catalog.profile[0].name).toBe('local-only')
  })

  it('construit le corps pour activer ou désactiver une skill', () => {
    expect(skillToggleBody({ disabled: ['a'], skillId: 'a', enabled: true })).toEqual({ config: { skills: { disabled: [] } } })
    expect(skillToggleBody({ disabled: [], skillId: 'b', enabled: false })).toEqual({ config: { skills: { disabled: ['b'] } } })
  })

  it('donne la commande CLI du hub', () => {
    expect(skillHubCliCommand('web/coffre-chrome')).toBe('hermes skills install web/coffre-chrome')
    expect(skillHubCliCommand('../escape')).toBe('')
  })
})