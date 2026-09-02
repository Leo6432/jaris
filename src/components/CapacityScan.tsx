import { useEffect, useState } from 'react'
import type { CapacityScanResult, HardwareTierPreview as HardwareTierPreviewData } from '../../shared/ipc'
import HardwareTierPreview from './HardwareTierPreview'

interface CapacityScanProps {
  onDone: () => void
}

/**
 * Premier lancement : détecte le matériel et télécharge directement les modèles déjà connus pour lui
 * (voir runQuickSetup, benchmarkRunner.ts) — remplace l'ancienne analyse comparative obligatoire complète
 * (qui pouvait prendre des dizaines de minutes) maintenant que scripts/verified-tool-scores.md couvre la
 * quasi-totalité des configurations courantes : plus besoin de comparer des dizaines de candidats pour
 * savoir lequel gagne, juste télécharger le gagnant déjà connu. Présente d'abord les 3 paliers de
 * configuration (previewHardwareTiers) avec une flèche sur celui qui correspond à cette machine, pour que
 * l'utilisateur comprenne pourquoi Jaris a choisi ce qu'il a choisi avant même de cliquer "Continuer" — à la
 * demande explicite de Léo. L'ancienne analyse comparative complète reste disponible à la main depuis
 * Options → Modèles pour qui veut vérifier/affiner au-delà de ce qui est déjà vérifié.
 */
export default function CapacityScan({ onDone }: CapacityScanProps): JSX.Element {
  const [tiers, setTiers] = useState<HardwareTierPreviewData[] | null>(null)
  const [installing, setInstalling] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const [result, setResult] = useState<CapacityScanResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.jaris.previewHardwareTiers().then(setTiers)
  }, [])

  useEffect(() => {
    if (!installing) return
    return window.jaris.onModelBenchmarkLine((line) => setLog((prev) => [...prev, line]))
  }, [installing])

  const start = (): void => {
    setError(null)
    setLog([])
    setInstalling(true)
    window.jaris
      .runQuickSetup()
      .then((scan) => setResult(scan))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setInstalling(false))
  }

  const finish = (): void => onDone()

  return (
    <div className="app">
      <div className="app__onboarding capacity-scan">
        <h1>{result ? 'Configuration terminée' : 'Configuration de Jaris'}</h1>

        {!result && !installing && !error && (
          <>
            <p>
              Jaris détecte ta machine et choisit directement les modèles déjà adaptés à sa taille, sans
              tout comparer un par un — voici les 3 configurations possibles, la tienne est repérée ci-dessous.
            </p>
            {tiers === null ? <p className="capacity-scan__status">Détection du matériel...</p> : <HardwareTierPreview tiers={tiers} />}
            <button onClick={start} disabled={tiers === null}>
              Continuer
            </button>
          </>
        )}

        {installing && (
          <>
            <div className="capacity-scan__spinner" />
            <p className="capacity-scan__status">Téléchargement des modèles choisis...</p>
            {log.length > 0 && <p className="capacity-scan__status">{log[log.length - 1]}</p>}
          </>
        )}

        {error && (
          <>
            <p className="capacity-scan__status">La configuration a échoué : {error}</p>
            <button onClick={start}>Réessayer</button>
          </>
        )}

        {result && (
          <>
            <p>
              Carte détectée : {result.gpuName ?? 'inconnue'}
              {result.vramGb !== null ? ` (${result.vramGb} Go de VRAM)` : ''}
            </p>
            <ul className="capacity-scan__models">
              <li>Rapide : {result.models.flash}</li>
              <li>Médium : {result.models.medium}</li>
              <li>Puissant : {result.models.large}</li>
              <li>Vision : {result.visionModel}</li>
            </ul>
            <p className="capacity-scan__hint">
              Jaris choisit automatiquement le modèle le plus adapté à chaque question. Modifiable plus tard
              depuis Options → Modèles.
            </p>
            <button onClick={finish}>Continuer</button>
          </>
        )}
      </div>
    </div>
  )
}
