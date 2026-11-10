import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { cdpOriginForBot, loadChromeTeams } from './chrome-teams.mjs'

const directory = mkdtempSync(path.join(os.tmpdir(), 'hermesbot-teams-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

function write(name, value) {
  const file = path.join(directory, name)
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
  return file
}

const valid = {
  default_team: 'commun',
  teams: {
    commun: { label: 'Commun', port: 9222, bots: [] },
    equipe: { label: 'Équipe', port: 9231, bots: ['orion', 'iris'] },
  },
}

describe('équipes de Chrome', () => {
  it('lit un fichier valide et route chaque bot vers son port', () => {
    const teams = loadChromeTeams(write('ok.json', valid))
    expect(cdpOriginForBot(teams, 'orion')).toBe('http://127.0.0.1:9231')
    expect(cdpOriginForBot(teams, 'iris')).toBe('http://127.0.0.1:9231')
    expect(cdpOriginForBot(teams, 'nova')).toBe('http://127.0.0.1:9222')
  })

  it('retourne null sans fichier ou avec un fichier invalide, sans jamais lever', () => {
    expect(loadChromeTeams(path.join(directory, 'absent.json'))).toBeNull()
    expect(loadChromeTeams(write('casse.json', '{ pas du json'))).toBeNull()
    expect(loadChromeTeams(write('vide.json', {}))).toBeNull()
    expect(loadChromeTeams(write('defaut.json', { ...valid, default_team: 'inconnue' }))).toBeNull()
  })

  it('refuse un port hors de 1024-65535 ou non entier', () => {
    for (const port of [80, 1023, 65536, 9222.5, '9222', null]) {
      const bad = { ...valid, teams: { commun: { label: 'C', port, bots: [] } } }
      expect(loadChromeTeams(write('port.json', bad))).toBeNull()
    }
    const edge = { ...valid, teams: { commun: { label: 'C', port: 1024, bots: [] } } }
    expect(loadChromeTeams(write('edge.json', edge))).not.toBeNull()
  })

  it('retourne une origine vide sans équipes', () => {
    expect(cdpOriginForBot(null, 'orion')).toBe('')
  })
})
