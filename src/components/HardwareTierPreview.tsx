import { Fragment } from 'react'
import type { HardwareTierPreview as HardwareTierPreviewData, ModelOverviewEntry } from '../../shared/ipc'
import { ReliabilityBadge } from './OptionsMenu'

interface HardwareTierPreviewProps {
  tiers: HardwareTierPreviewData[]
}

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
 * Les 3 paliers de configuration (Petite/Moyenne/Grande, voir previewHardwareTiers dans hardwareScan.ts)
 * reliés par des flèches, celui qui correspond à la machine détectée mis en évidence — partagé entre
 * l'écran d'accueil (CapacityScan.tsx, avant même le premier téléchargement) et l'onglet Modèles du menu
 * Options (OptionsMenu.tsx, consultable à tout moment après), plutôt que dupliquer le même JSX deux fois.
 * Affiche vitesse et fiabilité de chaque modèle (pas juste son nom) : remplace le tableau détaillé de tous
 * les candidats, retiré à la demande de Léo une fois ce résumé jugé suffisant.
 */
export default function HardwareTierPreview({ tiers }: HardwareTierPreviewProps): JSX.Element {
  return (
    <div className="capacity-scan__tiers">
      {tiers.map((tier, i) => (
        <Fragment key={tier.label}>
          <div className={`capacity-scan__tier${tier.current ? ' capacity-scan__tier--current' : ''}`}>
            <div className="capacity-scan__tier-header">
              <span className="capacity-scan__tier-index">Palier {i + 1}</span>
              <span className="capacity-scan__tier-label">{tier.label}</span>
            </div>
            <table className="capacity-scan__tier-table">
              <tbody>
                {SLOT_LABELS.map(({ key, label }) => {
                  const entry = tier[key]
                  return (
                    <tr key={key}>
                      <td className="capacity-scan__tier-slot">{label}</td>
                      <td className="capacity-scan__tier-model" title={entry.model}>
                        {entry.model}
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
            {tier.current && <div className="capacity-scan__tier-badge">← ta configuration</div>}
          </div>
          {i < tiers.length - 1 && <div className="capacity-scan__tier-arrow">↓</div>}
        </Fragment>
      ))}
    </div>
  )
}
