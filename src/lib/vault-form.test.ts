import { describe, expect, it } from 'vitest'
import { parseVaultFormBlocks, vaultFormAcknowledgement } from './vault-form'

describe('vault form block', () => {
  it('parse le bloc documenté', () => {
    const blocks = parseVaultFormBlocks('```hermes-vault-form\nid: billing\ntitle: Billing\n- key: card kind: card label: Card\n```')
    expect(blocks).toEqual([{ id: 'billing', title: 'Billing', fields: [{ key: 'card', kind: 'card', label: 'Card', optional: false }] }])
    expect(vaultFormAcknowledgement('Billing', [{ ref: 'hbvault:card:x' }])).toContain('hbvault:card:x')
    expect(vaultFormAcknowledgement('Billing', [{ ref: 'hbvault:card:x' }])).not.toContain('4111')
  })
})