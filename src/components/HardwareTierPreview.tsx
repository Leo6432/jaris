import { Fragment, useState } from 'react'
import type { HardwareTierPreview as HardwareTierPreviewData, ModelOverviewEntry } from '../../shared/ipc'
import { formatModelName } from '../lib/formatModelName'
import { ReliabilityBadge, SettingRow } from './OptionsMenu'

interface HardwareTierPreviewProps {
  tiers: HardwareTierPreviewData[]
  /**
   * Onglet Modèles (OptionsMenu.tsx) uniquement : par défaut, n'affiche QUE le palier de la machine
   * détectée (en-tête façon SettingRow + les 5 lignes de modèles), pas les ~10 paliers reliés par des
   * flèches — c'est le résumé "à quoi ressemble le choix de Jaris pour MA machine" qui compte au quotidien,
   * pas la comparaison entre paliers. Un bouton ("Voir tous les paliers") déplie la liste complète en
   * dessous, sans rien retirer : Léo peut toujours comparer sa machine aux autres tranches s'il le veut.
   * L'écran d'accueil (CapacityScan.tsx, avant même le premier téléchargement) garde le comportement
   * d'origine — la liste complète y sert justement à expliquer le principe avant que "ta configuration" ait
   * un sens concret.
   */
  compact?: boolean
}

// 'code' réintégré (étape 46) : resolveCodeModel (codeGenerator.ts) suit maintenant EXACTEMENT la même
// logique de budget par palier que les 4 lignes ci-dessous (pickBestCodeModel, hardwareScan.ts) — plus le
// repli fixe "qualité si déjà installée, sinon rapide" d'avant, qui avait justifié de retirer cette ligne
// (calculée mais jamais réellement utilisée). Remise à la demande de Léo une fois que ce n'est plus le cas.
const SLOT_LABELS: { key: 'flash' | 'medium' | 'large' | 'vision' | 'code'; label: string }[] = [
  { key: 'flash', label: 'Rapide' },
  { key: 'medium', label: 'Médium' },
  { key: 'large', label: 'Puissant' },
  { key: 'vision', label: 'Vision' },
  { key: 'code', label: 'Code' }
]

/** Même formatage que le tableau détaillé (OptionsMenu.tsx) : "(estimé)" distingue une vitesse calculée par
 * formule (verified-tool-scores.md) d'une vraie mesure locale, jamais confondues à l'affichage. */
function formatSpeed(entry: ModelOverviewEntry): string {
  if (entry.speedTokPerSec === null) return '—'
  return `${entry.speedTokPerSec.toFixed(1)} tok/s${entry.speedEstimated ? ' (estimé)' : ''}`
}

/**
 * "moins de X Go" / "X à Y Go" / "plus de Y Go" à partir des VRAM représentatives des paliers eux-mêmes
 * (tier.vramGb, une frontière réelle par palier — voir previewVramSteps, hardwareScan.ts), plutôt qu'en
 * recopiant des valeurs fixes en dur ici : les mêmes bornes servent déjà à choisir le palier "actuel" côté
 * previewHardwareTiers, pas la peine de les dupliquer et risquer qu'elles divergent si l'une des deux est
 * modifiée sans l'autre. Générique quel que soit le nombre de paliers (jamais figé à 3).
 */
function formatVramRange(tiers: HardwareTierPreviewData[], i: number): string {
  if (i === 0) return `(moins de ${tiers[0].vramGb} Go)`
  if (i === tiers.length - 1) return `(plus de ${tiers[i - 1].vramGb} Go)`
  return `(${tiers[i - 1].vramGb} à ${tiers[i].vramGb} Go)`
}

/** Les 5 lignes Rapide/Médium/Puissant/Vision/Code d'UN palier — extrait pour être réutilisé tel quel par la
 *  vue compacte (un seul palier) et la vue complète (un par palier) ci-dessous. */
