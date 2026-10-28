import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ModelCategory, ModelOverviewEntry, ModelOverviewResult } from '../../shared/ipc'
import { formatModelName } from '../lib/formatModelName'
import { ReliabilityBadge } from './OptionsMenu'
import UnscoredModelsTest from './UnscoredModelsTest'
import { formatIntelligenceIndex } from '../lib/formatIntelligenceIndex'
import { filterModels } from '../lib/filterModels'
import { formatDecimal, formatPercent, t } from '@/lib/i18n'
import type { MessageKey } from '../../shared/i18n'
import { FUTURE_MODELS } from '../../shared/futureModels'
import { shownSpeed } from '../lib/shownSpeed'

const SPEED_KIND_LABELS: Record<'measured' | 'estimated' | 'published', MessageKey> = {
  measured: 'speed.kind.measured',
  estimated: 'speed.kind.estimated',
  published: 'speed.kind.published'
}

/**
 * Étape 210 : mêmes mots que le choix du modèle dans le Chat et le Vocal (Faible · Moyen · Élevé). La catégorie
 * interne (hardwareScan.ts) garde ses valeurs : seul l'affichage change.
 */
const CATEGORY_LABELS: Record<ModelCategory, MessageKey> = { Rapide: 'role.flash', Moyen: 'role.medium', Puissant: 'role.large' }

/**
 * Léo : "dans model ajoute un bouton en dessous de tout les palier, tout les model et met tout les model
 * qu'on a utiliser met le score apelle outil la vram necessaire pour le model, et un score d'intelligence externe"
 * — la liste COMPLÈTE de tous les modèles candidats de Jaris (tous paliers confondus), pas seulement celui
 * réellement choisi pour la machine de l'utilisateur (déjà visible dans les paliers juste au-dessus).
 *
 * Données : `getModelOverview` (hardwareScan.ts).
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
 * Plus d'analyse complète (retirée à l'étape 166, comme convenu avec Léo) : son analyse du 25/09/2026 est
 * recopiée dans scripts/verified-tool-scores.md, seule source des scores affichés ici. Seuls les modèles SANS
 * score peuvent encore être testés (UnscoredModelsTest, étape 168).
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
 * lignes), sur 4 colonnes déjà affichées : VRAM, appel d'outils, Intelligence, Vitesse. Un seul tableau depuis
 * l'étape 160 (tous les modèles au même endroit), donc un seul état de tri. Cliquer une deuxième fois sur la
 * même colonne inverse le sens ; changer de colonne repart d'un sens de lecture "utile" par défaut — VRAM
 * repart croissante (Léo : "de la moin de vram a la plus"), les 3 autres repartent décroissantes ("le
 * plus" rapide/intelligent/appelle outils, la meilleure valeur en tête). Une valeur absente (`null`, "Non
 * publié"/"—") retombe TOUJOURS en fin de liste, quel que soit le sens du tri — sinon un tri décroissant sur
 * "Intelligence" ferait remonter en tête tous les modèles jamais évalués par Artificial Analysis, l'inverse
 * de ce qu'on cherche à voir.
 */
/**
 * Étape 329, Léo (« il y a pas écrit le score Terminal-Bench ») : les deux mesures d'Artificial Analysis qui
 * comptent dans le choix depuis l'étape 328 ont leur colonne — Omniscience (« n'invente pas », Faible/Moyen/Élevé)
 * et Terminal-Bench 2.1 (Code) —, triables comme les autres, du meilleur au moins bon au premier clic.
 */
type SortKey = 'vramGb' | 'toolCalling' | 'demands' | 'artificialAnalysisIndex' | 'omniscience' | 'terminalBench' | 'artificialAnalysisSpeed'
type SortState = { key: SortKey; dir: 'asc' | 'desc' } | null

/** Sens de lecture "utile" au premier clic sur chaque colonne : VRAM du plus léger au plus lourd, les 3
 * autres du meilleur au moins bon (Léo : "le plus rapide, le plus inteligent, le plus appelle outils"). */
const DEFAULT_SORT_DIR: Record<SortKey, 'asc' | 'desc'> = {
  vramGb: 'asc',
  toolCalling: 'desc',
  demands: 'desc',
  artificialAnalysisIndex: 'desc',
  omniscience: 'desc',
  terminalBench: 'desc',
  artificialAnalysisSpeed: 'desc'
}

