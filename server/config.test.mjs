import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import configModule from './config.cjs'

const { loadConfig, dataDirectory } = configModule

function fixture({ privateConfig, userConfig, animations = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hermesbot-config-'))
  const home = path.join(root, 'home')
  mkdirSync(path.join(root, 'private'), { recursive: true })
  if (privateConfig) writeFileSync(path.join(root, 'private', 'hermesbot.config.json'), JSON.stringify(privateConfig))
  if (animations) mkdirSync(path.join(root, 'private', 'animations'))
  const dataDir = dataDirectory({}, 'darwin', home)
  if (userConfig) {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(path.join(dataDir, 'config.json'), typeof userConfig === 'string' ? userConfig : JSON.stringify(userConfig))
  }
  return { root, home, dataDir }
}

describe('configuration locale', () => {
  it('a des valeurs par défaut sans aucun fichier', () => {
    const { root, home, dataDir } = fixture()
    const config = loadConfig({ env: {}, platform: 'darwin', home, root })
    expect(config.gatewayOrigin).toBe('http://127.0.0.1:9120')
    expect(config.videoRoots).toContain(path.join(home, 'projects'))
    expect(config.videoRoots.some((root) => root.startsWith('/Volumes/'))).toBe(false)
    expect(config.browserOrigin).toBe('http://127.0.0.1:9120')
    expect(config.sshHost).toBe('')
    expect(config.ollamaOrigin).toBe('http://127.0.0.1:11434')
    expect(config.localChat.model).toBe('')
    expect(config.browserTurn.command).toBeNull()
    expect(config.computerPanel).toEqual({ enabled: false, cdpOrigin: '' })
    expect(config.llmStats).toEqual({ snapshotPath: '', keyCommand: null })
    expect(config.animationsDir).toBe(path.join(dataDir, 'animations'))
    expect(config.sharedMemory).toEqual({ dir: '', injectContext: false, injectMaxChars: 2000 })
    expect(config.features).toEqual({ usageGlobal: true, vaultWallet: false, pagesLibrary: false })
    expect(config.usageQuotas).toEqual([])
    expect(config.pagesLibraryDir).toBe(path.join(dataDir, 'pages-library'))
    expect(config.channels).toEqual({ wizardWrites: false })
    expect(config.push).toEqual({ relayUrl: '', secretCommand: null })
    expect(config.ui).toEqual({ defaultBot: '', sectionOrder: [], rosterOrder: {}, userInitial: '', userName: '', hiddenProviders: [], subscriptionProviders: [], zeroSpendDefault: false, contrastAvatars: [], voiceModeName: '', replyListenButton: false })
    expect(config.routines.eventTriggers).toBe(false)
  })

  it('active les déclencheurs d’événements uniquement quand la clé est à true', () => {
    const off = fixture({ userConfig: { routines: { eventTriggers: false } } })
    expect(loadConfig({ env: {}, platform: 'darwin', home: off.home, root: off.root }).routines.eventTriggers).toBe(false)
    const on = fixture({ userConfig: { routines: { eventTriggers: true } } })
    expect(loadConfig({ env: {}, platform: 'darwin', home: on.home, root: on.root }).routines.eventTriggers).toBe(true)
  })

  it('superpose environnement, fichier utilisateur et fichier privé, dans cet ordre', () => {
    const { root, home } = fixture({
      privateConfig: { sshHost: 'private-host', browserOrigin: 'https://private.example', ui: { defaultBot: 'orion', userInitial: 'P', zeroSpendDefault: true } },
      userConfig: { sshHost: 'user-host', ui: { userInitial: 'U' } },
      animations: true,
    })
    const config = loadConfig({ env: { HERMES_SSH_HOST: 'env-host' }, platform: 'darwin', home, root })
    expect(config.sshHost).toBe('env-host')
    expect(config.browserOrigin).toBe('https://private.example')
    expect(config.ui.defaultBot).toBe('orion')
    expect(config.ui.userInitial).toBe('U')
    expect(config.ui.zeroSpendDefault).toBe(true)
    expect(config.animationsDir).toBe(path.join(root, 'private', 'animations'))
  })

  it('écarte les valeurs invalides au lieu de les transmettre', () => {
    const { root, home } = fixture({
      userConfig: {
        gatewayOrigin: 'file:///etc/passwd',
        browserOrigin: 'https://example.com/path',
        sshHost: '-oProxyCommand=evil',
        browserTurn: { command: ['relative/arbiter', 'statut'] },
        ui: { defaultBot: '../x', hiddenProviders: ['ok', 'not ok', 42], subscriptionProviders: ['anthropic', 'custom:opencode-go', 'custom:cursor-(abo)', 'no/slash', 7], zeroSpendDefault: 'true', sectionOrder: 'Atelier' },
      },
    })
    const config = loadConfig({ env: {}, platform: 'darwin', home, root })
    expect(config.gatewayOrigin).toBe('http://127.0.0.1:9120')
    expect(config.browserOrigin).toBe('http://127.0.0.1:9120')
    expect(config.sshHost).toBe('')
    expect(config.browserTurn.command).toBeNull()
    expect(config.ui.defaultBot).toBe('')
    expect(config.ui.hiddenProviders).toEqual(['ok'])
    expect(config.ui.subscriptionProviders).toEqual(['anthropic', 'custom:opencode-go', 'custom:cursor-(abo)'])
    expect(config.ui.zeroSpendDefault).toBe(false)
    expect(config.ui.sectionOrder).toEqual([])
  })

  it('ignore les réglages privés quand on le demande', () => {
    const { root, home, dataDir } = fixture({ privateConfig: { sshHost: 'private-host' }, animations: true })
    const config = loadConfig({ env: { HERMESBOT_NO_PRIVATE: '1' }, platform: 'darwin', home, root })
    expect(config.sshHost).toBe('')
    expect(config.animationsDir).toBe(path.join(dataDir, 'animations'))
  })

  it('ignore un fichier illisible', () => {
    const { root, home } = fixture({ userConfig: '{ pas du json' })
    expect(loadConfig({ env: {}, platform: 'darwin', home, root }).gatewayOrigin).toBe('http://127.0.0.1:9120')
  })

  it('accepte une commande d’arbitre par variable d’environnement', () => {
    const { root, home } = fixture({ privateConfig: { browserTurn: { command: ['/opt/a'], user: 'owner', remoteCommand: ['/usr/bin/ssh', 'h'] } } })
    const config = loadConfig({ env: { BROWSER_TOUR_COMMAND: '/tmp/fixture.cjs' }, platform: 'darwin', home, root })
    expect(config.browserTurn).toEqual({ command: ['/tmp/fixture.cjs', 'statut'], user: '', remoteCommand: null })
  })

  it('keeps a gateway or Ollama origin on this machine unless remote access is opted in', () => {
    const remote = {
      gatewayOrigin: 'https://example.invalid',
      ollamaOrigin: 'http://203.0.113.5:11434',
    }
    const { root, home } = fixture({ userConfig: remote })
    const blocked = loadConfig({ env: { HERMES_ORIGIN: 'http://203.0.113.5:9120' }, platform: 'darwin', home, root })
    expect(blocked.gatewayOrigin).toBe('http://127.0.0.1:9120')
    expect(blocked.ollamaOrigin).toBe('http://127.0.0.1:11434')

    const loopbackFixture = fixture({ userConfig: { gatewayOrigin: 'http://[::1]:9120', ollamaOrigin: 'http://localhost:11434', browserOrigin: 'https://example.invalid' } })
    const loopback = loadConfig({ env: {}, platform: 'darwin', home: loopbackFixture.home, root: loopbackFixture.root })
    expect(loopback.gatewayOrigin).toBe('http://[::1]:9120')
    expect(loopback.ollamaOrigin).toBe('http://localhost:11434')
    expect(loopback.browserOrigin).toBe('https://example.invalid')

    const allowedFixture = fixture({ userConfig: { allowRemoteGateway: true } })
    const allowed = loadConfig({
      env: { HERMES_ORIGIN: 'http://203.0.113.5:9120', OLLAMA_ORIGIN: 'https://ollama.example' },
      platform: 'darwin',
      home: allowedFixture.home,
      root: allowedFixture.root,
    })
    expect(allowed.gatewayOrigin).toBe('http://203.0.113.5:9120')
    expect(allowed.ollamaOrigin).toBe('https://ollama.example')

    const notABooleanFixture = fixture({ userConfig: { allowRemoteGateway: 'true', gatewayOrigin: 'http://203.0.113.5:9120' } })
    const notABoolean = loadConfig({ env: {}, platform: 'darwin', home: notABooleanFixture.home, root: notABooleanFixture.root })
    expect(notABoolean.gatewayOrigin).toBe('http://127.0.0.1:9120')
  })

  it('accepts an absolute LLM Stats snapshot path from the environment', () => {
    const { root, home } = fixture({ userConfig: { llmStats: { snapshotPath: 'relative.json' } } })
    const config = loadConfig({ env: { HERMESBOT_LLM_STATS_SNAPSHOT: '/tmp/llm-stats.json' }, platform: 'darwin', home, root })
    expect(config.llmStats.snapshotPath).toBe('/tmp/llm-stats.json')
    expect(loadConfig({ env: {}, platform: 'darwin', home, root }).llmStats.snapshotPath).toBe('')
  })

  it('accepts only an absolute argv array for the LLM Stats key command', () => {
    const valid = fixture({ privateConfig: { llmStats: { keyCommand: ['/usr/bin/ssh', '-o', 'ConnectTimeout=12', 'host', 'secret-command'] } } })
    expect(loadConfig({ env: {}, platform: 'darwin', home: valid.home, root: valid.root }).llmStats.keyCommand)
      .toEqual(['/usr/bin/ssh', '-o', 'ConnectTimeout=12', 'host', 'secret-command'])
    for (const keyCommand of [['relative/command'], [], ['/usr/bin/ssh', ''], 'ssh', [42]]) {
      const invalid = fixture({ privateConfig: { llmStats: { keyCommand } } })
      expect(loadConfig({ env: {}, platform: 'darwin', home: invalid.home, root: invalid.root }).llmStats.keyCommand).toBeNull()
    }
  })

  it('range les données selon le système', () => {
    expect(dataDirectory({}, 'darwin', '/h')).toBe('/h/Library/Application Support/HermesBot')
    expect(dataDirectory({ HERMESBOT_DATA_NAME: 'HermesBot Refonte' }, 'darwin', '/h')).toBe('/h/Library/Application Support/HermesBot Refonte')
    expect(dataDirectory({ HERMESBOT_DATA_NAME: '../etc' }, 'darwin', '/h')).toBe('/h/Library/Application Support/HermesBot')
    expect(dataDirectory({}, 'linux', '/h')).toBe('/h/.config/HermesBot')
    expect(dataDirectory({ XDG_CONFIG_HOME: '/x' }, 'linux', '/h')).toBe('/x/HermesBot')
  })
})
