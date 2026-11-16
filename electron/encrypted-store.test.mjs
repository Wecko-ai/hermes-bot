import { describe, expect, it, vi } from 'vitest'
import store from './encrypted-store.cjs'

const { readEncrypted, writeEncrypted } = store

describe('encrypted store', () => {
  it('returns the missing value only when the file is absent', () => {
    const missing = Object.assign(new Error('no file'), { code: 'ENOENT' })
    const readFile = vi.fn(() => { throw missing })
    const decrypt = vi.fn()
    expect(readEncrypted('/tmp/sessions.bin', { readFile, decrypt, missing: '' })).toBe('')
    expect(readEncrypted('/tmp/local-chat.bin', { readFile, decrypt, missing: null })).toBeNull()
    expect(decrypt).not.toHaveBeenCalled()
  })

  it('throws when the file exists but cannot be decrypted or read', () => {
    const decrypt = vi.fn(() => { throw new Error('keychain locked') })
    expect(() => readEncrypted('/tmp/sessions.bin', {
      readFile: () => Buffer.from('ciphertext'),
      decrypt,
    })).toThrow('keychain locked')

    const denied = Object.assign(new Error('eacces'), { code: 'EACCES' })
    expect(() => readEncrypted('/tmp/credentials.bin', {
      readFile: () => { throw denied },
      decrypt: () => 'plain',
    })).toThrow(denied)
  })

  it('writes mode 0600 via a temp file', () => {
    const writeFile = vi.fn()
    const rename = vi.fn()
    const encrypt = vi.fn((json) => Buffer.from(json))
    writeEncrypted('/tmp/sessions.bin', '{"ok":true}', {
      writeFile, rename, encrypt, remove: vi.fn(),
    })
    expect(encrypt).toHaveBeenCalledWith('{"ok":true}')
    expect(writeFile).toHaveBeenCalledWith('/tmp/sessions.bin.tmp', Buffer.from('{"ok":true}'), { mode: 0o600 })
    expect(rename).toHaveBeenCalledWith('/tmp/sessions.bin.tmp', '/tmp/sessions.bin')
  })

  it('throws store_write_failed and drops the temp file when encrypt or rename fails', () => {
    const remove = vi.fn()
    expect(() => writeEncrypted('/tmp/sessions.bin', 'plain', {
      writeFile: vi.fn(),
      rename: vi.fn(),
      encrypt: () => { throw new Error('keychain says secret-token') },
      remove,
    })).toThrow(expect.objectContaining({ message: 'store_write_failed' }))
    expect(remove).toHaveBeenCalledWith('/tmp/sessions.bin.tmp')

    try {
      writeEncrypted('/tmp/sessions.bin', 'plain', {
        writeFile: vi.fn(),
        rename: () => { throw new Error('keychain says secret-token') },
        encrypt: (json) => json,
        remove: () => { throw new Error('temp already gone') },
      })
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect(error.message).toBe('store_write_failed')
      expect(error.message).not.toContain('secret-token')
      return
    }
    throw new Error('write should have thrown')
  })
})
