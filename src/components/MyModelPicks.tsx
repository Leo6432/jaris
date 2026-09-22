import type { ModelOverviewEntry, MyModelPicks as MyModelPicksData } from '../../shared/ipc'
import { formatModelName } from '../lib/formatModelName'
import { ReliabilityBadge } from './OptionsMenu'

interface MyModelPicksProps {
  picks: MyModelPicksData
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
export default function MyModelPicks({ picks }: MyModelPicksProps): JSX.Element {
  return (
    <div className="capacity-scan__tiers">
      <div className="capacity-scan__tier capacity-scan__tier--current">
        <div className="capacity-scan__tier-header">
          <span className="capacity-scan__tier-label">Modèles choisis pour ta machine</span>
          <span className="capacity-scan__tier-hardware">{formatHardware(picks)}</span>
        </div>
        <table className="capacity-scan__tier-table">
          <tbody>
            {ROLES.map(({ key, label }) => {
              const entry = picks[key]
              return (
                <tr key={key}>
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
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="capacity-scan__tier-legend">
        Pour chaque rôle, Jaris prend le modèle qui tient dans ta machine avec la meilleure fiabilité d'appel
        d'outils, puis la meilleure Intelligence. Vitesse et Intelligence : mesures publiées par Artificial
        Analysis, identiques pour tout le monde — elles comparent les modèles entre eux, pas la vitesse sur ta
        machine.
      </p>
    </div>
  )
}
