import { describe, expect, it } from 'vitest'
import { browserTurnCommand, parseBrowserOwners, parseBrowserTurn, parseBrowserTurns, readBrowserOwners } from './browser-turn.mjs'

describe('commande de l’arbitre du Chrome', () => {
  const setting = { command: ['/opt/arbiter', 'statut'], user: 'owner', remoteCommand: ['/usr/bin/ssh', 'host', '/opt/arbiter statut'] }

  it('ne lance rien sans réglage', async () => {
    expect(browserTurnCommand({ command: null })).toBeNull()
    expect(browserTurnCommand(undefined)).toBeNull()
    expect(await readBrowserOwners(null)).toEqual([])
  })

  it('lance la commande locale pour son utilisateur, la commande distante pour les autres', () => {
    expect(browserTurnCommand(setting, 'owner')).toEqual(['/opt/arbiter', 'statut'])
    expect(browserTurnCommand(setting, 'someone')).toEqual(['/usr/bin/ssh', 'host', '/opt/arbiter statut'])
    expect(browserTurnCommand({ command: ['/opt/arbiter'], user: 'owner', remoteCommand: null }, 'someone')).toBeNull()
    expect(browserTurnCommand({ command: ['/opt/arbiter'], user: '' }, 'anyone')).toEqual(['/opt/arbiter'])
  })

  it('renvoie personne quand la commande échoue', async () => {
    expect(await readBrowserOwners(['/nonexistent/arbiter', 'statut'])).toEqual([])
  })
})

describe('propriétaire du Chrome partagé', () => {
  it('lit seulement le propriétaire de la première ligne', () => {
    expect(parseBrowserTurn('tour : vega 2026-01-05T10:00:00+0000 pid=4242 depuis 12 min\nen file : 1\n  1. iris\n')).toBe('vega')
  })

  it('reconnaît un navigateur libre ou un ancien verrou anonyme', () => {
    expect(parseBrowserTurn('tour : libre\nen file : 0')).toBe('')
    expect(parseBrowserTurn('tour : ? (ancien verrou sans owner) depuis 2 min')).toBe('')
  })

  it('lit un propriétaire par équipe dans le nouveau format', () => {
    const output = 'tour[commun] : libre\nen file[commun] : 0\ntour[direction] : orion 2026-11-10T14:20:00+0000 pid=123 depuis 3 min\nen file[direction] : 1\n  1. iris\ntour[studio] : nova 2026-11-10T14:21:00+0000 pid=9 depuis 1 min\nen file[studio] : 0\n'
    expect(parseBrowserOwners(output)).toEqual(['orion', 'nova'])
    expect(parseBrowserTurn(output)).toBe('orion')
    expect(parseBrowserOwners('tour[commun] : libre\nen file[commun] : 0')).toEqual([])
    expect(parseBrowserTurn('tour[commun] : libre\ntour[direction] : vega depuis 1 min')).toBe('vega')
  })

  it('garde l’ancien format sur une seule ligne', () => {
    expect(parseBrowserOwners('tour : vega 2026-01-05T10:00:00+0000 pid=1 depuis 2 min\nen file : 0')).toEqual(['vega'])
    expect(parseBrowserOwners('tour : libre')).toEqual([])
    expect(parseBrowserOwners('')).toEqual([])
  })

  it('donne l’heure de prise du tour, sans pid ni file', () => {
    const output = 'tour[direction] : vega 2026-11-11T10:35:23+0200 pid=4242 depuis 2 min\nen file[direction] : 1\n  1. iris\ntour[studio] : nova depuis 1 min\n'
    expect(parseBrowserTurns(output)).toEqual([
      { owner: 'vega', since: '2026-11-11T08:35:23.000Z' },
      { owner: 'nova', since: null },
    ])
    expect(parseBrowserTurns('tour : vega 2026-01-05T10:00:00Z pid=1 depuis 0 min')).toEqual([{ owner: 'vega', since: '2026-01-05T10:00:00.000Z' }])
  })

  it('laisse de côté un tour tenu au-delà de la limite de l’arbitre', () => {
    const output = 'tour[direction] : vega 2026-11-11T09:00:00+0200 pid=1 depuis 45 min\ntour[studio] : nova 2026-11-11T09:40:00+0200 pid=2 depuis 44 min\n'
    expect(parseBrowserOwners(output)).toEqual(['nova'])
  })
})
