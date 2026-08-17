import { useEffect, useState } from 'react'
import type { CapacityScanResult } from '../../shared/ipc'

interface CapacityScanProps {
  onDone: () => void
}

export default function CapacityScan({ onDone }: CapacityScanProps): JSX.Element {
  const [status, setStatus] = useState('Détection de la carte graphique…')
  const [result, setResult] = useState<CapacityScanResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const unsubscribe = window.jaris.onCapacityScanStatus(setStatus)

    window.jaris
      .scanCapacity()
      .then(async (scan) => {
        setResult(scan)
        const profile = await window.jaris.getProfile()
        if (profile) {
          await window.jaris.saveProfile({ ...profile, models: scan.models, capacityScanDone: true })
        }
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))

    return unsubscribe
  }, [])

  const finish = (): void => onDone()

  return (
    <div className="app">
      <div className="app__onboarding capacity-scan">
        <h1>{result ? 'Analyse terminée' : 'Analyse de ton PC...'}</h1>

        {!result && !error && (
          <>
            <div className="capacity-scan__spinner" />
            <p className="capacity-scan__status">{status}</p>
          </>
        )}

        {error && (
          <>
            <p className="capacity-scan__status">Le scan a échoué : {error}</p>
            <button onClick={finish}>Continuer quand même</button>
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
            </ul>
            <p className="capacity-scan__hint">
              Jaris choisit automatiquement le modèle le plus adapté à chaque question. Modifiable plus tard.
            </p>
            <button onClick={finish}>Continuer</button>
          </>
        )}
      </div>
    </div>
  )
}
