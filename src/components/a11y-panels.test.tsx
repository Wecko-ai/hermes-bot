import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { BrowserVaultRequest } from '../lib/browser-vault'
import type { SessionUsage } from '../types'
import { i18n } from '../i18n'
import { agentProgressPolling } from './SubagentsPanel'
import { UsageTab, usageWatchKey } from './UsageTab'
import { BrowserVaultDialog, readVaultReplaces } from './BrowserVaultDialog'

const saveRequest = (extra: Partial<BrowserVaultRequest> = {}): BrowserVaultRequest => ({
  id: 'r1', kind: 'save', bot: 'orion', origin: 'https://login.example.org', busy: false, createdAt: '2026-11-16T10:00:00Z', ...extra,
})

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

describe('vault save card', () => {
  it('says a save replaces the stored password and lists the bots already allowed', () => {
    const request = { ...saveRequest(), replaces: { identifier: 'ada@example.com', bots: ['orion', 'lyra'] } } as BrowserVaultRequest
    expect(readVaultReplaces(request)).toEqual({ identifier: 'ada@example.com', bots: ['orion', 'lyra'] })
    const html = text(renderToStaticMarkup(<BrowserVaultDialog request={request} botName="Nova" onRespond={async () => undefined} />))
    expect(html).toContain('remplace le mot de passe enregistré pour ada@example.com')
    expect(html).toContain('ajoute Nova aux bots autorisés (orion, lyra)')
    expect(i18n.t('browserVault.noteSaveReplace', { lng: 'en', identifier: 'ada@example.com', bot: 'Nova', bots: 'orion, lyra' }))
      .toContain('replaces the saved password for ada@example.com')
  })

  it('names every bot when the saved login is open to all of them', () => {
    const request = { ...saveRequest(), replaces: { identifier: 'ada', bots: ['*'] } } as BrowserVaultRequest
    const html = text(renderToStaticMarkup(<BrowserVaultDialog request={request} botName="Nova" onRespond={async () => undefined} />))
    expect(html).toContain('Tous les bots')
  })

  it('keeps the first-save note when nothing is being replaced', () => {
    const html = text(renderToStaticMarkup(<BrowserVaultDialog request={saveRequest()} botName="Nova" onRespond={async () => undefined} />))
    expect(html).not.toContain('remplace le mot de passe')
    expect(html).toContain('réservé à Nova')
    expect(readVaultReplaces(saveRequest())).toBeNull()
  })
})

describe('usage session reload', () => {
  it('changes the watch key when the session changes and the bot does not', () => {
    expect(usageWatchKey('alpha', false, 'session-a')).not.toBe(usageWatchKey('alpha', false, 'session-b'))
    expect(usageWatchKey('alpha', false, 'session-a')).toBe(usageWatchKey('alpha', false, 'session-a'))
    expect(usageWatchKey('alpha', true, 'session-a')).not.toBe(usageWatchKey('alpha', false, 'session-a'))
  })

  it('renders throughput from the catalog', () => {
    const live: SessionUsage = { contextUsed: 1, contextMax: 10, contextPercent: 10, averageTps: 42, inputTokens: 1, outputTokens: 1, totalTokens: 2 }
    const html = renderToStaticMarkup(<UsageTab slug="alpha" sessionId="session-a" running={false} live={live} load={async () => ({ usage: null, context: null, history: null })} />)
    expect(html).toContain('42 tok/s')
    expect(html).not.toContain('tok/s tok/s')
    const source = readFileSync(new URL('./UsageTab.tsx', import.meta.url), 'utf8')
    expect(source).toContain('usageWatchKey(slug, running, sessionId)')
    expect(source).toContain('[watch]')
    expect(source).not.toContain('tok/s')
  })
})

describe('agent progress poll', () => {
  it('skips the interval while the window is hidden and fetches again when it is shown', () => {
    expect(agentProgressPolling(true, true)).toEqual({ fetch: false, timer: false })
    expect(agentProgressPolling(false, true)).toEqual({ fetch: true, timer: true })
    expect(agentProgressPolling(false, false)).toEqual({ fetch: true, timer: false })
  })
})

describe('vault origin placeholder', () => {
  it('comes from the catalog in both languages', () => {
    expect(i18n.t('vault.originPlaceholder', { lng: 'en' })).toBe('https://www.instagram.com')
    expect(i18n.t('vault.originPlaceholder', { lng: 'fr' })).toBe('https://www.instagram.com')
    const source = readFileSync(new URL('./VaultTab.tsx', import.meta.url), 'utf8')
    expect(source).toContain("t('vault.originPlaceholder')")
    expect(source).not.toContain('instagram.com')
  })
})
