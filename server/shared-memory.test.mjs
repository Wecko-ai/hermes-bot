import { describe, expect, it } from 'vitest'
import {
  MEMORY_CHAR_LIMIT, SHARED_MARKER, TYPE_FILES,
  addFact, digestLine, externalDirPatch, forgetFact, hindsightSummary, makeFact, parseTypeFile,
  privateEntries, readProviderName, renderTypeFile, skillDocument, skillNeedsWrite, updateFact,
  upsertSharedEntry,
} from './shared-memory.mjs'
import { disabledSkillsPatch, modelPatch, normalizeSkill, publicDetail, scanSkillFiles } from './skills-catalog.mjs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const now = new Date('2026-11-22T10:00:00.000Z')

describe('shared memory files', () => {
  it('round-trips a fact and keeps a bullet a bot appended', () => {
    const added = addFact([], { type: 'user', text: 'Prefers short answers.', learnedBy: 'orion' }, now, () => 'abc123')
    expect(added.fact).toMatchObject({ type: 'user', learnedBy: 'orion', text: 'Prefers short answers.' })
    const file = `${renderTypeFile('user', added.facts)}\n- Ships on Tuesdays\n`
    const parsed = parseTypeFile('user', file, { now, random: () => 'zzz999' })
    expect(parsed).toHaveLength(2)
    expect(parsed[0]).toMatchObject({ id: added.fact.id, learnedBy: 'orion' })
    expect(parsed[1]).toMatchObject({ learnedBy: 'unknown', text: 'Ships on Tuesdays' })
    expect(renderTypeFile('people', [])).toContain(TYPE_FILES.people.split('/').pop() ? 'People and organizations' : '')
  })

  it('refuses an empty fact and drops one that was forgotten', () => {
    expect(makeFact({ id: 'fabc1', type: 'user', text: '   ' }, now)).toBeNull()
    const added = addFact([], { type: 'behavior', text: 'Confirm before sending mail.', learnedBy: 'user' }, now, () => 'abc123')
    expect(forgetFact(added.facts, 'missing').error).toBe('not_found')
    expect(forgetFact(added.facts, added.fact.id).facts).toEqual([])
    const edited = updateFact(added.facts, { id: added.fact.id, text: 'Confirm before sending mail or chat.' }, now)
    expect(edited.fact.text).toContain('chat')
  })

  it('injects a marked entry and leaves the profile notes in place', () => {
    const facts = addFact([], { type: 'workstream', text: 'Launch notes live in the launch folder.', learnedBy: 'nova' }, now, () => 'abc123').facts
    const next = upsertSharedEntry('The staging host uses port 2222.\n', facts)
    expect(next.mode).toBe('digest')
    expect(next.text).toContain('port 2222')
    expect(next.text).toContain(SHARED_MARKER)
    expect(next.text).toContain('Launch notes')
    const again = upsertSharedEntry(next.text, facts)
    expect(again.mode).toBe('same')
    expect(splitCount(again.text)).toBe(2)
  })

  it('keeps a one-line pointer when the profile memory is almost full', () => {
    const facts = addFact([], { type: 'user', text: 'x'.repeat(200), learnedBy: 'user' }, now, () => 'abc123').facts
    const stuffed = `${'a'.repeat(MEMORY_CHAR_LIMIT - 80)}\n`
    const next = upsertSharedEntry(stuffed, facts)
    expect(next.mode === 'pointer' || next.mode === 'unchanged').toBe(true)
    if (next.mode === 'pointer') {
      expect(next.text.length).toBeLessThanOrEqual(MEMORY_CHAR_LIMIT + 1)
      expect(next.text).toContain(SHARED_MARKER)
      expect(next.text).not.toContain('x'.repeat(200))
    }
  })

  it('does not treat the shared entry as something a single bot learned', () => {
    const text = `Own note\n\n§\n\n${digestLine([])}\n`
    expect(privateEntries(text, 'orion', 'memory')).toEqual([{ profile: 'orion', store: 'memory', text: 'Own note' }])
  })

  it('adds the shared skill directory without dropping other skill settings', () => {
    const patch = externalDirPatch({ skills: { disabled: ['mail-approval'], external_dirs: ['~/extra'] } })
    expect(patch.config.skills.disabled).toEqual(['mail-approval'])
    expect(patch.config.skills.external_dirs).toEqual(['~/extra', '~/.hermes/shared-memory/skill'])
    expect(externalDirPatch(patch.config)).toBeNull()
  })

  it('reports Hindsight without returning a secret', () => {
    expect(hindsightSummary('{"bank_id":"team","api_key":"super-secret-value"}')).toEqual({ bank: 'team' })
    expect(hindsightSummary('{"api_key":"only"}')).toEqual({ bank: '' })
    expect(readProviderName({ provider: 'hindsight' })).toBe('hindsight')
    expect(readProviderName({ active: { name: 'builtin' } })).toBe('builtin')
    expect(readProviderName({ provider: 'not a name' })).toBe('')
  })

  it('writes the skill once', () => {
    expect(skillNeedsWrite('')).toBe(true)
    expect(skillNeedsWrite(skillDocument())).toBe(false)
    expect(skillDocument()).toContain('name: hermesbot-shared-memory')
    expect(skillDocument()).toContain('~/.hermes/shared-memory/user-profile.md')
  })
})

