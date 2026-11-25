import './test-dom'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { Bot, SessionUsage } from '../types'
import { DetailsPanel } from './DetailsPanel'
import { installTestDom } from './test-dom'

const bot = (): Bot => ({
  slug: 'demo',
  name: 'Alpha',
  role: 'Helper',
  section: 'Team',
  sectionId: 'team',
  model: 'anthropic/claude-sonnet-4',
  status: 'idle',
  preview: '',
  timestamp: null,
  unread: 0,
  hidden: false,
})

const sampleUsage = (overrides: Partial<SessionUsage> = {}): SessionUsage => ({
  contextUsed: 25000,
  contextMax: 100000,
  contextPercent: 25,
  averageTps: 42,
  inputTokens: 12000,
  outputTokens: 3000,
  totalTokens: 15000,
  compressions: 0,
  ...overrides,
})

const baseGuard = {
  level: 'ok' as const,
  used: 25000,
  limit: 80000,
  percent: 25,
  limitPercent: 80,
}

async function mountDetails(overrides: Partial<Parameters<typeof DetailsPanel>[0]> = {}) {
  const { container } = installTestDom()
  const root = createRoot(container as unknown as Element)
  const props: Parameters<typeof DetailsPanel>[0] = {
    bot: bot(),
    routines: [],
    messages: [],
    subagents: [],
    onLoadSubagentTail: async () => ({ available: false, text: "", truncated: false }),
    tabRequest: null,
    loading: false,
    running: false,
    usage: sampleUsage(),
    contextUsage: sampleUsage(),
    modelLabel: 'Sonnet 4',
    modelPickerOpen: false,
    onOpenModels: () => undefined,
    compaction: {
      mode: 'auto',
      gauge: 0.8,
      guard: baseGuard,
      compacting: false,
      onCompact: () => undefined,
      onOpenSettings: () => undefined,
      tooltip: 'Compaction auto vers 90 k',
    },
    loadUsageDetails: async () => ({ usage: sampleUsage(), context: null, history: null }),
    onOpenDocument: () => undefined,
    documents: [],
    railTab: 'routines',
    onSelectRailTab: () => undefined,
    onCloseDocument: () => undefined,
    onReloadDocument: () => undefined,
    onClose: () => undefined,
    client: null,
    routinesEditable: false,
    connectorsEnabled: false,
    onReloadRoutines: () => undefined,
    ...overrides,
  }
  await act(async () => {
    root.render(createElement(DetailsPanel, props))
  })
  return {
    container,
    unmount: () => act(async () => { root.unmount() }),
  }
}

describe('DetailsPanel session model & context controls', () => {
  it('renders model selector, context readout, meter, and compaction controls', async () => {
    const onOpenModels = vi.fn()
    const onCompact = vi.fn()
    const onOpenSettings = vi.fn()
    const view = await mountDetails({
      onOpenModels,
      compaction: {
        mode: 'manual',
        gauge: 0.8,
        guard: baseGuard,
        compacting: false,
        onCompact,
        onOpenSettings,
        tooltip: 'Limite à 80 %',
      },
    })

    const modelBtn = view.container.querySelector('[data-model-trigger="true"]')
    expect(modelBtn).not.toBeNull()
    expect(modelBtn?.textContent).toContain('Sonnet 4')
    await act(async () => { modelBtn?.click() })
    expect(onOpenModels).toHaveBeenCalledWith('')

    const readout = view.container.querySelector('.details-session')?.querySelector('.usage-readout')
    expect(readout?.textContent).toContain('25')

    const meter = view.container.querySelector('.details-context-meter')
    expect(meter?.getAttribute('role')).toBe('meter')
    expect(meter?.getAttribute('aria-valuenow')).toBe('25')

    const modeBtn = view.container.querySelector('.details-compaction-mode')
    expect(modeBtn?.textContent).toContain('80')
    await act(async () => { modeBtn?.click() })
    expect(onOpenSettings).toHaveBeenCalledTimes(1)

    const compactBtn = view.container.querySelector('.details-compact-button')
    expect(compactBtn?.getAttribute('disabled')).toBeNull()
    await act(async () => { compactBtn?.click() })
    expect(onCompact).toHaveBeenCalledTimes(1)

    await view.unmount()
  })

  it('disables manual compaction when running or when context is empty', async () => {
    const runningView = await mountDetails({ running: true })
    const runningBtn = runningView.container.querySelector('.details-compact-button')
    expect(runningBtn?.getAttribute('disabled')).not.toBeNull()
    await runningView.unmount()

    const emptyView = await mountDetails({
      contextUsage: sampleUsage({ contextUsed: 0, contextPercent: 0 }),
    })
    const emptyBtn = emptyView.container.querySelector('.details-compact-button')
    expect(emptyBtn?.getAttribute('disabled')).not.toBeNull()
    await emptyView.unmount()
  })
})

describe('DetailsPanel Delegate toggle', () => {
  const oyakata = (overrides: Record<string, unknown> = {}) => ({
    on: false, available: true, busy: false, chef: 'Kimi K2.6', worker: 'Inkling 2 Mini Splash', onToggle: vi.fn(), ...overrides,
  })

  it('sits in the session block, off by default, naming the worker', async () => {
    const view = await mountDetails({ oyakata: oyakata() as never })
    const session = view.container.querySelector('.details-session')
    const row = session?.querySelector('.details-session-oyakata')
    expect(row).toBeTruthy()
    const sw = row?.querySelector('[role="switch"]')
    expect(sw?.getAttribute('aria-checked')).toBe('false')
    expect(sw?.disabled).toBe(false)
    expect(row?.textContent).toContain('Inkling 2 Mini Splash')
    await view.unmount()
  })

  it('names the chef and the worker when on, and is disabled without the plugin', async () => {
    const on = await mountDetails({ oyakata: oyakata({ on: true }) as never })
    const row = on.container.querySelector('.details-session-oyakata')
    expect(row?.className).toContain('is-on')
    expect(row?.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true')
    expect(row?.textContent).toContain('Kimi K2.6')
    await on.unmount()
    const off = await mountDetails({ oyakata: oyakata({ available: false }) as never })
    expect(off.container.querySelector('.details-session-oyakata')?.querySelector('[role="switch"]')?.disabled).toBe(true)
    await off.unmount()
  })

  it('shows a failed switch as an alert', async () => {
    const view = await mountDetails({ oyakata: oyakata({ error: 'boom' }) as never })
    expect(view.container.querySelector('.details-oyakata-hint')?.getAttribute('role')).toBe('alert')
    await view.unmount()
  })
})
