import { describe, expect, it } from 'vitest'
import fuses from './fuses.cjs'

const { FuseV1Options, FuseVersion, afterPackDarwin, flipPackagedFuses, packagedFuseConfig } = fuses

describe('packaged Electron fuses', () => {
  it('disables RunAsNode, NODE_OPTIONS, and --inspect, and leaves the asar fuses unset', () => {
    const config = packagedFuseConfig()
    expect(config.version).toBe(FuseVersion.V1)
    expect(config.resetAdHocDarwinSignature).toBe(true)
    expect(config[FuseV1Options.RunAsNode]).toBe(false)
    expect(config[FuseV1Options.EnableNodeOptionsEnvironmentVariable]).toBe(false)
    expect(config[FuseV1Options.EnableNodeCliInspectArguments]).toBe(false)
    expect(config[FuseV1Options.OnlyLoadAppFromAsar]).toBeUndefined()
    expect(config[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]).toBeUndefined()
    expect(config[FuseV1Options.EnableCookieEncryption]).toBeUndefined()
    expect(Object.keys(config)).toHaveLength(5)
  })

  it('passes that map to @electron/fuses', async () => {
    let seen
    await flipPackagedFuses('/out/HermesBot.app', {
      flipFuses: async (electronPath, config) => { seen = { electronPath, config } },
    })
    expect(seen).toEqual({ electronPath: '/out/HermesBot.app', config: packagedFuseConfig() })
  })

  it('flips fuses before signing, and still flips when signing is off', async () => {
    const order = []
    await afterPackDarwin({
      platform: 'darwin',
      appPath: '/out/HermesBot.app',
      macSign: 'adhoc',
      signApp: async (appPath, mode) => { order.push(['sign', appPath, mode]) },
      flip: async (appPath) => { order.push(['flip', appPath]) },
    })
    expect(order).toEqual([
      ['flip', '/out/HermesBot.app'],
      ['sign', '/out/HermesBot.app', 'adhoc'],
    ])

    const unsigned = []
    await afterPackDarwin({
      platform: 'darwin',
      appPath: '/out/HermesBot.app',
      macSign: null,
      signApp: async () => { unsigned.push('sign') },
      flip: async () => { unsigned.push('flip') },
    })
    expect(unsigned).toEqual(['flip'])

    const skipped = []
    await afterPackDarwin({
      platform: 'win32',
      appPath: '/out/HermesBot.exe',
      macSign: 'adhoc',
      signApp: async () => { skipped.push('sign') },
      flip: async () => { skipped.push('flip') },
    })
    expect(skipped).toEqual([])
  })
})
