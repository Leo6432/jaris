import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { ModelOverviewResult } from '../../shared/ipc'
import { formatModelName } from '../lib/formatModelName'
import { ReliabilityBadge } from './OptionsMenu'

type ExternalScoreField = 'intelligence' | 'speed'

/**
 * Une case "Intelligence (Artificial Analysis)" ou "Vitesse (Artificial Analysis)", éditable directement
 * au clic — Léo : "je ne sais pas pourquoi tu a pas mis ces scores mais sur le site il ya des models que
 * tu a mis non publier, mais au pire je le fait manuelement, fait moi un petit system pour que je note moi
 * meme le score". La table figée dans le code (ARTIFICIAL_ANALYSIS_INTELLIGENCE_INDEX, hardwareScan.ts)
 * peut se tromper ou dater ; Léo a le site sous les yeux, lui.
 *
 * Non contrôlé (`defaultValue`, pas `value`) à dessein : après enregistrement, `openPage` ne refait la
 * demande qu'une seule fois par ouverture de la page (`if (overview) return`) — le composant entier se
 * démonte/remonte à chaque fermeture/réouverture de "Tous les modèles" (voir `{open && createPortal(...)}`
 * plus bas), donc `defaultValue` repart toujours d'une valeur fraîche sans jamais rester figée sur un
 * ancien chiffre.
 */
function EditableScore({
  model,
  field,
  value,
  placeholder,
  onSave
}: {
  model: string
  field: ExternalScoreField
  value: number | null
  placeholder: string
  onSave: (model: string, field: ExternalScoreField, rawValue: string) => void
}): JSX.Element {
  return (
    <input
      type="number"
      inputMode="decimal"
      className="options-menu__score-input"
      defaultValue={value ?? ''}
      placeholder={placeholder}
      onBlur={(e) => onSave(model, field, e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
    />
  )
}

/**
 * Léo : "dans model ajoute un bouton en dessous de tout les palier, tout les model et met tout les model
 * qu'on a utiliser met le score apelle outil la vram necessaire pour le model, et un score d'intelligence externe"
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
 *
 * Le bouton "Lancer l'analyse" (ajouté puis restauré dans une étape précédente) a été RETIRÉ à la demande de
 * Léo, relayant un avis de ChatGPT : "c'est pas bien pour le public" — cliquer dessus peut déclencher le
 * téléchargement de dizaines de Go de modèles et un run de plusieurs dizaines de minutes, sans le moindre
 * garde-fou pour quelqu'un qui ne sait pas ce qu'il fait (contrairement à Léo lui-même, qui sait ce qu'il
 * déclenche). `useModelAnalysis`/`ModelAnalysisProgress.tsx`/le canal IPC `runModelAnalysis` restent tous
 * intacts (aucune raison de les supprimer, juste de ne plus les exposer dans l'interface) : le chemin
 * documenté dans CLAUDE.md ("Commandes utiles", `npm run benchmark:models`) reste la façon d'obtenir ces
 * mesures, un geste délibéré depuis un terminal plutôt qu'un bouton à portée de clic dans l'app.
 *
 * Colonnes Intelligence/Vitesse (Artificial Analysis) désormais éditables (voir EditableScore ci-dessus) :
 * `setExternalScoreOverride` (IPC) écrit dans un fichier PROPRE à cette machine (externalScoresStore.ts,
 * userData — jamais commité comme verified-tool-scores.md), fusionné par hardwareScan.ts à chaque lecture
 * (une correction manuelle prime toujours sur la table figée dans le code, pour CE modèle uniquement — les
 * deux colonnes s'éditent indépendamment). "Vitesse (Artificial Analysis)" est un nouveau champ SANS aucune
 * table figée (rien n'a jamais été relevé en dur pour ce champ) : vide pour tout le monde tant que Léo ne
 * l'a pas notée lui-même, jamais un chiffre deviné.
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

  const saveScore = async (model: string, field: ExternalScoreField, rawValue: string): Promise<void> => {
    const trimmed = rawValue.trim()
    const parsed = trimmed === '' ? null : Number(trimmed)
    // Saisie invalide (rare, le clavier numérique du champ filtre déjà l'essentiel) : ignorée plutôt que
    // silencieusement remplacée par un chiffre au hasard — le champ reprendra sa vraie valeur à la
    // prochaine ouverture de la page (defaultValue non contrôlé, voir EditableScore).
    if (parsed !== null && !Number.isFinite(parsed)) return
    await window.jaris.setExternalScoreOverride(model, field, parsed)
    setOverview(await window.jaris.getModelOverview())
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
                      pour ta machine, déjà visible dans le tableau des paliers. Les colonnes Artificial
                      Analysis sont modifiables : clique dedans pour corriger ou compléter un score toi-même.
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
                                <th>Utilisé par Jaris</th>
                                <th className="options-menu__col-num">VRAM nécessaire</th>
                                <th className="options-menu__col-num">Appel d'outils</th>
                                {/* Intelligence Index lu directement chez Artificial Analysis. */}
                                <th
                                  className="options-menu__col-num"
                                  title="Artificial Analysis Intelligence Index v4.3.2 — modifiable"
                                >
                                  Intelligence (Artificial Analysis)
                                </th>
                                <th
                                  className="options-menu__col-num"
                                  title="Vitesse de génération publiée par Artificial Analysis (tokens/s) — modifiable"
                                >
                                  Vitesse (Artificial Analysis)
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {group.entries.map((entry) => (
                                <tr key={entry.model}>
                                  <td className="options-menu__model-name" title={entry.model}>
                                    {formatModelName(entry.model)}
                                  </td>
                                  <td>{entry.usedIn?.length ? `Oui — ${entry.usedIn.join(', ')}` : 'Non'}</td>
                                  <td className="options-menu__col-num">{entry.vramGb} Go</td>
                                  <td className="options-menu__col-num">
                                    <ReliabilityBadge value={entry.toolCalling} />
                                  </td>
                                  <td className="options-menu__col-num">
                                    <EditableScore
                                      model={entry.model}
                                      field="intelligence"
                                      value={entry.artificialAnalysisIndex}
                                      placeholder="Non publié"
                                      onSave={(m, f, v) => void saveScore(m, f, v)}
                                    />
                                  </td>
                                  <td className="options-menu__col-num">
                                    <EditableScore
                                      model={entry.model}
                                      field="speed"
                                      value={entry.artificialAnalysisSpeed}
                                      placeholder="—"
                                      onSave={(m, f, v) => void saveScore(m, f, v)}
                                    />
                                  </td>
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
