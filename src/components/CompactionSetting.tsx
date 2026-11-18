import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GAUGE_MAX, GAUGE_MIN, GAUGE_STEP, clampGauge, limitTokens, saveCompaction, type CompactionMode } from '../lib/compaction'
import { compactNumber } from '../lib/model'
import { updateSettings, useSettings } from '../lib/settings'

interface CompactionSettingProps {
  /** Slugs of every bot of the roster, hidden ones included: the setting is written into each profile. */
  slugs: string[]
  /** The open bot's window, to say what the gauge means in tokens. */
  context?: { contextMax: number; modelName: string } | null
  /** Visual demo: no gateway, the setting stays in this window. */
  demo?: boolean
}

type Status = { kind: 'idle' } | { kind: 'saving' } | { kind: 'applied'; count: number } | { kind: 'partial'; applied: number; names: string } | { kind: 'failed' }

/**
 * Settings > Conversations, "Context compaction". Auto: Hermes decides with each bot's own settings.
 * Manual: the user's gauge is the limit. Nothing is saved on the fly: the controls change a draft, and the
 * Save button writes it into every bot's profile (and into the shared settings, for the other apps).
 */
export function CompactionSetting({ slugs, context, demo = false }: CompactionSettingProps) {
  const { t } = useTranslation()
  const saved = useSettings()
  const [mode, setMode] = useState<CompactionMode>(saved.compactionMode)
  const [gauge, setGauge] = useState(saved.compactionGauge)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const changed = mode !== saved.compactionMode || (mode === 'manual' && gauge !== saved.compactionGauge)
  // A save that failed on some bots stays offered: saving again only goes over those that are missing.
  const dirty = changed || status.kind === 'partial'
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  // The saved setting changed elsewhere (read back from the gateway): an untouched draft follows it.
  useEffect(() => {
    if (dirtyRef.current) return
    setMode(saved.compactionMode)
    setGauge(saved.compactionGauge)
  }, [saved.compactionMode, saved.compactionGauge])

  const percent = Math.round(gauge * 100)
  const gaugeText = context?.contextMax
    ? t('compaction.setting.gaugeWith', { percent, tokens: compactNumber(limitTokens(context.contextMax, gauge)), model: context.modelName })
    : t('compaction.setting.gaugeBare', { percent })

  const save = async () => {
    if (status.kind === 'saving') return
    const next = { mode, gauge: clampGauge(gauge) }
    if (demo) {
      updateSettings({ compactionMode: next.mode, compactionGauge: next.gauge })
      setStatus({ kind: 'applied', count: slugs.length })
      return
    }
    if (!slugs.length) { setStatus({ kind: 'failed' }); return }
    setStatus({ kind: 'saving' })
    const result = await saveCompaction(next.mode, next.gauge, slugs)
    if (result.applied.length > 0) updateSettings({ compactionMode: next.mode, compactionGauge: next.gauge })
    if (!result.ok || result.applied.length === 0) setStatus({ kind: 'failed' })
    else if (result.failed.length) setStatus({ kind: 'partial', applied: result.applied.length, names: result.failed.join(', ') })
    else setStatus({ kind: 'applied', count: result.applied.length })
  }

  const message = status.kind === 'saving' ? t('compaction.setting.saving')
    : status.kind === 'failed' ? t('compaction.setting.failed')
      : status.kind === 'partial' ? t('compaction.setting.partial', { applied: status.applied, names: status.names })
        : changed ? t('compaction.setting.unsaved')
          : status.kind === 'applied' ? t('compaction.setting.applied', { count: status.count }) : ''

  return (
    <section className="settings-row compaction-setting" aria-labelledby="compaction-title">
      <div className="settings-row-copy">
        <strong id="compaction-title">{t('compaction.setting.title')}</strong>
        <span>{t('compaction.setting.hint')}</span>
      </div>
      <div className="compaction-controls">
        <div className="settings-segments" role="radiogroup" aria-label={t('compaction.setting.mode')}>
          {(['auto', 'manual'] as const).map((id) => (
            <button key={id} type="button" role="radio" aria-checked={mode === id} className={mode === id ? 'is-active' : ''} onClick={() => { setMode(id); setStatus({ kind: 'idle' }) }}>{t(`compaction.setting.${id}`)}</button>
          ))}
        </div>
        <p className="compaction-explain">{t(mode === 'auto' ? 'compaction.setting.autoHint' : 'compaction.setting.manualHint')}</p>
        {mode === 'manual' && (
          <label className="compaction-gauge">
            <span className="compaction-gauge-label"><strong>{t('compaction.setting.gauge')}</strong><output>{gaugeText}</output></span>
            <input
              type="range"
              min={Math.round(GAUGE_MIN * 100)}
              max={Math.round(GAUGE_MAX * 100)}
              step={Math.round(GAUGE_STEP * 100)}
              value={percent}
              aria-label={t('compaction.setting.gauge')}
              aria-valuetext={gaugeText}
              onChange={(event) => { setGauge(clampGauge(Number(event.target.value) / 100)); setStatus({ kind: 'idle' }) }}
            />
          </label>
        )}
        <div className="compaction-save">
          <span className={`settings-footer-status ${status.kind === 'failed' || status.kind === 'partial' ? 'is-error' : ''}`} role="status">{message}</span>
          <button type="button" className="settings-button is-primary" disabled={!dirty || status.kind === 'saving'} onClick={() => void save()}>{t('compaction.setting.save')}</button>
        </div>
      </div>
    </section>
  )
}
