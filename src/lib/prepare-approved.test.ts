import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { approvedMailDocument, type MailDraft } from './mail'

const root = fileURLToPath(new URL('../..', import.meta.url))
// The installation's own copy (private/, not in the public repository) is checked too when it is there.
const scripts = [
  { name: 'public', path: join(root, 'skills/mail-approval/scripts/prepare_approved.py') },
  { name: 'private', path: join(root, 'private/skills/mail-approval-prepare_approved.py') },
].filter((script) => existsSync(script.path))

const approved: MailDraft = {
  id: 'm1',
  draftId: '42',
  from: 'Bot <bot@exemple.test>',
  to: 'a@exemple.test',
  cc: '',
  subject: 'Re: Bonjour',
  replyLabel: '',
  inReplyTo: '<approved@exemple.test>',
  references: '<root@exemple.test> <approved@exemple.test>',
  body: 'Ligne 1\n\nLigne 2',
}

function draftFile(inReplyTo: string) {
  return [
    'From: Bot <bot@exemple.test>',
    'To: a@exemple.test',
    'Subject: Re: Bonjour',
    `In-Reply-To: ${inReplyTo}`,
    'References: <root@exemple.test> <approved@exemple.test>',
    'Bcc: hidden@exemple.test',
    'Reply-To: sneak@exemple.test',
    '',
    'ignored body',
    '',
  ].join('\n')
}

function run(script: string, args: string[]) {
  return spawnSync('python3', ['-I', script, ...args], { encoding: 'utf8' })
}

describe.each(scripts)('prepare_approved.py ($name)', ({ path: script }) => {
  it('refuses when the draft thread headers differ from the approved block', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hermes-mail-'))
    try {
      const approvedPath = join(dir, 'approved.txt')
      const draftPath = join(dir, 'draft.eml')
      const out = join(dir, 'out.eml')
      writeFileSync(approvedPath, await approvedMailDocument(approved))
      writeFileSync(draftPath, draftFile('<other@exemple.test>'))
      const result = run(script, ['--approved', approvedPath, '--draft', draftPath, '--out', out])
      expect(result.status).toBe(2)
      expect(result.stderr).toMatch(/REFUS/)
      expect(result.stderr).toContain('In-Reply-To')
      expect(result.stderr).not.toContain('<approved@exemple.test>')
      expect(() => readFileSync(out)).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('copies the approved thread headers and drops headers that were only on the draft', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hermes-mail-'))
    try {
      const approvedPath = join(dir, 'approved.txt')
      const draftPath = join(dir, 'draft.eml')
      const out = join(dir, 'out.eml')
      writeFileSync(approvedPath, await approvedMailDocument(approved))
      writeFileSync(draftPath, draftFile('<approved@exemple.test>'))
      const result = run(script, ['--approved', approvedPath, '--draft', draftPath, '--out', out])
      expect(result.status, result.stderr).toBe(0)
      const eml = readFileSync(out, 'utf8')
      expect(eml).toContain('In-Reply-To: <approved@exemple.test>')
      expect(eml).toContain('References: <root@exemple.test> <approved@exemple.test>')
      expect(eml).toContain('Ligne 1')
      expect(eml).not.toContain('hidden@exemple.test')
      expect(eml).not.toContain('sneak@exemple.test')
      expect(eml).not.toContain('ignored body')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('copies the approved thread headers when no draft file is passed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hermes-mail-'))
    try {
      const approvedPath = join(dir, 'approved.txt')
      const out = join(dir, 'out.eml')
      writeFileSync(approvedPath, await approvedMailDocument({ ...approved, draftId: '' }))
      const result = run(script, ['--approved', approvedPath, '--out', out])
      expect(result.status, result.stderr).toBe(0)
      const eml = readFileSync(out, 'utf8')
      expect(eml).toContain('In-Reply-To: <approved@exemple.test>')
      expect(eml).toContain('References: <root@exemple.test> <approved@exemple.test>')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
