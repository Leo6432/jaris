import { useState } from 'react'
import { createPortal } from 'react-dom'
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
 * seulement pendant un run.
 *
 * Léo, juste après avoir vu la première version : "quand on clique sur tout les models on doit ouvrire un
 * page entierement pour ça" — une simple liste dépliée EN PLACE, dans la petite carte "Ce que ta machine
 * fait tourner", tassait ~39 modèles sur 5 paliers dans le peu d'espace resté sous les paliers déjà affichés
 * juste au-dessus. Remplacé par une VRAIE page à part, sur le même principe que la page Options elle-même
 * (`createPortal`, `position: fixed; inset: 0`), empilée PAR-DESSUS elle avec un z-index plus élevé — voir
 * `.options-page--models` dans index.css — plutôt qu'un second onglet DANS Options : le bouton "Fermer"
 * revient sur la page Options exactement où elle était, sans perdre l'onglet Modèles en cours. Pas de
 * colonne de navigation à gauche comme la page Options : un seul contenu, rien à onglet ici.
 */
export default function AllModelsOverview(): JSX.Element {
  const [open, setOpen] = useState(false)
  const [overview, setOverview] = useState<ModelOverviewResult | null>(null)
  const [loading, setLoading] = useState(false)

  const openPage = async (): Promise<void> => {
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
      <button className="options-menu__action" onClick={() => void openPage()}>
        Tous les modèles
      </button>
      {open &&
        createPortal(
          <div className="options-page options-page--models" role="dialog" aria-modal="true" aria-label="Tous les modèles de Jaris">
            <header className="options-page__header">
              <div>
                <span className="options-page__eyebrow">Jaris</span>
                <h2>Tous les modèles</h2>
              </div>
              <button className="options-page__close" onClick={() => setOpen(false)}>
                Fermer
              </button>
            </header>
            <div className="options-page__body options-page__body--models">
              <main className="options-page__workspace">
                <div className="options-page__content">
                  <div className="options-page__tab-header">
                    <h3>Tous les modèles candidats</h3>
                    <p>
                      Chaque modèle que Jaris sait choisir, tous paliers confondus — pas seulement celui retenu
                      pour ta machine, déjà visible dans le tableau des paliers.
                    </p>
                  </div>
                  {loading && <p className="capacity-scan__status">Chargement...</p>}
                  {overview && (
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
                                {/* Score CanIRun.ai (site tiers, voir CANIRUN_INTELLIGENCE_INDEX dans
                                    hardwareScan.ts) : indicatif seulement, jamais utilisé pour choisir un
                                    modèle — beaucoup de "—" au moment d'écrire ceci, leur catalogue restant
                                    incomplet sur ce champ précis, même pour un modèle qu'ils cataloguent. */}
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
              </main>
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}
