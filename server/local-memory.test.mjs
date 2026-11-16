import { describe, expect, it } from 'vitest'
import { createLocalMemory } from './local-memory.mjs'

const ok = () => ({ ok: true, status: 200, text: async () => '{}' })

describe('local model load', () => {
  it('aborts the upstream when the caller disconnects and does not mark the model kept', async () => {
    let seen
    const memory = createLocalMemory({
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
        seen = init.signal
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      }),
    })
    const caller = new AbortController()
    const pending = memory.run({ action: 'load', model: 'model:7b', origin: 'http://127.0.0.1:11434', signal: caller.signal })
    caller.abort()
    await expect(pending).rejects.toThrow(/abort/i)
    expect(seen.aborted).toBe(true)
    expect(memory.keptModel('model:7b')).toBe(false)
  })

  it('marks a model kept only after a successful load, and refuses a second load', async () => {
    let release
    const held = new Promise((resolve) => { release = resolve })
    let calls = 0
    const memory = createLocalMemory({
      fetchImpl: () => {
        calls += 1
        return calls === 1 ? held : ok()
      },
    })
    const first = memory.run({ action: 'load', model: 'model:7b', origin: 'http://127.0.0.1:11434' })
    await expect(memory.run({ action: 'load', model: 'model:7b', origin: 'http://127.0.0.1:11434' })).rejects.toMatchObject({ status: 409, message: 'local_model_busy' })
    expect(memory.keptModel('model:7b')).toBe(false)
    release(ok())
    await first
    expect(memory.keptModel('model:7b')).toBe(true)

    const failed = createLocalMemory({ fetchImpl: async () => ({ ok: false, status: 500, text: async () => '' }) })
    await expect(failed.run({ action: 'load', model: 'model:7b', origin: 'http://127.0.0.1:11434' })).rejects.toMatchObject({ status: 502 })
    expect(failed.keptModel('model:7b')).toBe(false)
  })

  it('clears the kept flag only after an unload succeeds', async () => {
    let mode = 'ok'
    const memory = createLocalMemory({
      fetchImpl: async () => (mode === 'ok' ? ok() : { ok: false, status: 500, text: async () => '' }),
    })
    await memory.run({ action: 'load', model: 'model:7b', origin: 'http://127.0.0.1:11434' })
    mode = 'fail'
    await expect(memory.run({ action: 'unload', model: 'model:7b', origin: 'http://127.0.0.1:11434' })).rejects.toMatchObject({ status: 502 })
    expect(memory.keptModel('model:7b')).toBe(true)
    mode = 'ok'
    await memory.run({ action: 'unload', model: 'model:7b', origin: 'http://127.0.0.1:11434' })
    expect(memory.keptModel('model:7b')).toBe(false)
  })
})
