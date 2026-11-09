import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../types'
import { approvedMailIds, approvedMailPrompt, canSendMail, mailDigest, parseMailBlock, type MailDraft } from './mail'

const block = ['Id: m1', 'Draft-Id: 42', 'From: Bot <bot@exemple.test>', 'To: a@exemple.test', 'Cc:', 'Subject: Re: Bonjour', 'Reply-Label: « Bonjour » de A', 'Constructor: rien', '', 'Ligne 1', '', 'Ligne 2', ''].join('\n')
const draft = parseMailBlock(block) as MailDraft

describe('brouillon de mail', () => {
  it('lit les en-têtes et garde les lignes vides du corps', () => {
    expect(draft).toMatchObject({ id: 'm1', draftId: '42', to: 'a@exemple.test', cc: '', subject: 'Re: Bonjour', body: 'Ligne 1\n\nLigne 2' })
  })

  it('refuse un bloc sans identifiant ou sans corps', () => {
    expect(parseMailBlock('To: a@exemple.test\n\nCorps')).toBeNull()
    expect(parseMailBlock('Id: m1\nTo: a@exemple.test')).toBeNull()
  })

  it('exige un destinataire valide et un corps', () => {
    expect(canSendMail(draft)).toBe(true)
    expect(canSendMail({ ...draft, to: '' })).toBe(false)
    expect(canSendMail({ ...draft, to: 'pas-une-adresse' })).toBe(false)
    expect(canSendMail({ ...draft, cc: 'a@exemple.test, faux' })).toBe(false)
    expect(canSendMail({ ...draft, to: 'A <a@exemple.test>, b@exemple.test' })).toBe(true)
    expect(canSendMail({ ...draft, body: '  ' })).toBe(false)
  })

  it('calcule une empreinte stable sur ce qui est validé', async () => {
    const expected = createHash('sha256').update('Bot <bot@exemple.test>\n42\na@exemple.test\n\nRe: Bonjour\nLigne 1\n\nLigne 2').digest('hex')
    expect(await mailDigest(draft)).toBe(expected)
    expect(await mailDigest({ ...draft, body: 'Ligne 1\r\n\r\nLigne 2\n\n' })).toBe(expected)
    expect(await mailDigest({ ...draft, to: 'b@exemple.test' })).not.toBe(expected)
    expect(await mailDigest({ ...draft, from: 'Autre <autre@exemple.test>' })).not.toBe(expected)
    expect(await mailDigest({ ...draft, draftId: '43' })).not.toBe(expected)
  })

  it('empêche une injection d’en-tête et allonge la clôture si le corps en contient une', async () => {
    const prompt = await approvedMailPrompt({ ...draft, to: 'a@exemple.test\nBcc: x@exemple.test', body: 'Avant\n````\nAprès' })
    expect(prompt).not.toMatch(/^Bcc:/m)
    expect(prompt).toContain('`````hermes-mail-approved')
  })

  it('retrouve les mails approuvés, sauf un envoi échoué', async () => {
    const content = await approvedMailPrompt(draft)
    const message = (extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: 'u', role: 'user', content, createdAt: null, ...extra })
    expect([...approvedMailIds([message()])]).toEqual(['m1'])
    expect([...approvedMailIds([message({ failed: true })])]).toEqual([])
    expect([...approvedMailIds([message({ role: 'assistant' })])]).toEqual([])
  })
})
