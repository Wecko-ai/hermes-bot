import { describe, expect, it } from 'vitest'
import { HermesRpcError, type HermesClient } from './hermes'
import { DELEGATE_GET_METHOD, DELEGATE_MODEL_SENTINEL, DELEGATE_SET_METHOD, loadDelegate, delegateChip, delegateMigrationTarget, isDelegateModel, setDelegate } from './delegate'
import { composerChipText } from './turn-model'
import { modelLabel } from './model'
import { pickerModelForSession } from './auto-router'

describe('Delegate mode', () => {
  it('recognizes the sentinel and its former ids only', () => {
    expect(DELEGATE_MODEL_SENTINEL).toBe('hermesbot:delegate')
    expect(isDelegateModel(DELEGATE_MODEL_SENTINEL)).toBe(true)
    expect(isDelegateModel('hermesbot:oyakata')).toBe(true)
    expect(isDelegateModel('hermesbot/oyakata')).toBe(true)
    expect(isDelegateModel('hermesbot:chef-qwen')).toBe(true)
    expect(isDelegateModel('hermesbot/chef-qwen')).toBe(true)
    expect(isDelegateModel('hermesbot:auto')).toBe(false)
    expect(isDelegateModel('mlx-community--Qwen3.8-27B-4bit')).toBe(false)
  })

  it('labels the sentinel and the legacy id « Delegate »', () => {
    expect(modelLabel(DELEGATE_MODEL_SENTINEL)).toBe('Delegate')
    expect(modelLabel('hermesbot:chef-qwen')).toBe('Delegate')
  })

  it('chip shows the mode and the real chef model', () => {
    const chip = composerChipText({ answered: null, chatModel: DELEGATE_MODEL_SENTINEL, fallbackMark: '(secours)', chefLabel: 'Delegate' })
    expect(chip).toMatch(/^Delegate · /)
    expect(chip).toMatch(/Cursor/)
    expect(composerChipText({ answered: null, chatModel: 'hermesbot:chef-qwen', fallbackMark: '(secours)' })).toMatch(/^Delegate · /)
    expect(delegateChip('Delegate', '')).toBe('Delegate')
  })

  it('a session already on the Delegate sentinel (or a former id) reopens on it even when Auto is the default', () => {
    expect(pickerModelForSession(undefined, DELEGATE_MODEL_SENTINEL, { useAutoModel: true }, true)).toBe(DELEGATE_MODEL_SENTINEL)
    expect(pickerModelForSession(undefined, 'hermesbot:chef-qwen', { useAutoModel: true }, true)).toBe('hermesbot:chef-qwen')
    // An explicit Auto pick made after it wins (the gateway session is switched on the next send).
    expect(pickerModelForSession('hermesbot:auto', DELEGATE_MODEL_SENTINEL, { useAutoModel: true }, true)).toBe('hermesbot:auto')
    expect(pickerModelForSession(undefined, 'cursor/grok-4.7', { useAutoModel: true }, true)).toBe('hermesbot:auto')
  })

  it('the toggle goes through the chef-worker plugin RPC, per conversation', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const client = { request: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      return { session_id: params.session_id, enabled: method === DELEGATE_SET_METHOD ? params.enabled : false, worker: { model: 'Inkling-2-Mini-128K', label: 'Inkling 2 Mini Splash' }, default_chef: 'cursor/grok-4.7' }
    } } as unknown as HermesClient
    const target = { profile: 'orion', sessionId: 's1' }
    expect(await loadDelegate(client, target)).toMatchObject({ available: true, enabled: false, workerLabel: 'Inkling 2 Mini Splash', defaultChef: 'cursor/grok-4.7' })
    expect((await setDelegate(client, target, true)).enabled).toBe(true)
    expect(calls).toEqual([
      { method: DELEGATE_GET_METHOD, params: { profile: 'orion', session_id: 's1' } },
      { method: DELEGATE_SET_METHOD, params: { profile: 'orion', session_id: 's1', enabled: true } },
    ])
  })

  it('sends model and provider in the RPC and reads back reason/turnIsLocal/workerUp', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const client = { request: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      return { enabled: true, source: 'chat', reason: 'local_model', turn_model: 'Inkling-2-Mini-128K', turn_is_local: true, worker_up: false, worker: { label: 'Inkling 2 Mini Splash', model: 'Inkling-2-Mini-128K', context_max: 128000 }, default_chef: 'cursor/grok-4.7' }
    } } as unknown as HermesClient
    const state = await loadDelegate(client, { profile: 'orion', sessionId: 's2', model: 'Inkling-2-Mini-128K', provider: 'custom:splash' })
    expect(calls[0].params).toMatchObject({ model: 'Inkling-2-Mini-128K', provider: 'custom:splash' })
    expect(state.reason).toBe('local_model')
    expect(state.turnIsLocal).toBe(true)
    expect(state.enabled).toBe(false)
    expect(state.workerUp).toBe(false)
  })

  it('a bot without the plugin shows the toggle unavailable, other errors surface', async () => {
    const missing = { request: async () => { throw new HermesRpcError('unknown method', { reason: 'unknown_method' }, -32601) } } as unknown as HermesClient
    expect((await loadDelegate(missing, { profile: 'a', sessionId: 's' })).available).toBe(false)
    const broken = { request: async () => { throw new HermesRpcError('boom', { reason: 'plugin_rpc_failed' }, 5000) } } as unknown as HermesClient
    await expect(loadDelegate(broken, { profile: 'a', sessionId: 's' })).rejects.toThrow('boom')
  })

  it('Delegate is no longer a model: an old pick migrates to the bot default model', () => {
    expect(delegateMigrationTarget({ model: 'kimi-for-coding', provider: 'kimi-coding' })).toEqual({ model: 'kimi-for-coding', provider: 'kimi-coding', providerName: '' })
    expect(delegateMigrationTarget({ model: DELEGATE_MODEL_SENTINEL })).toBeNull()
    expect(delegateMigrationTarget({ model: '' })).toBeNull()
  })
})