function TierTable({ tier }: { tier: HardwareTierPreviewData }): JSX.Element {
  return (
    <table className="capacity-scan__tier-table">
      <tbody>
        {SLOT_LABELS.map(({ key, label }) => {
          const entry = tier[key]
          return (
            <tr key={key}>
              <td className="capacity-scan__tier-slot">{label}</td>
              <td className="capacity-scan__tier-model" title={entry.model}>
                {formatModelName(entry.model)}
              </td>
              <td className="capacity-scan__tier-speed">{formatSpeed(entry)}</td>
              <td>
                <ReliabilityBadge value={entry.toolCalling} />
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/** "RTX 4070 · 12 Go de mémoire vidéo · 32 Go de RAM" à partir des valeurs RÉELLEMENT détectées (jamais la
 *  frontière du palier, qui n'a souvent aucun rapport) — `null` sur GPU/VRAM si aucun GPU NVIDIA détecté. */
function formatDetectedHardware(tier: HardwareTierPreviewData): string {
  const parts = [tier.gpuName ?? 'GPU non détecté']
  if (tier.detectedVramGb !== null) parts.push(`${tier.detectedVramGb} Go de mémoire vidéo`)
  parts.push(`${tier.ramGb} Go de RAM`)
  return parts.join(' · ')
}

/**
 * Les paliers de configuration (une dizaine en pratique, un par frontière RÉELLE de VRAM — voir
 * previewVramSteps dans hardwareScan.ts, à la demande de Léo pour que deux machines dans le même palier
 * obtiennent garanti le même modèle) reliés par des flèches, celui qui correspond à la machine détectée mis
 * en évidence — partagé entre l'écran d'accueil (CapacityScan.tsx, avant même le premier téléchargement,
 * toujours la liste complète) et l'onglet Modèles du menu Options (OptionsMenu.tsx, `compact`), plutôt que
 * dupliquer le même JSX deux fois. Affiche vitesse et fiabilité de chaque modèle (pas juste son nom) :
 * remplace le tableau détaillé de tous les candidats, retiré à la demande de Léo une fois ce résumé jugé
 * suffisant.
 */
export default function HardwareTierPreview({ tiers, compact = false }: HardwareTierPreviewProps): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const currentIndex = tiers.findIndex((t) => t.current)
  const current = currentIndex === -1 ? null : tiers[currentIndex]

  if (compact && current) {
    return (
      <div className="capacity-scan__tiers capacity-scan__tiers--compact">
        <SettingRow
          label={`Palier ${currentIndex + 1} sur ${tiers.length} ${formatVramRange(tiers, currentIndex)}`}
          description={formatDetectedHardware(current)}
        >
          <button className="options-menu__action" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Réduire' : 'Ta configuration'}
          </button>
        </SettingRow>
        <TierTable tier={current} />
        {expanded && (
          <div className="capacity-scan__tiers">
            {tiers.map((tier, i) => (
              <Fragment key={tier.label}>
                <div className={`capacity-scan__tier${tier.current ? ' capacity-scan__tier--current' : ''}`}>
                  <div className="capacity-scan__tier-header">
                    <span className="capacity-scan__tier-index">Palier {i + 1}</span>
                    <span className="capacity-scan__tier-label">{tier.label}</span>
                    <span className="capacity-scan__tier-vram-range">{formatVramRange(tiers, i)}</span>
                  </div>
                  <TierTable tier={tier} />
                  {tier.current && <div className="capacity-scan__tier-badge">← ta configuration</div>}
                </div>
                {i < tiers.length - 1 && <div className="capacity-scan__tier-arrow">↓</div>}
              </Fragment>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="capacity-scan__tiers">
      {tiers.map((tier, i) => (
        <Fragment key={tier.label}>
          <div className={`capacity-scan__tier${tier.current ? ' capacity-scan__tier--current' : ''}`}>
            <div className="capacity-scan__tier-header">
              <span className="capacity-scan__tier-index">Palier {i + 1}</span>
              <span className="capacity-scan__tier-label">{tier.label}</span>
              <span className="capacity-scan__tier-vram-range">{formatVramRange(tiers, i)}</span>
            </div>
            <TierTable tier={tier} />
            {tier.current && <div className="capacity-scan__tier-badge">← ta configuration</div>}
          </div>
          {i < tiers.length - 1 && <div className="capacity-scan__tier-arrow">↓</div>}
        </Fragment>
      ))}
    </div>
  )
}
