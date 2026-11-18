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
    expect(config.browserOrigin).toBe('http://127.0.0.1:9120')
    expect(config.sshHost).toBe('')
    expect(config.ollamaOrigin).toBe('http://127.0.0.1:11434')
    expect(config.localChat.model).toBe('')
    expect(config.browserTurn.command).toBeNull()
    expect(config.animationsDir).toBe(path.join(dataDir, 'animations'))
    expect(config.ui).toEqual({ defaultBot: '', sectionOrder: [], userInitial: '', userName: '', hiddenProviders: [], subscriptionProviders: [], contrastAvatars: [], voiceModeName: '' })
  })

  it('superpose environnement, fichier utilisateur et fichier privé, dans cet ordre', () => {
    const { root, home } = fixture({
      privateConfig: { sshHost: 'private-host', browserOrigin: 'https://private.example', ui: { defaultBot: 'orion', userInitial: 'P' } },
      userConfig: { sshHost: 'user-host', ui: { userInitial: 'U' } },
      animations: true,
    })
    const config = loadConfig({ env: { HERMES_SSH_HOST: 'env-host' }, platform: 'darwin', home, root })
    expect(config.sshHost).toBe('env-host')
    expect(config.browserOrigin).toBe('https://private.example')
    expect(config.ui.defaultBot).toBe('orion')
    expect(config.ui.userInitial).toBe('U')
    expect(config.animationsDir).toBe(path.join(root, 'private', 'animations'))
  })

  it('écarte les valeurs invalides au lieu de les transmettre', () => {
    const { root, home } = fixture({
      userConfig: {
        gatewayOrigin: 'file:///etc/passwd',
        browserOrigin: 'https://example.com/path',
        sshHost: '-oProxyCommand=evil',
        browserTurn: { command: ['relative/arbiter', 'statut'] },
        ui: { defaultBot: '../x', hiddenProviders: ['ok', 'not ok', 42], subscriptionProviders: ['anthropic', 'custom:opencode-go', 'custom:cursor-(abo)', 'no/slash', 7], sectionOrder: 'Atelier' },
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

  it('range les données selon le système', () => {
    expect(dataDirectory({}, 'darwin', '/h')).toBe('/h/Library/Application Support/HermesBot')
    expect(dataDirectory({}, 'linux', '/h')).toBe('/h/.config/HermesBot')
    expect(dataDirectory({ XDG_CONFIG_HOME: '/x' }, 'linux', '/h')).toBe('/x/HermesBot')
  })
})
