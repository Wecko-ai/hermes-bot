import { useTranslation } from 'react-i18next'
import type { ModelScoreInfo } from '../lib/model-scores'

/** LLM Stats score and up to two usage chips of a model row. */
export function ModelScoreMeta({ info }: { info: ModelScoreInfo | undefined }) {
  const { t } = useTranslation()
  if (!info) return null
  const score = Math.round(info.score.intelligence)
  return (
    <span className="model-score-meta">
      {info.chips.map((chip) => <span key={chip} className={`model-option-tag is-rec is-${chip}`} title={t(`models.recHint.${chip}`)}>{t(`models.rec.${chip}`)}</span>)}
      <span className="model-score" title={t('models.scoreLabel', { score })} aria-label={t('models.scoreLabel', { score })}>{score}</span>
    </span>
  )
}

/** The attribution LLM Stats requires. Opens in the browser through the app's link guard. */
export function ScoresAttribution() {
  const { t } = useTranslation()
  return <a className="model-picker-manage" href="https://llm-stats.com/" target="_blank" rel="noreferrer noopener">{t('settings.scores.attribution')}</a>
}
