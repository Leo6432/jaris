import { useEffect, useState } from 'react'
import { formatModelName } from '../lib/formatModelName'

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
type Row = { model: string; status: 'done' | 'skipped'; correct?: number; total?: number }
type Phase = 'idle' | 'confirming' | 'running' | 'done' | 'error'

export default function UnscoredModelsTest(): JSX.Element | null {
  const [models, setModels] = useState<string[] | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [percent, setPercent] = useState(0)
  const [current, setCurrent] = useState('Préparation…')
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
        setCurrent(`Téléchargement de ${formatModelName(args[0])} : ${args[1]} %`)
      } else if (marker === '##MODEL_TESTING##') {
        setCurrent(`Test de ${formatModelName(args[0])}…`)
      } else if (marker === '##MODEL_DONE##') {
        upsert({ model: args[0], status: 'done', correct: Number(args[1]), total: Number(args[2]) })
      } else if (marker === '##MODEL_SKIPPED##') {
        upsert({ model: args[0], status: 'skipped' })
      }
    })
  }, [phase])

  if (!models) return null
  if (!models.length && phase === 'idle') {
    return <p className="capacity-scan__status">Tous les modèles de Jaris ont un score.</p>
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
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err))
      setPhase('error')
    }
  }

  return (
    <div className="options-menu__unscored">
      <p className="options-menu__unscored-title">
        Modèles sans score ({models.length}) : {models.map(formatModelName).join(', ')}
      </p>
      <p className="options-menu__unscored-text">
        Jaris ne choisit jamais un modèle sans score. Le test ne concerne que ces modèles, pas les autres.
      </p>

      {phase === 'idle' && (
        <button className="options-menu__action" onClick={() => setPhase('confirming')}>
          Tester les modèles sans score
        </button>
      )}

      {phase === 'confirming' && (
        <div className="options-menu__unscored-confirm">
          <p>
            Chaque modèle est téléchargé, testé (17 questions, ou 3 applications pour un modèle de code), puis
            supprimé. Les gros modèles débordent sur la RAM : compte environ une heure, et ferme les jeux et
            logiciels lourds pendant le test. Un modèle trop gros pour ton PC est sauté.
          </p>
          <div className="options-menu__unscored-actions">
            <button className="options-menu__action" onClick={() => void run()}>
              Lancer le test
            </button>
            <button className="options-menu__action" onClick={() => setPhase('idle')}>
              Annuler
            </button>
          </div>
        </div>
      )}

      {(phase === 'running' || phase === 'done' || phase === 'error') && (
        <div className="options-menu__progress">
          <div className="options-menu__progress-label">
            {phase === 'running' ? current : phase === 'done' ? 'Test terminé.' : 'Test interrompu.'}
          </div>
          <div className="options-menu__progress-bar">
            <div className="options-menu__progress-bar-fill" style={{ width: `${percent}%` }} />
          </div>
          {rows.length > 0 && (
            <ul className="options-menu__unscored-results">
              {rows.map((row) => (
                <li key={row.model}>
                  {formatModelName(row.model)} :{' '}
                  {row.status === 'done' ? `${row.correct}/${row.total}` : 'sauté (trop gros ou téléchargement impossible)'}
                </li>
              ))}
            </ul>
          )}
          {phase === 'error' && error && <p className="options-menu__error">{error}</p>}
          {phase !== 'running' && (
            <div className="options-menu__unscored-actions">
              <button className="options-menu__action" onClick={() => void window.jaris.showUnscoredResults()}>
                Ouvrir le fichier des résultats
              </button>
              {phase === 'error' && (
                <button className="options-menu__action" onClick={() => void run()}>
                  Reprendre le test
                </button>
              )}
            </div>
          )}
          {phase === 'done' && (
            <p className="options-menu__unscored-text">
              Envoie le fichier benchmark-nouveaux-modeles.md pour que les scores soient ajoutés à Jaris.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
