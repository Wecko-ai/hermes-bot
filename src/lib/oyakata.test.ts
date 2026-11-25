import { describe, expect, it } from 'vitest'
import { HermesRpcError, type HermesClient } from './hermes'
import { OYAKATA_GET_METHOD, OYAKATA_MODEL_SENTINEL, OYAKATA_SET_METHOD, loadOyakata, oyakataChip, oyakataMigrationTarget, isOyakataModel, setOyakata } from './oyakata'
import { composerChipText } from './turn-model'
import { modelLabel } from './model'
import { pickerModelForSession } from './auto-router'

describe('Delegate mode (formerly Oyakata, formerly Chef Qwen)', () => {
  it('recognizes the sentinel and its legacy Chef Qwen aliases only', () => {
    expect(OYAKATA_MODEL_SENTINEL).toBe('hermesbot:oyakata')
    expect(isOyakataModel(OYAKATA_MODEL_SENTINEL)).toBe(true)
    expect(isOyakataModel('hermesbot/oyakata')).toBe(true)
    expect(isOyakataModel('hermesbot:chef-qwen')).toBe(true)
    expect(isOyakataModel('hermesbot/chef-qwen')).toBe(true)
    expect(isOyakataModel('hermesbot:auto')).toBe(false)
    expect(isOyakataModel('mlx-community--Qwen3.8-27B-4bit')).toBe(false)
  })

  it('labels the sentinel and the legacy id « Delegate »', () => {
    expect(modelLabel(OYAKATA_MODEL_SENTINEL)).toBe('Delegate')
    expect(modelLabel('hermesbot:chef-qwen')).toBe('Delegate')
  })

  it('chip shows the mode and the real chef model', () => {
    const chip = composerChipText({ answered: null, chatModel: OYAKATA_MODEL_SENTINEL, fallbackMark: '(secours)', chefLabel: 'Delegate' })
    expect(chip).toMatch(/^Delegate · /)
    expect(chip).toMatch(/Cursor/)
    expect(composerChipText({ answered: null, chatModel: 'hermesbot:chef-qwen', fallbackMark: '(secours)' })).toMatch(/^Delegate · /)
    expect(oyakataChip('Delegate', '')).toBe('Delegate')
  })

  it('a session already on the Delegate sentinel (or legacy Chef Qwen) reopens on it even when Auto is the default', () => {
    expect(pickerModelForSession(undefined, OYAKATA_MODEL_SENTINEL, { useAutoModel: true }, true)).toBe(OYAKATA_MODEL_SENTINEL)
    expect(pickerModelForSession(undefined, 'hermesbot:chef-qwen', { useAutoModel: true }, true)).toBe('hermesbot:chef-qwen')
    // An explicit Auto pick made after it wins (the gateway session is switched on the next send).
    expect(pickerModelForSession('hermesbot:auto', OYAKATA_MODEL_SENTINEL, { useAutoModel: true }, true)).toBe('hermesbot:auto')
    expect(pickerModelForSession(undefined, 'cursor/grok-4.7', { useAutoModel: true }, true)).toBe('hermesbot:auto')
  })

  it('the toggle goes through the chef-worker plugin RPC, per conversation', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const client = { request: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      return { session_id: params.session_id, enabled: method === OYAKATA_SET_METHOD ? params.enabled : false, worker: { model: 'Inkling-2-Mini-128K', label: 'Inkling 2 Mini Splash' }, default_chef: 'cursor/grok-4.7' }
    } } as unknown as HermesClient
    const target = { profile: 'orion', sessionId: 's1' }
    expect(await loadOyakata(client, target)).toEqual({ available: true, enabled: false, workerLabel: 'Inkling 2 Mini Splash', defaultChef: 'cursor/grok-4.7' })
    expect((await setOyakata(client, target, true)).enabled).toBe(true)
    expect(calls).toEqual([
      { method: OYAKATA_GET_METHOD, params: { profile: 'orion', session_id: 's1' } },
      { method: OYAKATA_SET_METHOD, params: { profile: 'orion', session_id: 's1', enabled: true } },
    ])
  })

  it('a bot without the plugin shows the toggle unavailable, other errors surface', async () => {
    const missing = { request: async () => { throw new HermesRpcError('unknown method', { reason: 'unknown_method' }, -32601) } } as unknown as HermesClient
    expect((await loadOyakata(missing, { profile: 'a', sessionId: 's' })).available).toBe(false)
    const broken = { request: async () => { throw new HermesRpcError('boom', { reason: 'plugin_rpc_failed' }, 5000) } } as unknown as HermesClient
    await expect(loadOyakata(broken, { profile: 'a', sessionId: 's' })).rejects.toThrow('boom')
  })

  it('Delegate is no longer a model: an old pick migrates to the bot default model', () => {
    expect(oyakataMigrationTarget({ model: 'kimi-for-coding', provider: 'kimi-coding' })).toEqual({ model: 'kimi-for-coding', provider: 'kimi-coding', providerName: '' })
    expect(oyakataMigrationTarget({ model: OYAKATA_MODEL_SENTINEL })).toBeNull()
    expect(oyakataMigrationTarget({ model: '' })).toBeNull()
  })
})
