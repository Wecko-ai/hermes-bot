import { describe, expect, it } from 'vitest'
import { HermesRpcError, type HermesClient } from './hermes'
import { canSendEdits, countAttentionDrafts, editsOf, EmailDraftsUnavailable, loadChatDrafts, parseEmailDraft, parseRules, sameConversation, sendDraft, splitAddresses } from './email-drafts'

const raw = {
  id: 'ed_0123456789abcdef', rev: 2, status: 'pending', from: 'contact@exemple.test', from_name: 'Alice', signature: '--\nAlice',
  to: ['sam@exemple.test'], cc: [], bcc: [], subject: 'Devis', body: 'Bonjour Sam', session_id: 's1', updated_at: 10,
  attachments: [{ path: '/w/devis.pdf', name: 'devis.pdf', size: 2048 }], in_reply_to: { subject: 'Re: Devis' },
}

function fakeClient(answer: (method: string, params: Record<string, unknown>) => unknown) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const client = { request: async (method: string, params: Record<string, unknown>) => { calls.push({ method, params }); return answer(method, params) } }
  return { client: client as unknown as HermesClient, calls }
}

describe('email drafts', () => {
  it('reads a draft and falls back to "needs approval" for unknown rules', () => {
    const draft = parseEmailDraft(raw)!
    expect(draft.attachments[0]).toEqual({ path: '/w/devis.pdf', name: 'devis.pdf', size: 2048 })
    expect(draft.inReplyTo).toBe('Re: Devis')
    expect(parseEmailDraft({ ...raw, id: '../x' })).toBeNull()
    expect(parseEmailDraft({ ...raw, status: 'weird' })).toBeNull()
    expect(parseRules({ mode: 'yolo', allowed: ['a@b.co', 3] })).toEqual({ mode: 'approval', allowed: ['a@b.co'] })
    expect(parseRules(undefined).mode).toBe('approval')
  })

  it('checks the edits before Send', () => {
    const edits = editsOf(parseEmailDraft(raw)!)
    expect(canSendEdits(edits)).toBe(true)
    expect(canSendEdits({ ...edits, to: 'pas-une-adresse' })).toBe(false)
    expect(canSendEdits({ ...edits, to: '' })).toBe(false)
    expect(canSendEdits({ ...edits, cc: 'Sam <sam@exemple.test>; x@y.io' })).toBe(true)
    expect(splitAddresses('a@b.co, c@d.io;')).toEqual(['a@b.co', 'c@d.io'])
  })

  it('lists the open chat plus the bot\'s waiting drafts, through the plugin RPC', async () => {
    const { client, calls } = fakeClient(() => ({
      ok: true,
      drafts: [
        raw,
        { ...raw, id: 'ed_ffffffffffffffff', session_id: 'other', status: 'pending', subject: 'From CLI' },
        { ...raw, id: 'ed_aaaaaaaaaaaaaaaa', session_id: 'other', status: 'sent', subject: 'Old', sent_at: 1, updated_at: 1 },
        { ...raw, id: 'ed_bbbbbbbbbbbbbbbb', session_id: 'agent:alice:local:dm:s1' },
      ],
      rules: { mode: 'approval', allowed: [] },
    }))
    const { drafts } = await loadChatDrafts(client, { profile: 'alice', sessionId: 's1' })
    expect(drafts.map((d) => d.id).sort()).toEqual(['ed_0123456789abcdef', 'ed_bbbbbbbbbbbbbbbb', 'ed_ffffffffffffffff'])
    expect(calls[0]).toEqual({ method: 'plugin.email-drafts.api', params: { op: 'list', profile: 'alice', session_id: 's1' } })
    expect(sameConversation('agent:orion:local:dm:s1', 's1')).toBe(true)
    expect(sameConversation('s1', 's2')).toBe(false)
    const counts = fakeClient(() => ({ ok: true, drafts: [raw, { ...raw, id: 'ed_ffffffffffffffff', status: 'sent' }], rules: { mode: 'approval', allowed: [] } }))
    expect(await countAttentionDrafts(counts.client, 'alice')).toBe(1)
    expect(counts.calls[0].params).toMatchObject({ op: 'list', profile: 'alice', session_id: '' })
  })

  it('says unavailable when the gateway does not know the plugin', async () => {
    const { client } = fakeClient(() => { throw new HermesRpcError('unknown', { reason: 'unknown_method' }, -32601) })
    await expect(loadChatDrafts(client, { profile: 'alice', sessionId: 's1' })).rejects.toBeInstanceOf(EmailDraftsUnavailable)
  })

  it('sends once with the revision shown and the edits, and returns a failed draft with its error', async () => {
    const { client, calls } = fakeClient(() => ({ ok: false, error: 'himalaya: auth failed', draft: { ...raw, status: 'failed', error: 'himalaya: auth failed' } }))
    const draft = parseEmailDraft(raw)!
    const result = await sendDraft(client, { profile: 'alice', sessionId: 's1' }, draft, { ...editsOf(draft), body: 'Bonjour Sam, voici.' })
    expect(calls).toHaveLength(1)
    expect(calls[0].params).toMatchObject({ op: 'send', id: draft.id, rev: 2, body: 'Bonjour Sam, voici.', to: ['sam@exemple.test'] })
    expect(result?.status).toBe('failed')
    expect(result?.error).toBe('himalaya: auth failed')
    const unchanged = fakeClient(() => ({ ok: true, draft: { ...raw, status: 'sent', sent_at: 20 } }))
    await sendDraft(unchanged.client, { profile: 'alice', sessionId: 's1' }, draft, editsOf(draft))
    expect(Object.keys(unchanged.calls[0].params).sort()).toEqual(['id', 'op', 'profile', 'rev', 'session_id'])
  })
})
