import { Fragment, useState } from 'react'
import type { ModelOverviewEntry, MyModelPicks as MyModelPicksData } from '../../shared/ipc'
import { formatModelName } from '../lib/formatModelName'
import { ReliabilityBadge, scoreTestLabel } from './OptionsMenu'
import { formatIntelligenceIndex } from '../lib/formatIntelligenceIndex'
import { PILOT_MODEL_LABEL } from '../../shared/pilotModel'
import { formatDecimal, t } from '@/lib/i18n'
import type { MessageKey } from '../../shared/i18n'

interface MyModelPicksProps {
  picks: MyModelPicksData
  /** Avant la toute première installation (écran d'accueil), rien n'est encore "utilisé" : "choisis". */
  title?: string
  /** Suppression d'un modèle installé mais inutilisé (Options uniquement ; absent = pas de bouton). */
  onDeleteUnused?: (model: string) => Promise<void>
  /**
   * Écran d'installation (étape 234, bêta) : rien n'est encore téléchargé, c'est normal. Sans ce mode, chaque
   * ligne disait en rouge « Pas installé — clique « Retester la configuration » », un bouton qu'un nouvel
   * utilisateur ne voit pas, alors que l'installation se fait justement au clic sur « Continuer ».
   */
  beforeInstall?: boolean
}

/** Cellule sans valeur (« — » ou vide) : masquée quand la carte passe sur deux lignes par rôle (index.css). */
const EMPTY = ' capacity-scan__tier-empty'

/** Rôles dont le choix tient compte des demandes complètes (étape 241). */
const CONVERSATION_ROLES = new Set(['flash', 'medium', 'large'])

const ROLES: { key: 'flash' | 'medium' | 'large' | 'vision' | 'code'; label: MessageKey }[] = [
  { key: 'flash', label: 'role.flash' },
  { key: 'medium', label: 'role.medium' },
  { key: 'large', label: 'role.large' },
  { key: 'vision', label: 'role.vision' },
  { key: 'code', label: 'app.mode.code' }
]

/** Vitesse publiée par Artificial Analysis (étape 131) — mesurée sur leur matériel, pas sur cette machine. */
function formatSpeed(entry: ModelOverviewEntry): string {
  return entry.artificialAnalysisSpeed === null ? '—' : `${entry.artificialAnalysisSpeed} tok/s`
}

/** Libellé collé à la valeur : ce tableau n'a pas d'en-tête, un nombre nu serait incompréhensible (étape 130). */
function formatIntelligence(entry: ModelOverviewEntry): string {
  return entry.artificialAnalysisIndex === null ? '—' : t('picks.intelligence', { value: formatIntelligenceIndex(entry.artificialAnalysisIndex) })
}

/** "RTX 3070 · 8 Go de VRAM · 32 Go de RAM" — seulement ce qui a vraiment été détecté, jamais inventé. */
export function formatHardware(picks: MyModelPicksData): string {
  const parts = [picks.gpuName ?? t('picks.noGpu')]
  if (picks.vramGb !== null) parts.push(t('picks.vram', { gb: formatDecimal(picks.vramGb) }))
  // Arrondi : la RAM détectée arrive en Go fractionnaires (« 63.161624908447266 Go », capture de Léo).
  parts.push(t('picks.ram', { gb: Math.round(picks.ramGb) }))
  return parts.join(' · ')
}

/**
 * Étape 137, Léo : "a la place de plalier 1 2 3 on vas faire un palier personnaliser a chacun, il ya plus de
 * palier jaris regarde la vram les apelle outils Intelligence (Artificial Analysis) et choisit le meilleur
 * model pour rapide etc...". Remplace HardwareTierPreview (une dizaine de paliers de comparaison reliés par
 * des flèches, la machine repérée parmi eux) par UNE seule carte : le matériel détecté et, pour chaque rôle, le
 * modèle que Jaris a choisi pour lui — dans l'ordre fiabilité d'appel d'outils, puis Intelligence Artificial
 * Analysis, puis taille (pickBestFrom, hardwareScan.ts). Partagée entre l'écran d'accueil (CapacityScan.tsx)
 * et Options → Modèles, comme l'ancienne.
 */