const SORT_LABELS: Record<SortKey, MessageKey> = {
  vramGb: 'models.sort.vram',
  toolCalling: 'models.sort.tools',
  demands: 'models.sort.demands',
  artificialAnalysisIndex: 'models.sort.intelligence',
  omniscience: 'models.sort.omniscience',
  terminalBench: 'models.sort.terminalBench',
  artificialAnalysisSpeed: 'models.sort.speed'
}

/** Libellés COURTS pour la barre "Trier par" (étape 129) : les titres de colonne complets ci-dessus
 * ("Intelligence (Artificial Analysis)") sont bien trop longs pour tenir en pastilles sur une seule ligne. */
const SORT_CHIP_LABELS: Record<SortKey, MessageKey> = {
  vramGb: 'models.chip.vram',
  toolCalling: 'models.sort.tools',
  demands: 'options.score.requests',
  artificialAnalysisIndex: 'models.chip.intelligence',
  omniscience: 'models.chip.omniscience',
  terminalBench: 'models.chip.terminalBench',
  artificialAnalysisSpeed: 'models.chip.speed'
}

const SORT_KEYS: SortKey[] = ['vramGb', 'toolCalling', 'demands', 'artificialAnalysisIndex', 'omniscience', 'terminalBench', 'artificialAnalysisSpeed']

/**
 * "6/6" -> 1, "2/3" -> 0,67, absent ou illisible -> null (toujours en fin de tri, jamais confondu avec un vrai
 * 0). En proportion depuis l'étape 160 : la liste unique mélange des tests sur 6 (conversation) et sur 3
 * (code, vision) — en nombre brut, un 5/6 serait passé devant un 3/3 parfait.
 */
function toolScoreValue(toolCalling: string | null): number | null {
  if (!toolCalling) return null
  const [correct, total] = toolCalling.split('/').map(Number)
  if (!Number.isFinite(correct)) return null
  return Number.isFinite(total) && total > 0 ? correct / total : correct
}

/**
 * Étape 367 : vitesse sur CE PC. « ≈ » devant une vitesse estimée (modèle jamais lancé ici) ; l'infobulle dit d'où
 * vient le chiffre (mesurée sur ton PC, estimée, ou publiée tant que rien n'a été mesuré).
 */
function SpeedCell({ entry }: { entry: ModelOverviewEntry }) {
  const speed = shownSpeed(entry)
  if (speed.value === null) return <td className="options-menu__col-num">—</td>
  return (
    <td className="options-menu__col-num" title={speed.kind ? t(SPEED_KIND_LABELS[speed.kind]) : undefined}>
      {speed.kind === 'estimated' ? '≈ ' : ''}
      {formatDecimal(speed.value)}
    </td>
  )
}

function sortValue(entry: ModelOverviewEntry, key: SortKey): number | null {
  if (key === 'toolCalling') return toolScoreValue(entry.toolCalling)
  if (key === 'demands') return toolScoreValue(entry.demands ?? null)
  // `?? null` : une mesure absente (y compris d'une réponse plus ancienne sans ce champ) reste toujours en fin de liste.
  if (key === 'artificialAnalysisSpeed') return shownSpeed(entry).value
  return entry[key] ?? null
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
      {t(SORT_LABELS[sortKey])}
      {/* Indicateur TOUJOURS présent (↕ au repos), jamais seulement une fois la colonne active : sans lui,
          un titre cliquable est indiscernable d'un titre normal — c'est très exactement ce que Léo n'a pas
          vu ("je voit pas de truc pour filtrés"). */}
      <span className="options-menu__sort-arrow">{active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ' ↕'}</span>
    </button>
  )
}

/**
 * Barre "Trier par" visible AU-DESSUS des tableaux (étape 129) — la vraie réponse à "je voit pas de truc
 * pour filtrés" : des pastilles évidemment cliquables, dans la famille visuelle déjà utilisée par les
 * onglets d'Options (`.options-menu__tab`, fond cyan translucide quand actif), plutôt qu'un titre de colonne
 * qui ressemble à du texte mort. "Par défaut" ramène à l'ordre d'origine (par VRAM croissante, celui que
 * renvoie déjà getModelOverview) sans avoir à deviner quel sens de tri annule quoi.
 */
