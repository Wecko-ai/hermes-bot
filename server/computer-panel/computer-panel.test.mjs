import http from 'node:http'
import { writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { createComputerPanelService } from './service.mjs'
import { cdpTargetForBot, driverForBot, pickPage } from './chrome.mjs'
import { hubForOrigin, resetScreencastHubs } from './hub.mjs'

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

function teamsFixture() {
  const file = path.join(os.tmpdir(), `chrome-teams-${Date.now()}.json`)
  writeFileSync(file, JSON.stringify({
    default_team: 'commun',
    teams: {
      commun: { label: 'Shared', port: 9222, bots: ['nova'] },
      direction: { label: 'Leads', port: 9231, bots: ['orion', 'iris'] },
    },
  }))
  return file
}

describe('computer panel chrome helpers', () => {
  it('picks a normal page and resolves the driver on the same team', () => {
    const teams = {
      defaultTeam: 'commun',
      teams: {
        commun: { label: 'Shared', port: 9222, bots: ['nova'] },
        direction: { label: 'Leads', port: 9231, bots: ['orion', 'iris'] },
      },
    }
    const page = pickPage([
      { id: 'a', type: 'page', url: 'chrome://newtab', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/a' },
      { id: 'b', type: 'page', url: 'https://example.test/form', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/b' },
    ])
    expect(page?.id).toBe('b')
    expect(pickPage([
      { id: 'a', type: 'page', url: 'chrome://newtab' },
      { id: 'b', type: 'page', url: 'https://example.test/form' },
    ], 'a')?.id).toBe('a')
    expect(cdpTargetForBot([{ owner: 'orion', targetId: 'TAB42' }], 'orion')).toBe('TAB42')
    expect(driverForBot(teams, 'iris', [{ owner: 'vega' }, { owner: 'orion' }])).toBe('orion')
    expect(driverForBot(teams, 'nova', [{ owner: 'orion' }])).toBe('')
  })
})

describe('computer panel screencast', () => {
  let cdpPort
  let cdpServer
  let cdpWss
  let commands = []

  afterEach(async () => {
    commands = []
    await resetScreencastHubs()
    if (cdpWss) await new Promise((resolve) => cdpWss.close(resolve))
    if (cdpServer) await new Promise((resolve) => cdpServer.close(resolve))
    cdpWss = null
    cdpServer = null
  })

  async function startFakeChrome({ pages = true, pageList = null } = {}) {
    cdpServer = http.createServer((request, response) => {
      if (request.url === '/json/list') {
        const list = typeof pageList === 'function' ? pageList(cdpPort) : pageList || (pages ? [
          { id: 'tab', type: 'page', url: 'https://checkout.test/captcha', title: 'Verify', webSocketDebuggerUrl: `ws://127.0.0.1:${cdpPort}/devtools/page/tab` },
        ] : [])
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify(list))
        return
      }
      response.statusCode = 404
      response.end()
    })
    cdpPort = await listen(cdpServer)
    cdpWss = new WebSocketServer({ noServer: true })
    cdpWss.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const frame = JSON.parse(String(raw))
        if (frame.method) commands.push(frame.method)
        const { id, method } = frame
        if (method === 'Page.enable' || method === 'Page.startScreencast' || method === 'Page.stopScreencast') {
          return socket.send(JSON.stringify({ id, result: {} }))
        }
        if (method === 'Page.screencastFrameAck') return
        if (method === 'Runtime.evaluate') {
          return socket.send(JSON.stringify({ id, result: { result: { value: { url: 'https://checkout.test/captcha', title: 'Verify' } } } }))
        }
        if (method === 'Input.dispatchMouseEvent' || method === 'Input.dispatchKeyEvent') return socket.send(JSON.stringify({ id, result: {} }))
        socket.send(JSON.stringify({ id, error: { message: 'unsupported' } }))
      })
      setTimeout(() => {
        socket.send(JSON.stringify({
          method: 'Page.screencastFrame',
          params: { data: Buffer.from('jpeg-bytes').toString('base64'), sessionId: 's1', metadata: { deviceWidth: 800, deviceHeight: 600 } },
        }))
      }, 15)
    })
    cdpServer.on('upgrade', (request, socket, head) => {
      if (!request.url?.startsWith('/devtools/page/')) return socket.destroy()
      cdpWss.handleUpgrade(request, socket, head, (client) => cdpWss.emit('connection', client))
    })
  }

  it('starts screencast for subscribers and stops when the last panel closes', async () => {
    await startFakeChrome()
    const origin = `http://127.0.0.1:${cdpPort}`
    const hub = hubForOrigin(origin)
    const seen = []
    const detach = hub.attach('orion', (event) => seen.push(event.type))
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(commands).toContain('Page.startScreencast')
    expect(seen).toContain('frame')
    detach()
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(commands).toContain('Page.stopScreencast')
  })

  it('forwards pointer events only after takeover', async () => {
    await startFakeChrome()
    const teamsFile = teamsFixture()
    const service = createComputerPanelService({
      enabled: true,
      chromeTeamsFile: teamsFile,
      cdpOrigin: `http://127.0.0.1:${cdpPort}`,
    })
    const origin = `http://127.0.0.1:${cdpPort}`
    const hub = hubForOrigin(origin)
    const detach = hub.attach('orion', () => {})
    await new Promise((resolve) => setTimeout(resolve, 80))
    await expect(service.forwardInput('orion', { kind: 'mouse', type: 'mousePressed', x: 4, y: 5 })).rejects.toMatchObject({ code: 'not_in_control' })
    await service.setTakeover('orion', true)
    await service.forwardInput('orion', { kind: 'mouse', type: 'mousePressed', x: 4, y: 5 })
    expect(commands).toContain('Input.dispatchMouseEvent')
    await service.forwardInput('orion', { kind: 'wheel', x: 4, y: 5, deltaY: 80 })
    await service.forwardInput('orion', { kind: 'key', type: 'keyDown', key: 'a', text: 'a', modifiers: 4 })
    expect(commands.filter((name) => name === 'Input.dispatchKeyEvent').length).toBeGreaterThanOrEqual(2)
    detach()
  })

  it('attaches screencast to the arbiter tab target when known', async () => {
    await startFakeChrome({
      pageList: (port) => [
        { id: 'old', type: 'page', url: 'https://checkout.test/old', title: 'Old', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/old` },
        { id: 'active', type: 'page', url: 'https://checkout.test/captcha', title: 'Verify', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/active` },
      ],
    })
    const teamsFile = teamsFixture()
    const arbiter = path.join(os.tmpdir(), `arbiter-${Date.now()}.mjs`)
    writeFileSync(arbiter, `console.log('tour : orion 2026-01-05T10:00:00Z target=active pid=1 depuis 1 min')\n`, { mode: 0o700 })
    const service = createComputerPanelService({
      enabled: true,
      chromeTeamsFile: teamsFile,
      cdpOrigin: `http://127.0.0.1:${cdpPort}`,
      browserTurnCommand: [process.execPath, arbiter],
    })
    const hub = hubForOrigin(`http://127.0.0.1:${cdpPort}`)
    await service.statusForBot('iris')
    const detach = hub.attach('iris', () => {})
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(hub.session?.page?.id).toBe('active')
    detach()
  })

  it('lists the team Chrome tabs and watches the one picked, then follows the bot again', async () => {
    await startFakeChrome({
      pageList: (port) => [
        { id: 'one', type: 'page', url: 'https://a.test/', title: 'A', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/one` },
        { id: 'two', type: 'page', url: 'https://b.test/', title: 'B', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/two` },
      ],
    })
    const service = createComputerPanelService({ enabled: true, cdpOrigin: `http://127.0.0.1:${cdpPort}`, chromeTeams: null })
    const hub = hubForOrigin(`http://127.0.0.1:${cdpPort}`)
    const detach = hub.attach('orion', () => {})
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(hub.session?.page?.id).toBe('one')
    let listed = await service.pagesForBot('orion')
    expect(listed.following).toBe(true)
    expect(listed.pages.map((page) => [page.id, page.current])).toEqual([['one', true], ['two', false]])
    listed = await service.selectPage('orion', 'two')
    expect(hub.session?.page?.id).toBe('two')
    expect(listed.following).toBe(false)
    expect(listed.pages.find((page) => page.current)?.id).toBe('two')
    await expect(service.selectPage('orion', 'gone')).rejects.toMatchObject({ code: 'unknown_tab' })
    listed = await service.selectPage('orion', '')
    expect(listed.following).toBe(true)
    expect(hub.session?.page?.id).toBe('one')
    detach()
  })

  it('reports idle Chrome when no tab is available', async () => {
    await startFakeChrome({ pages: false })
    const service = createComputerPanelService({
      enabled: true,
      cdpOrigin: `http://127.0.0.1:${cdpPort}`,
      chromeTeams: null,
    })
    const status = await service.statusForBot('orion')
    expect(status.state).toBe('idle')
    const hub = hubForOrigin(`http://127.0.0.1:${cdpPort}`)
    const detach = hub.attach('orion', () => {})
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(hub.meta.state).toBe('idle')
    detach()
  })
})