export default function MyModelPicks({ picks, title = t('picks.title'), onDeleteUnused, beforeInstall = false }: MyModelPicksProps): JSX.Element {
  const [confirming, setConfirming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const check = beforeInstall ? undefined : picks.installCheck
  const remove = async (model: string): Promise<void> => {
    if (!onDeleteUnused) return
    setDeleting(model)
    setDeleteError(null)
    try {
      await onDeleteUnused(model)
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err))
    } finally {
      setDeleting(null)
      setConfirming(null)
    }
  }
  return (
    <div className="capacity-scan__tiers">
      <div className="capacity-scan__tier capacity-scan__tier--current">
        <div className="capacity-scan__tier-header">
          <span className="capacity-scan__tier-label">{title}</span>
          <span className="capacity-scan__tier-hardware">{formatHardware(picks)}</span>
        </div>
        <table className="capacity-scan__tier-table">
          <tbody>
            {ROLES.map(({ key, label }) => {
              const entry = picks[key]
              const upgrade = picks.upgrades[key]
              const missing = check?.notInstalled.includes(key) ?? false
              return (
                <Fragment key={key}>
                  <tr>
                    <td className="capacity-scan__tier-slot">{t(label)}</td>
                    <td className="capacity-scan__tier-model" title={entry.model}>
                      {formatModelName(entry.model)}
                    </td>
                    {/* « — » si rien n'est publié : aligné en colonne dans le tableau large, masqué quand la carte passe sur
                        deux lignes par rôle (il n'y a plus de colonne pour lui donner un sens, voir index.css). */}
                    <td
                      className={`capacity-scan__tier-speed${entry.artificialAnalysisSpeed === null ? EMPTY : ''}`}
                      title={t('picks.speed.title')}
                    >
                      {formatSpeed(entry)}
                    </td>
                    <td
                      className={`capacity-scan__tier-intelligence${entry.artificialAnalysisIndex === null ? EMPTY : ''}`}
                      title="Artificial Analysis Intelligence Index v4.3.2"
                    >
                      {formatIntelligence(entry)}
                    </td>
                    {/* Étape 243, Léo : « il y a seulement les questions visibles et pas le score de demandes ». Les
                        demandes comptent pour Faible, Moyen et Élevé seulement : elles ne s'affichent que là. */}
                    <td className="capacity-scan__tier-scores">
                      <ReliabilityBadge value={entry.toolCalling} label={scoreTestLabel(entry.toolCalling)} />
                      {CONVERSATION_ROLES.has(key) && <ReliabilityBadge value={entry.demands ?? null} label={t('options.score.requests')} />}
                    </td>
                  </tr>
                  {/* Étape 138 : la ligne ci-dessus est le modèle RÉELLEMENT utilisé. Quand le meilleur choix
                      est un autre, on le dit ici avec la raison — plus jamais un modèle affiché mais pas utilisé. */}
                  {/* Étape 140 : vérifié auprès d'Ollama — un modèle affiché mais absent du disque est signalé. */}
                  {missing && (
                    <tr className="capacity-scan__tier-upgrade capacity-scan__tier-missing">
                      <td />
                      <td colSpan={4}>{t('picks.notInstalled')}</td>
                    </tr>
                  )}
                  {upgrade && (
                    <tr className="capacity-scan__tier-upgrade">
                      <td />
                      <td colSpan={4}>
                        {upgrade.blockedReason
                          ? t('picks.upgrade.blocked', { model: formatModelName(upgrade.model), reason: upgrade.blockedReason })
                          : t('picks.upgrade.available', { model: formatModelName(upgrade.model) })}
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
            {/* Étape 174, Léo : « dans model ajoute image et met le seul image, et si pas assez de puissance met
                aucun model ». Pas de vitesse/intelligence/fiabilité : ces mesures ne concernent que les modèles
                de texte, un « — » vaut mieux qu'un chiffre qui ne veut rien dire ici. */}
            {picks.image && (
              <>
                <tr className="capacity-scan__tier-image">
                  <td className="capacity-scan__tier-slot">{t('app.mode.image')}</td>
                  <td className="capacity-scan__tier-model">{picks.image.model ?? t('picks.noModel')}</td>
                  <td className={`capacity-scan__tier-speed${EMPTY}`}>—</td>
                  <td className={`capacity-scan__tier-intelligence${EMPTY}`}>—</td>
                  <td className={EMPTY.trim()} />
                </tr>
                {!picks.image.model ? (
                  <tr className="capacity-scan__tier-upgrade capacity-scan__tier-missing">
                    <td />
                    <td colSpan={4}>{t('picks.image.notCapable', { reason: picks.image.reason ?? '' })}</td>
                  </tr>
                ) : (
                  !beforeInstall && picks.image.installed === false && (
                    <tr className="capacity-scan__tier-upgrade capacity-scan__tier-missing">
                      <td />
                      <td colSpan={4}>{t('picks.notInstalled.size', { gb: 5 })}</td>
                    </tr>
                  )
                )}
              </>
            )}
            {/* 04/10/2026, Léo : « ajoute vidéo et le modèle vidéo ». Comme Image : pas de vitesse ni d'intelligence. */}
            {picks.video && (
              <>
                <tr className="capacity-scan__tier-image capacity-scan__tier-video">
                  <td className="capacity-scan__tier-slot">{t('app.mode.video')}</td>
                  <td className="capacity-scan__tier-model">
                    {picks.video.model ? t('picks.video.model', { model: picks.video.model, quality: picks.video.qualityLabel ?? '' }) : t('picks.noModel')}
                  </td>
                  <td className={`capacity-scan__tier-speed${EMPTY}`}>—</td>
                  <td className={`capacity-scan__tier-intelligence${EMPTY}`}>—</td>
                  <td className={EMPTY.trim()} />
                </tr>
                {!picks.video.model ? (
                  <tr className="capacity-scan__tier-upgrade capacity-scan__tier-missing">
                    <td />
                    <td colSpan={4}>{t('picks.video.notCapable', { reason: picks.video.reason ?? '' })}</td>
                  </tr>
                ) : (
                  !beforeInstall && picks.video.installed === false && (
                    <tr className="capacity-scan__tier-upgrade capacity-scan__tier-missing">
                      <td />
                      <td colSpan={4}>{t('picks.video.notInstalled')}</td>
                    </tr>
                  )
                )}
              </>
            )}
            {/* Étape 231, Léo : « comme image vidéo le mettre seul, si l'utilisateur n'a pas assez on met pas le
                rôle et il fait comme maintenant ». Un seul modèle ; sans lui, le modèle de vision pilote l'écran. */}
            {picks.pilot && (
              <>
                <tr className="capacity-scan__tier-image capacity-scan__tier-pilot">
                  <td className="capacity-scan__tier-slot">{t('role.pilot')}</td>
                  <td className="capacity-scan__tier-model">{picks.pilot.model ? PILOT_MODEL_LABEL : t('picks.noModel')}</td>
                  <td className={`capacity-scan__tier-speed${EMPTY}`}>—</td>
                  <td className={`capacity-scan__tier-intelligence${EMPTY}`}>—</td>
                  <td className={EMPTY.trim()} />
                </tr>
                {!picks.pilot.model ? (
                  <tr className="capacity-scan__tier-upgrade capacity-scan__tier-missing">
                    <td />
                    <td colSpan={4}>{t('picks.pilot.notCapable', { reason: picks.pilot.reason ?? '' })}</td>
                  </tr>
                ) : (
                  !beforeInstall && picks.pilot.installed === false && (
                    <tr className="capacity-scan__tier-upgrade capacity-scan__tier-missing">
                      <td />
                      <td colSpan={4}>{t('picks.notInstalled.size', { gb: 6 })}</td>
                    </tr>
                  )
                )}
              </>
            )}
          </tbody>
        </table>
      </div>
      {/* Étape 140, Léo : "je veut etre sur que les model visbile sont réel et pas un autre model". */}
      {beforeInstall ? null : !check ? (
        <p className="capacity-scan__install-check">{t('picks.check.unavailable')}</p>
      ) : (
        <div className="capacity-scan__install-check">
          {check.notInstalled.length === 0 && <p>✓ {t('picks.check.ok')}</p>}
          {check.otherInstalled.length === 0 ? (
            <p>{t('picks.check.noOther')}</p>
          ) : (
            <>
              <p>{t('picks.check.others')}</p>
              <ul className="capacity-scan__other-models">
                {check.otherInstalled.map((model) => (
                  <li key={model}>
                    <span title={model}>{formatModelName(model)}</span>
                    {onDeleteUnused &&
                      (confirming === model ? (
                        <span className="capacity-scan__other-actions">
                          <button className="options-menu__action capacity-scan__delete-confirm" disabled={deleting === model} onClick={() => void remove(model)}>
                            {deleting === model ? t('common.deleting') : t('common.delete')}
                          </button>
                          <button className="options-menu__action" disabled={deleting === model} onClick={() => setConfirming(null)}>
                            {t('common.cancel')}
                          </button>
                        </span>
                      ) : (
                        <button className="options-menu__action" onClick={() => setConfirming(model)}>
                          {t('common.delete')}
                        </button>
                      ))}
                  </li>
                ))}
              </ul>
              {deleteError && <p className="capacity-scan__tier-missing">{deleteError}</p>}
            </>
          )}
        </div>
      )}
      <p className="capacity-scan__tier-legend">{t('picks.legend')}</p>
    </div>
  )
}
