import { useEffect, useRef } from 'react'
import type { AnalysisScope, ModelOverviewResult } from '../../shared/ipc'
import type { ModelAnalysisState, ModelRunStatus } from '../hooks/useModelAnalysis'

/** Fait le lien entre AnalysisScope ('flash'|'medium'|...) et le libellé de palier utilisé par ModelOverviewGroup.tier (voir TIER_LABELS dans hardwareScan.ts). */
const SCOPE_TO_TIER_LABEL: Partial<Record<AnalysisScope, string>> = {
  flash: 'Rapide',
  medium: 'Médium',
  large: 'Puissant',
  vision: 'Vision',
  code: 'Code'
}

/**
 * Rappel affiché avant ET pendant tout run (onboarding et ré-analyse depuis Options → Modèles, à la demande
 * explicite de Léo) : le partager comme une seule constante plutôt que de retaper le texte à chaque endroit
 * qui l'affiche, pour ne jamais le laisser diverger d'un endroit à l'autre.
 */
export const ANALYSIS_NOTICE =
  "Pour une meilleure analyse, merci de tout fermer et de laisser l'analyse travailler pendant ce temps. " +
  'Le temps affiché est une estimation : il peut être plus court comme plus long. Merci de votre compréhension.'

/** "3 min", "1 h 20", "moins d'une minute"... à partir d'une estimation en ms. */
function formatEta(ms: number): string {
  const totalMinutes = Math.round(ms / 60000)
  if (totalMinutes < 1) return "moins d'une minute"
  if (totalMinutes < 60) return `${totalMinutes} min`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes}`
}

/** Badge d'état pour une ligne du tableau de suivi en direct (pendant un run) — voir ModelRunStatus. */
function RunStatusBadge({ status }: { status: ModelRunStatus | undefined }): JSX.Element {
  if (!status || status.kind === 'pending') {
    return <span className="options-menu__badge options-menu__badge--none">En attente</span>
  }
  if (status.kind === 'downloading') {
    return <span className="options-menu__badge options-menu__badge--mid">Téléchargement {status.percent}%</span>
  }
  if (status.kind === 'testing') {
    return <span className="options-menu__badge options-menu__badge--mid">Test en cours</span>
  }
  if (status.kind === 'skipped') {
    return <span className="options-menu__badge options-menu__badge--bad">Ignoré</span>
  }
  const level = status.total === 0 ? 'none' : status.correct === status.total ? 'good' : status.correct === 0 ? 'bad' : 'mid'
  return (
    <span className={`options-menu__badge options-menu__badge--${level}`}>
      Terminé ({status.correct}/{status.total})
    </span>
  )
}

interface ModelAnalysisProgressProps {
  state: ModelAnalysisState
  modelOverview: ModelOverviewResult | null
}

/**
 * Barre de progression + estimation de temps restant + tableau de suivi en direct de chaque modèle candidat,
 * partagés entre l'onglet Modèles (ré-analyse à la main) et l'écran d'onboarding (analyse obligatoire au
 * premier lancement) — voir useModelAnalysis pour la logique. Remplace un journal brut qui défilait en bas
 * ("enlève le panel le script") : celui-ci ne réapparaît qu'en cas d'échec, comme détail de dépannage.
 */
export default function ModelAnalysisProgress({ state, modelOverview }: ModelAnalysisProgressProps): JSX.Element {
  const { benchmarking, scope, pullCount, testCount, progressFraction, etaMs, modelRunStatus, benchmarkLog, error } = state
  const benchmarkLogRef = useRef<HTMLPreElement>(null)
  // Un run ciblé sur un seul palier n'affiche QUE ce palier dans le tableau — les 4 autres restent inertes
  // (aucune ligne ne bougera), les montrer quand même n'aiderait pas à suivre ce qui se passe réellement.
  const scopedTierLabel = SCOPE_TO_TIER_LABEL[scope]
  const visibleGroups = modelOverview?.groups.filter((g) => !scopedTierLabel || g.tier === scopedTierLabel) ?? []

  useEffect(() => {
    benchmarkLogRef.current?.scrollTo({ top: benchmarkLogRef.current.scrollHeight })
  }, [benchmarkLog])

  return (
    <>
      {benchmarking && <p className="options-menu__analysis-notice">{ANALYSIS_NOTICE}</p>}

      {benchmarking && (
        <div className="options-menu__progress">
          <div className="options-menu__progress-label">
            Analyse en cours — {Math.round(progressFraction * 100)}%
            {/* Pondéré par la vraie taille des modèles (voir ##PROGRESS## côté script), pas juste le nombre
                de modèles restants. `null` tant que le rythme récent n'est pas encore mesurable, plutôt
                qu'un chiffre inventé. */}
            {etaMs !== null && <> — temps restant estimé : {formatEta(etaMs)}</>}
          </div>
          <div className="options-menu__progress-bar">
            <div className="options-menu__progress-bar-fill" style={{ width: `${progressFraction * 100}%` }} />
          </div>
          <div className="options-menu__progress-sub">
            {pullCount && (
              <span>
                Téléchargements : {pullCount.done}/{pullCount.total}
              </span>
            )}
            {testCount && (
              <span>
                Tests : {testCount.done}/{testCount.total}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Tableau de suivi en direct plutôt qu'un journal brut : une vue d'ensemble de chaque candidat (en
          attente / en téléchargement / en cours de test / terminé / ignoré), pas un flux de texte à faire
          défiler pour deviner où en est le run. */}
      {benchmarking && visibleGroups.length > 0 && (
        <div className="options-menu__model-overview-scroll">
          {visibleGroups.map((group) => (
            <div key={group.tier} className="options-menu__model-group">
              <div className="options-menu__model-group-title">{group.tier}</div>
              <table className="options-menu__model-overview">
                <tbody>
                  {group.entries.map((entry) => (
                    <tr key={entry.model}>
                      <td className="options-menu__model-name" title={entry.model}>
                        {entry.model}
                      </td>
                      <td>
                        <RunStatusBadge status={modelRunStatus[entry.model]} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}

      {/* Journal complet gardé seulement pour le cas d'erreur (le tableau ci-dessus ne montre pas le détail
          des messages) — jamais affiché en fonctionnement normal. */}
      {!benchmarking && error && benchmarkLog.length > 0 && (
        <pre ref={benchmarkLogRef} className="options-menu__benchmark-log">
          {benchmarkLog.join('\n')}
        </pre>
      )}
    </>
  )
}
