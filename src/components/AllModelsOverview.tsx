import { useState } from 'react'
import type { ModelOverviewResult } from '../../shared/ipc'
import { formatModelName } from '../lib/formatModelName'
import { ReliabilityBadge } from './OptionsMenu'

/**
 * Léo : "dans model ajoute un bouton en dessous de tout les palier, tout les model et met tout les model
 * qu'on a utiliser met le score apelle outil la vram necessaire pour le model, et le score sur canirun.ai"
 * — la liste COMPLÈTE de tous les modèles candidats de Jaris (tous paliers confondus), pas seulement celui
 * réellement choisi pour la machine de l'utilisateur (déjà visible dans les paliers juste au-dessus).
 *
 * Réutilise `getModelOverview` (déjà utilisé par ModelAnalysisProgress.tsx pendant "Lancer l'analyse", voir
 * hardwareScan.ts) plutôt qu'un nouveau canal IPC : mêmes données, juste affichées en permanence au lieu de
 * seulement pendant un run. Chargé à la demande (repliée par défaut) plutôt qu'au montage de l'onglet
 * Modèles : la liste complète (tous paliers confondus) est bien plus longue que le résumé des paliers déjà
 * affiché au-dessus, pas la peine de forcer ce calcul à chaque ouverture de l'onglet.
 */
export default function AllModelsOverview(): JSX.Element {
  const [open, setOpen] = useState(false)
  const [overview, setOverview] = useState<ModelOverviewResult | null>(null)
  const [loading, setLoading] = useState(false)

  const toggle = async (): Promise<void> => {
    if (open) {
      setOpen(false)
      return
    }
    setOpen(true)
    if (overview) return
    setLoading(true)
    try {
      setOverview(await window.jaris.getModelOverview())
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="options-menu__all-models">
      <button className="options-menu__action" onClick={() => void toggle()}>
        {open ? 'Réduire' : 'Tous les modèles'}
      </button>
      {open && loading && <p className="capacity-scan__status">Chargement...</p>}
      {open && overview && (
        <div className="options-menu__model-overview-scroll">
          {overview.groups.map((group) => (
            <div key={group.tier} className="options-menu__model-group">
              <div className="options-menu__model-group-title">{group.tier}</div>
              <table className="options-menu__model-overview">
                <thead>
                  <tr>
                    <th>Modèle</th>
                    <th className="options-menu__col-num">VRAM nécessaire</th>
                    <th className="options-menu__col-num">Appel d'outils</th>
                    {/* Score CanIRun.ai (site tiers, voir CANIRUN_INTELLIGENCE_INDEX dans hardwareScan.ts) :
                        indicatif seulement, jamais utilisé pour choisir un modèle — beaucoup de "—" au
                        moment d'écrire ceci, leur catalogue restant incomplet sur ce champ précis. */}
                    <th className="options-menu__col-num">CanIRun.ai</th>
                  </tr>
                </thead>
                <tbody>
                  {group.entries.map((entry) => (
                    <tr key={entry.model}>
                      <td className="options-menu__model-name" title={entry.model}>
                        {formatModelName(entry.model)}
                      </td>
                      <td className="options-menu__col-num">{entry.vramGb} Go</td>
                      <td className="options-menu__col-num">
                        <ReliabilityBadge value={entry.toolCalling} />
                      </td>
                      <td className="options-menu__col-num">{entry.canirunIndex ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