function SortBar({
  sort,
  onSort,
  onReset,
  query,
  onQuery
}: {
  sort: SortState
  onSort: (key: SortKey) => void
  onReset: () => void
  query: string
  onQuery: (query: string) => void
}): JSX.Element {
  return (
    <div className="options-menu__sort-bar">
      {/* Étape 226 : la recherche se range dans la même barre que les tris, à leur gauche. */}
      <input
        type="search"
        className="options-menu__model-search"
        placeholder={t('models.search')}
        aria-label={t('models.search')}
        value={query}
        onChange={(event) => onQuery(event.target.value)}
      />
      <span className="options-menu__sort-bar-label">{t('models.sortBy')}</span>
      {SORT_KEYS.map((key) => {
        const active = sort?.key === key
        return (
          <button
            key={key}
            type="button"
            className={`options-menu__sort-chip${active ? ' options-menu__sort-chip--active' : ''}`}
            onClick={() => onSort(key)}
            aria-pressed={active}
          >
            {t(SORT_CHIP_LABELS[key])}
            {active && <span className="options-menu__sort-arrow">{sort.dir === 'asc' ? ' ▲' : ' ▼'}</span>}
          </button>
        )
      })}
      <button
        type="button"
        className={`options-menu__sort-chip${sort === null ? ' options-menu__sort-chip--active' : ''}`}
        onClick={onReset}
        aria-pressed={sort === null}
      >
        {t('models.sort.default')}
      </button>
    </div>
  )
}

