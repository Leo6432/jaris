import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ModelOverviewEntry, ModelOverviewResult } from '../../shared/ipc'
import { formatModelName } from '../lib/formatModelName'
import { ReliabilityBadge } from './OptionsMenu'

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
 * Colonnes Intelligence/Vitesse (Artificial Analysis) : une VERSION ÉDITABLE directement dans le tableau a
 * existé brièvement (étape 122, système de correction manuelle par Léo, persistée dans un fichier propre à
 * sa machine) puis a été RETIRÉE le même jour, à sa demande explicite ("j'ai commencer a remplir, tu peut
 * les noter et enleve la possibilité de noter") : une fois la recherche terminée pour tous les modèles
 * (ARTIFICIAL_ANALYSIS_INTELLIGENCE_INDEX/ARTIFICIAL_ANALYSIS_SPEED, hardwareScan.ts, vérifiées un par un
 * sur artificialanalysis.ai plutôt que devinées), il a préféré un tableau à nouveau simple à lire plutôt que
 * de garder la possibilité de le modifier lui-même. Les deux colonnes redeviennent donc un simple texte en
 * lecture seule, comme le reste du tableau.
 *
 * Étape 128, Léo : "ajoute pouvoir filtrer les models par la ram, par de la moin de vram a la plus, le plus
 * rapide, le plus inteligent, le plus appelle outils" — en réalité un TRI (pas un filtre qui masquerait des
 * lignes), sur 4 colonnes déjà affichées : VRAM, appel d'outils, Intelligence, Vitesse. Un SEUL état de tri
 * partagé par les 5 tableaux (un par palier) : cliquer "VRAM nécessaire" trie chacun des 5 en même temps,
 * plutôt que 5 états indépendants à gérer un par un pour une même colonne. Cliquer une deuxième fois sur la
 * même colonne inverse le sens ; changer de colonne repart d'un sens de lecture "utile" par défaut — VRAM
 * repart croissante (Léo : "de la moin de vram a la plus"), les 3 autres repartent décroissantes ("le
 * plus" rapide/intelligent/appelle outils, la meilleure valeur en tête). Une valeur absente (`null`, "Non
 * publié"/"—") retombe TOUJOURS en fin de liste, quel que soit le sens du tri — sinon un tri décroissant sur
 * "Intelligence" ferait remonter en tête tous les modèles jamais évalués par Artificial Analysis, l'inverse
 * de ce qu'on cherche à voir.
 */
type SortKey = 'vramGb' | 'toolCalling' | 'artificialAnalysisIndex' | 'artificialAnalysisSpeed'
type SortState = { key: SortKey; dir: 'asc' | 'desc' } | null

/** Sens de lecture "utile" au premier clic sur chaque colonne : VRAM du plus léger au plus lourd, les 3
 * autres du meilleur au moins bon (Léo : "le plus rapide, le plus inteligent, le plus appelle outils"). */
const DEFAULT_SORT_DIR: Record<SortKey, 'asc' | 'desc'> = {
  vramGb: 'asc',
  toolCalling: 'desc',
  artificialAnalysisIndex: 'desc',
  artificialAnalysisSpeed: 'desc'
}

const SORT_LABELS: Record<SortKey, string> = {
  vramGb: 'VRAM nécessaire',
  toolCalling: "Appel d'outils",
  artificialAnalysisIndex: 'Intelligence (Artificial Analysis)',
  artificialAnalysisSpeed: 'Vitesse (Artificial Analysis)'
}

/** "6/6"/"2/3" -> 6/2, absent ou illisible -> null (toujours en fin de tri, jamais confondu avec un vrai 0). */
function toolScoreValue(toolCalling: string | null): number | null {
  if (!toolCalling) return null
  const correct = Number(toolCalling.split('/')[0])
  return Number.isFinite(correct) ? correct : null
}

function sortValue(entry: ModelOverviewEntry, key: SortKey): number | null {
  if (key === 'toolCalling') return toolScoreValue(entry.toolCalling)
  return entry[key]
}

function sortEntries(entries: ModelOverviewEntry[], sort: SortState): ModelOverviewEntry[] {
  if (!sort) return entries
  const sign = sort.dir === 'asc' ? 1 : -1
  return [...entries].sort((a, b) => {
    const va = sortValue(a, sort.key)
    const vb = sortValue(b, sort.key)
    // Une valeur absente reste toujours en fin de liste, dans les deux sens de tri.
    if (va === null && vb === null) return 0
    if (va === null) return 1
    if (vb === null) return -1
    return (va - vb) * sign
  })
}

function SortButton({ sortKey, sort, onSort }: { sortKey: SortKey; sort: SortState; onSort: (key: SortKey) => void }): JSX.Element {
  const active = sort?.key === sortKey
  return (
    <button type="button" className="options-menu__sort-button" onClick={() => onSort(sortKey)} aria-pressed={active}>
      {SORT_LABELS[sortKey]}
      {active && <span className="options-menu__sort-arrow">{sort.dir === 'asc' ? ' ▲' : ' ▼'}</span>}
    </button>
  )
}

export default function AllModelsOverview(): JSX.Element {
  const [open, setOpen] = useState(false)
  const [overview, setOverview] = useState<ModelOverviewResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [sort, setSort] = useState<SortState>(null)

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

  const toggleSort = (key: SortKey): void => {
    setSort((current) => {
      if (current?.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
      return { key, dir: DEFAULT_SORT_DIR[key] }
    })
  }

  const sortedGroups = useMemo(
    () => overview?.groups.map((group) => ({ ...group, entries: sortEntries(group.entries, sort) })) ?? null,
    [overview, sort]
  )

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
                      pour ta machine, déjà visible dans le tableau des paliers. Clique sur un titre de colonne
                      pour trier.
                    </p>
                  </div>
                  {loading && <p className="capacity-scan__status">Chargement...</p>}
                  {sortedGroups && (
                    <div className="options-menu__model-overview-scroll">
                      {sortedGroups.map((group) => (
                        <div key={group.tier} className="options-menu__model-group">
                          <div className="options-menu__model-group-title">{group.tier}</div>
                          <table className="options-menu__model-overview">
                            <thead>
                              <tr>
                                <th>Modèle</th>
                                <th>Utilisé par Jaris</th>
                                <th className="options-menu__col-num">
                                  <SortButton sortKey="vramGb" sort={sort} onSort={toggleSort} />
                                </th>
                                <th className="options-menu__col-num">
                                  <SortButton sortKey="toolCalling" sort={sort} onSort={toggleSort} />
                                </th>
                                {/* Intelligence Index lu directement chez Artificial Analysis. */}
                                <th className="options-menu__col-num" title="Artificial Analysis Intelligence Index v4.3.2">
                                  <SortButton sortKey="artificialAnalysisIndex" sort={sort} onSort={toggleSort} />
                                </th>
                                <th
                                  className="options-menu__col-num"
                                  title="Vitesse de génération publiée par Artificial Analysis (tokens/s)"
                                >
                                  <SortButton sortKey="artificialAnalysisSpeed" sort={sort} onSort={toggleSort} />
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
                                  <td className="options-menu__col-num">{entry.artificialAnalysisIndex ?? 'Non publié'}</td>
                                  <td className="options-menu__col-num">{entry.artificialAnalysisSpeed ?? '—'}</td>
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
