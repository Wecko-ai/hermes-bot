import { describe, expect, it } from 'vitest'
import { WalletStore } from './wallet.mjs'

describe('wallet store', () => {
  it('stocke une carte sans renvoyer le numéro complet', async () => {
    const store = new WalletStore().useMemory()
    const saved = await store.saveCard({
      holder: 'Alex Martin',
      number: '4111 1111 1111 4242',
      expiry: '12/30',
      label: 'Test card',
      bots: ['orion'],
    })
    expect(saved.last4).toBe('4242')
    expect(saved.ref).toBe(`hbvault:card:${saved.id}`)
    const listed = await store.list('orion')
    expect(listed[0]).toMatchObject({ last4: '4242', type: 'card' })
    expect(JSON.stringify(listed)).not.toContain('4242".{"secret')
    expect(JSON.stringify(listed)).not.toContain('4111')
  })

  it('enregistre une adresse et un formulaire sécurisé', async () => {
    const store = new WalletStore().useMemory()
    const address = await store.saveAddress({
      label: 'Home',
      line1: '1 Main St',
      city: 'Paris',
      postal: '75001',
      country: 'FR',
      bots: ['*'],
    })
    expect(address.ref).toMatch(/^hbvault:address:/)
    const refs = await store.storeSecureForm([
      { key: 'card', kind: 'card', value: '4000 0000 0000 0002', expiry: '01/28', holder: 'A', label: 'Pay' },
    ], ['nova'])
    expect(refs[0].last4).toBe('0002')
    expect(refs[0].ref).toMatch(/^hbvault:card:/)
  })
})