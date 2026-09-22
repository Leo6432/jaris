import { Fragment, useState } from 'react'
import type { ModelOverviewEntry, MyModelPicks as MyModelPicksData } from '../../shared/ipc'
import { formatModelName } from '../lib/formatModelName'
import { ReliabilityBadge } from './OptionsMenu'

interface MyModelPicksProps {
  picks: MyModelPicksData
  /** Avant la toute première installation (écran d'accueil), rien n'est encore "utilisé" : "choisis". */
  title?: string
  /** Suppression d'un modèle installé mais inutilisé (Options uniquement ; absent = pas de bouton). */
  onDeleteUnused?: (model: string) => Promise<void>
}

const ROLES: { key: 'flash' | 'medium' | 'large' | 'vision' | 'code'; label: string }[] = [
  { key: 'flash', label: 'Rapide' },
  { key: 'medium', label: 'Médium' },
  { key: 'large', label: 'Puissant' },
  { key: 'vision', label: 'Vision' },
  { key: 'code', label: 'Code' }
]

/** Vitesse publiée par Artificial Analysis (étape 131) — mesurée sur leur matériel, pas sur cette machine. */
function formatSpeed(entry: ModelOverviewEntry): string {
  return entry.artificialAnalysisSpeed === null ? '—' : `${entry.artificialAnalysisSpeed} tok/s`
}

/** Libellé collé à la valeur : ce tableau n'a pas d'en-tête, un nombre nu serait incompréhensible (étape 130). */
function formatIntelligence(entry: ModelOverviewEntry): string {
  return entry.artificialAnalysisIndex === null ? '—' : `Intelligence ${entry.artificialAnalysisIndex}`
}

/** "RTX 3070 · 8 Go de VRAM · 32 Go de RAM" — seulement ce qui a vraiment été détecté, jamais inventé. */
export function formatHardware(picks: MyModelPicksData): string {
  const parts = [picks.gpuName ?? 'Carte graphique non détectée']
  if (picks.vramGb !== null) parts.push(`${picks.vramGb} Go de VRAM`)
  parts.push(`${picks.ramGb} Go de RAM`)
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
export default function MyModelPicks({ picks, title = 'Modèles utilisés sur ta machine', onDeleteUnused }: MyModelPicksProps): JSX.Element {
  const [confirming, setConfirming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const check = picks.installCheck
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
                    <td className="capacity-scan__tier-slot">{label}</td>
                    <td className="capacity-scan__tier-model" title={entry.model}>
                      {formatModelName(entry.model)}
                    </td>
                    <td
                      className="capacity-scan__tier-speed"
                      title="Vitesse de génération publiée par Artificial Analysis — mesurée sur leur matériel, pas sur ta machine"
                    >
                      {formatSpeed(entry)}
                    </td>
                    <td className="capacity-scan__tier-intelligence" title="Artificial Analysis Intelligence Index v4.3.2">
                      {formatIntelligence(entry)}
                    </td>
                    <td>
                      <ReliabilityBadge value={entry.toolCalling} />
                    </td>
                  </tr>
                  {/* Étape 138 : la ligne ci-dessus est le modèle RÉELLEMENT utilisé. Quand le meilleur choix
                      est un autre, on le dit ici avec la raison — plus jamais un modèle affiché mais pas utilisé. */}
                  {/* Étape 140 : vérifié auprès d'Ollama — un modèle affiché mais absent du disque est signalé. */}
                  {missing && (
                    <tr className="capacity-scan__tier-upgrade capacity-scan__tier-missing">
                      <td />
                      <td colSpan={4}>Pas installé sur ce PC pour l'instant — clique « Retester la configuration ».</td>
                    </tr>
                  )}
                  {upgrade && (
                    <tr className="capacity-scan__tier-upgrade">
                      <td />
                      <td colSpan={4}>
                        {upgrade.blockedReason
                          ? `Meilleur choix : ${formatModelName(upgrade.model)}, pas encore installé — ${upgrade.blockedReason}.`
                          : `Meilleur choix disponible : ${formatModelName(upgrade.model)} — clique « Retester la configuration » pour l'installer.`}
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
      {/* Étape 140, Léo : "je veut etre sur que les model visbile sont réel et pas un autre model". */}
      {!check ? (
        <p className="capacity-scan__install-check">Impossible de vérifier auprès d'Ollama pour l'instant (il ne répond pas).</p>
      ) : (
        <div className="capacity-scan__install-check">
          {check.notInstalled.length === 0 && <p>✓ Vérifié auprès d'Ollama : ces modèles sont bien installés sur ce PC.</p>}
          {check.otherInstalled.length === 0 ? (
            <p>Aucun autre modèle installé : ce que tu vois est exactement ce qu'il y a sur ton PC.</p>
          ) : (
            <>
              <p>Autres modèles installés, que Jaris n'utilise pas :</p>
              <ul className="capacity-scan__other-models">
                {check.otherInstalled.map((model) => (
                  <li key={model}>
                    <span title={model}>{formatModelName(model)}</span>
                    {onDeleteUnused &&
                      (confirming === model ? (
                        <span className="capacity-scan__other-actions">
                          <button className="options-menu__action capacity-scan__delete-confirm" disabled={deleting === model} onClick={() => void remove(model)}>
                            {deleting === model ? 'Suppression…' : 'Supprimer'}
                          </button>
                          <button className="options-menu__action" disabled={deleting === model} onClick={() => setConfirming(null)}>
                            Annuler
                          </button>
                        </span>
                      ) : (
                        <button className="options-menu__action" onClick={() => setConfirming(model)}>
                          Supprimer
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
      <p className="capacity-scan__tier-legend">
        Pour chaque rôle, Jaris prend le modèle qui tient dans ta machine avec la meilleure fiabilité d'appel
        d'outils, puis la meilleure Intelligence. Vitesse et Intelligence : mesures publiées par Artificial
        Analysis, identiques pour tout le monde — elles comparent les modèles entre eux, pas la vitesse sur ta
        machine.
      </p>
    </div>
  )
}
