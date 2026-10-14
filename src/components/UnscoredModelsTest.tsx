import { useEffect, useState } from 'react'
import { formatModelName } from '../lib/formatModelName'
import { ipcErrorMessage } from '../lib/ipcError'
import { t, tn } from '@/lib/i18n'

/**
 * Étape 168, Léo : « remets le bouton pour Lightning et qwen2.5-coder:14b ». L'analyse complète a été retirée
 * (étape 166) une fois ses scores recopiés dans verified-tool-scores.md ; un modèle ajouté ensuite n'avait donc
 * plus aucun moyen d'être mesuré, et Jaris ne choisit jamais un modèle sans score. Ce bouton ne teste QUE les
 * modèles sans score (jamais les 40) et ne choisit rien à la fin : Léo envoie le fichier, les scores sont
 * recopiés à la main dans verified-tool-scores.md, comme pour l'analyse du 25/09/2026.
 *
 * Suivi volontairement simple : une barre, ce qui se passe en ce moment, et une ligne par modèle terminé.
 * L'ancien tableau listait les ~40 modèles « En attente », ce qui faisait croire à Léo que tout allait être
 * retéléchargé.
 */
type Row = { model: string; status: 'done' | 'skipped' | 'replayed'; correct?: number; total?: number; reason?: string }
type Phase = 'idle' | 'confirming' | 'running' | 'done' | 'error'

export default function UnscoredModelsTest(): JSX.Element | null {
  const [models, setModels] = useState<string[] | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [percent, setPercent] = useState(0)
  const [current, setCurrent] = useState(() => t('runtime.preparing'))
  const [rows, setRows] = useState<Row[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.jaris.getUnscoredModels().then(setModels)
  }, [])

  useEffect(() => {
    if (phase !== 'running') return undefined
    return window.jaris.onModelBenchmarkLine((line) => {
      const [marker, ...args] = line.trim().split(/\s+/)
      const upsert = (row: Row): void => setRows((prev) => [...prev.filter((r) => r.model !== row.model), row])
      if (marker === '##PROGRESS##') {
        const [done, total] = args.map(Number)
        if (total > 0) setPercent(Math.min(100, Math.round((done / total) * 100)))
      } else if (marker === '##PULL_MODEL_PROGRESS##') {
        setCurrent(t('unscored.downloading', { model: formatModelName(args[0]), percent: args[1] }))
      } else if (marker === '##MODEL_TESTING##') {
        setCurrent(t('unscored.testing', { model: formatModelName(args[0]) }))
      } else if (marker === '##WORKING##') {
        // Étape 314 : une réponse de plusieurs minutes (gros modèle débordant sur la RAM) ne doit pas passer pour un
        // blocage. Sous une minute, rien ne change : « Test de X… » suffit.
        const minutes = Math.floor(Number(args[1]) / 60)
        setCurrent(
          minutes >= 1
            ? t('unscored.working', { model: formatModelName(args[0]), minutes })
            : t('unscored.testing', { model: formatModelName(args[0]) })
        )
      } else if (marker === '##MODEL_DONE##') {
        upsert({ model: args[0], status: 'done', correct: Number(args[1]), total: Number(args[2]) })
      } else if (marker === '##REPLAY_DONE##') {
        // Cas refaits (délai dépassé, plantage) : un nombre de cas, pas un score.
        upsert({ model: args[0], status: 'replayed', total: Number(args[1]) })
      } else if (marker === '##MODEL_SKIPPED##') {
        // Étape 169 : la vraie raison, jamais un « trop gros ou téléchargement impossible » générique.
        upsert({ model: args[0], status: 'skipped', reason: args.slice(1).join(' ') || undefined })
      }
    })
  }, [phase])

  if (!models) return null
  if (!models.length && phase === 'idle') {
    return <p className="capacity-scan__status">{t('unscored.allScored')}</p>
  }

  const run = async (): Promise<void> => {
    setPhase('running')
    setPercent(0)
    setRows([])
    setError(null)
    try {
      await window.jaris.testUnscoredModels()
      setPercent(100)
      setPhase('done')
    } catch (err) {
      setError(ipcErrorMessage(err))
      setPhase('error')
    }
  }

  return (
    <div className="options-menu__unscored">
      <p className="options-menu__unscored-title">
        {t('unscored.toTest', { count: models.length, models: models.map((model) => formatModelName(model)).join(', ') })}
      </p>
      <p className="options-menu__unscored-text">{t('unscored.changed')}</p>

      {phase === 'idle' && (
        <button className="options-menu__action" onClick={() => setPhase('confirming')}>
          {t('unscored.test')}
        </button>
      )}

      {phase === 'confirming' && (
        <div className="options-menu__unscored-confirm">
          <p>{t('unscored.confirm')}</p>
          <p>{t('unscored.resume')}</p>
          <div className="options-menu__unscored-actions">
            <button className="options-menu__action" onClick={() => void run()}>
              {t('unscored.start')}
            </button>
            <button className="options-menu__action" onClick={() => setPhase('idle')}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {(phase === 'running' || phase === 'done' || phase === 'error') && (
        <div className="options-menu__progress">
          <div className="options-menu__progress-label">
            {phase === 'running' ? current : phase === 'done' ? t('unscored.done') : t('unscored.interrupted')}
          </div>
          <div className="options-menu__progress-bar">
            <div className="options-menu__progress-bar-fill" style={{ width: `${percent}%` }} />
          </div>
          {rows.length > 0 && (
            <ul className="options-menu__unscored-results">
              {rows.map((row) => (
                <li key={row.model}>
                  {t('common.labelValue', {
                    label: formatModelName(row.model),
                    value:
                      row.status === 'done'
                        ? `${row.correct}/${row.total}`
                        : row.status === 'replayed'
                          ? tn('unscored.replayed', row.total ?? 0)
                          : t('unscored.skipped', { reason: row.reason ?? t('unscored.unknownReason') })
                  })}
                </li>
              ))}
            </ul>
          )}
          {phase === 'error' && error && <p className="options-menu__error">{error}</p>}
          {phase !== 'running' && (
            <div className="options-menu__unscored-actions">
              <button className="options-menu__action" onClick={() => void window.jaris.showUnscoredResults()}>
                {t('unscored.openResults')}
              </button>
              {phase === 'error' && (
                <button className="options-menu__action" onClick={() => void run()}>
                  {t('unscored.resumeButton')}
                </button>
              )}
            </div>
          )}
          {phase === 'done' && (
            <p className="options-menu__unscored-text">
              {t('unscored.send')}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