describe('skills and profile config', () => {
  it('disables one skill and keeps the rest of the skills config', () => {
    const patch = disabledSkillsPatch({ skills: { external_dirs: ['~/extra'], disabled: ['alpha'] } }, 'beta', false)
    expect(patch.config.skills.external_dirs).toEqual(['~/extra'])
    expect(patch.config.skills.disabled).toEqual(['alpha', 'beta'])
    expect(disabledSkillsPatch(patch.config, 'beta', false)).toBeNull()
    expect(disabledSkillsPatch(patch.config, 'beta', true).config.skills.disabled).toEqual(['alpha'])
  })

  it('reads a skill from frontmatter and ignores a path that climbs out', () => {
    const skill = normalizeSkill({
      name: 'mail-approval',
      description: 'Approve mail',
      path: '~/.hermes/skills/email/mail-approval/SKILL.md',
      enabled: false,
    }, { profile: 'orion' })
    expect(skill).toMatchObject({ name: 'mail-approval', scope: 'shared', enabled: false })
    expect(normalizeSkill({ name: 'local', path: '~/.hermes/profiles/orion/skills/local/SKILL.md' }, { profile: 'orion' }).scope).toBe('profile')
    expect(normalizeSkill({ name: 'local', path: '~/.hermes/skills/../../etc/passwd' }, { profile: 'orion' }).path).toBe('')
    expect(normalizeSkill({ name: '../etc', path: '~/.hermes/skills/local/SKILL.md' }, { profile: 'orion' })).toBeNull()
  })

  it('sets the default model without dropping the other model keys', () => {
    const patch = modelPatch({ model: { default: 'old', provider: 'anthropic', base_url: 'http://127.0.0.1:9' } }, { model: 'claude-sonnet', provider: 'anthropic' })
    expect(patch.config.model).toMatchObject({ default: 'claude-sonnet', provider: 'anthropic', base_url: 'http://127.0.0.1:9' })
    expect(modelPatch(patch.config, { model: 'claude-sonnet', provider: 'anthropic' })).toBeNull()
  })

  it('scans the shared library and one profile', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hermesbot-skills-'))
    try {
      await mkdir(path.join(root, 'skills', 'mail'), { recursive: true })
      await mkdir(path.join(root, 'profiles', 'orion', 'skills', 'drafts'), { recursive: true })
      await writeFile(path.join(root, 'skills', 'mail', 'SKILL.md'), '---\nname: mail-approval\ndescription: Approve an email draft\n---\n\nSend only what was approved.\n')
      await writeFile(path.join(root, 'profiles', 'orion', 'skills', 'drafts', 'SKILL.md'), '---\nname: drafts\ndescription: Drafts for Orion\n---\n')
      const { readdir, readFile: read } = await import('node:fs/promises')
      const found = await scanSkillFiles(root, 'orion', {
        readdir: (dir) => readdir(dir, { withFileTypes: true }),
        readFile: (file) => read(file, 'utf8'),
        join: path.join,
      })
      expect(found.map((file) => file.text).join('\n')).toContain('mail-approval')
      expect(found.map((file) => file.text).join('\n')).toContain('drafts')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('shortens a hub error so a token cannot ride along', () => {
    expect(publicDetail('failed abcdefghijklmnopqrstuvwxyz0123456789 more')).not.toContain('abcdefghijklmnopqrstuvwxyz')
  })
})

function splitCount(text) {
  return text.split(/\n[ \t]*§[ \t]*\n/).length
}
