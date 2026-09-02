import { Fragment } from 'react'
import type { HardwareTierPreview as HardwareTierPreviewData } from '../../shared/ipc'

interface HardwareTierPreviewProps {
  tiers: HardwareTierPreviewData[]
}

/**
 * Les 3 paliers de configuration (Petite/Moyenne/Grande, voir previewHardwareTiers dans hardwareScan.ts)
 * reliés par des flèches, celui qui correspond à la machine détectée mis en évidence — partagé entre
 * l'écran d'accueil (CapacityScan.tsx, avant même le premier téléchargement) et l'onglet Modèles du menu
 * Options (OptionsMenu.tsx, consultable à tout moment après), plutôt que dupliquer le même JSX deux fois.
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
            <ul className="capacity-scan__tier-models">
              <li>Rapide : {tier.models.flash}</li>
              <li>Médium : {tier.models.medium}</li>
              <li>Puissant : {tier.models.large}</li>
              <li>Vision : {tier.visionModel}</li>
            </ul>
            {tier.current && <div className="capacity-scan__tier-badge">← ta configuration</div>}
          </div>
          {i < tiers.length - 1 && <div className="capacity-scan__tier-arrow">↓</div>}
        </Fragment>
      ))}
    </div>
  )
}