export default function AllModelsOverview(): JSX.Element {
  const [open, setOpen] = useState(false)
  const [overview, setOverview] = useState<ModelOverviewResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [sort, setSort] = useState<SortState>(null)
  const [query, setQuery] = useState('')

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

  const sortedEntries = useMemo(
    () => (overview ? sortEntries(filterModels(overview.entries, query), sort) : null),
    [overview, sort, query]
  )
  // Étape 341 : les futurs modèles restent en bas, quel que soit le tri, mais suivent la recherche.
  const futureEntries = useMemo(() => filterModels(FUTURE_MODELS, query), [query])

  return (
    <div className="options-menu__all-models">
      <button className="options-menu__action" onClick={() => void openPage()}>
        {t('models.all')}
      </button>
      {open &&
        createPortal(
          <div className="options-page options-page--models" role="dialog" aria-modal="true" aria-label={t('models.all.label')}>
            <header className="options-page__header">
              <div>
                <h2>{t('models.all')}</h2>
              </div>
              <button className="options-page__close" onClick={() => setOpen(false)}>
                {t('common.close')}
              </button>
            </header>
            <div className="options-page__body options-page__body--models">
              <main className="options-page__workspace">
                <div className="options-page__content">
                  <div className="options-page__tab-header">
                    <h3>{t('models.candidates')}</h3>
                    <p>{t('models.candidates.hint')}</p>
                  </div>
                  {loading && <p className="capacity-scan__status">{t('common.loading')}</p>}

                  {overview && <UnscoredModelsTest />}
                  {overview && (
                    <SortBar sort={sort} onSort={toggleSort} onReset={() => setSort(null)} query={query} onQuery={setQuery} />
                  )}
                  {sortedEntries && sortedEntries.length === 0 && futureEntries.length === 0 && (
                    <p className="options-menu__model-search-empty">{t('models.search.none', { query: query.trim() })}</p>
                  )}
                  {/* Étape 160 : UN seul tableau. Chaque rôle de Jaris cherche dans tous les modèles ; la colonne
                      Catégorie n'est qu'un repère pour lire la liste, jamais un critère de choix. */}
                  {sortedEntries && sortedEntries.length + futureEntries.length > 0 && (
                    <div className="options-menu__model-overview-scroll">
                      <div className="options-menu__model-group">
                        <table className="options-menu__model-overview">
                          <thead>
                            <tr>
                              <th>{t('models.col.model')}</th>
                              <th>{t('models.col.category')}</th>
                              <th>{t('models.col.used')}</th>
                              <th className="options-menu__col-num">
                                <SortButton sortKey="vramGb" sort={sort} onSort={toggleSort} />
                              </th>
                              <th className="options-menu__col-num">
                                <SortButton sortKey="toolCalling" sort={sort} onSort={toggleSort} />
                              </th>
                              {/* Étape 243 : les 48 vraies demandes de bout en bout, à côté des questions isolées. */}
                              <th className="options-menu__col-num" title={t('models.col.demands.title')}>
                                <SortButton sortKey="demands" sort={sort} onSort={toggleSort} />
                              </th>
                              {/* Intelligence Index lu directement chez Artificial Analysis. */}
                              <th className="options-menu__col-num" title="Artificial Analysis Intelligence Index v4.3.2">
                                <SortButton sortKey="artificialAnalysisIndex" sort={sort} onSort={toggleSort} />
                              </th>
                              {/* Étape 329 : les deux mesures qui comptent dans le choix depuis l'étape 328. */}
                              <th className="options-menu__col-num" title={t('picks.omniscience.title')}>
                                <SortButton sortKey="omniscience" sort={sort} onSort={toggleSort} />
                              </th>
                              <th className="options-menu__col-num" title={t('picks.terminalBench.title')}>
                                <SortButton sortKey="terminalBench" sort={sort} onSort={toggleSort} />
                              </th>
                              <th className="options-menu__col-num" title={t('models.col.speed.title')}>
                                <SortButton sortKey="artificialAnalysisSpeed" sort={sort} onSort={toggleSort} />
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {sortedEntries.map((entry) => (
                              <tr key={entry.model}>
                                <td className="options-menu__model-name" title={entry.model}>
                                  {formatModelName(entry.model, { quant: false })}
                                  {/* Étape 331 : la version compressée réellement téléchargée, pour tous les modèles. */}
                                  {entry.quantization && (
                                    <span className="options-menu__quant" title={t('models.quant.title')}>
                                      {entry.quantization}
                                    </span>
                                  )}
                                </td>
                                <td>
                                  {entry.category ? t(CATEGORY_LABELS[entry.category]) : '—'}
                                  {entry.readsImages ? ` · ${t('models.readsImages')}` : ''}
                                </td>
                                <td>{entry.usedIn?.length ? t('models.usedIn', { roles: entry.usedIn.join(', ') }) : t('common.no')}</td>
                                <td className="options-menu__col-num">{t('unit.gb', { value: formatDecimal(entry.vramGb) })}</td>
                                <td className="options-menu__col-num">
                                  <ReliabilityBadge value={entry.toolCalling} />
                                </td>
                                <td className="options-menu__col-num">
                                  <ReliabilityBadge value={entry.demands ?? null} />
                                </td>
                                <td className="options-menu__col-num">{entry.artificialAnalysisIndex === null ? t('models.notPublished') : formatIntelligenceIndex(entry.artificialAnalysisIndex)}</td>
                                <td className="options-menu__col-num">{entry.omniscience == null ? '—' : formatDecimal(entry.omniscience)}</td>
                                <td className="options-menu__col-num">{entry.terminalBench == null ? '—' : formatPercent(entry.terminalBench / 100)}</td>
                                <SpeedCell entry={entry} />
                              </tr>
                            ))}
                            {futureEntries.map((entry) => (
                              <tr key={entry.model} className="options-menu__model-row--future" title={t('models.future.title')}>
                                <td className="options-menu__model-name" title={entry.model}>
                                  {formatModelName(entry.model, { quant: false })}
                                  <span className="options-menu__quant" title={t('models.quant.title')}>
                                    {entry.quantization}
                                  </span>
                                </td>
                                <td>
                                  <span className="options-menu__future-badge">{t('models.future')}</span>
                                  {entry.readsImages ? ` · ${t('models.readsImages')}` : ''}
                                </td>
                                <td>{t('common.no')}</td>
                                <td className="options-menu__col-num">{t('unit.gb', { value: formatDecimal(entry.vramGb) })}</td>
                                <td className="options-menu__col-num">
                                  <ReliabilityBadge value={null} />
                                </td>
                                <td className="options-menu__col-num">
                                  <ReliabilityBadge value={null} />
                                </td>
                                <td className="options-menu__col-num">{t('models.notPublished')}</td>
                                <td className="options-menu__col-num">—</td>
                                <td className="options-menu__col-num">—</td>
                                <td className="options-menu__col-num">—</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
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
