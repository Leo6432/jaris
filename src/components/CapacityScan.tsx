import { useEffect, useState } from 'react'
import type { CapacityScanResult, MyModelPicks as MyModelPicksData } from '../../shared/ipc'
import { formatModelName } from '../lib/formatModelName'
import MyModelPicks from './MyModelPicks'
import JarisOrb from './JarisOrb'

interface CapacityScanProps {
  onDone: () => void
}

/**
 * Premier lancement : détecte le matériel et télécharge directement les modèles déjà connus pour lui
 * (voir runQuickSetup, benchmarkRunner.ts) — remplace l'ancienne analyse comparative obligatoire complète
 * (qui pouvait prendre des dizaines de minutes) maintenant que scripts/verified-tool-scores.md couvre la
 * quasi-totalité des configurations courantes : plus besoin de comparer des dizaines de candidats pour
 * savoir lequel gagne, juste télécharger le gagnant déjà connu. Présente d'abord les modèles choisis pour
 * CETTE machine (getMyModelPicks — plus de paliers de comparaison depuis l'étape 137), pour que
 * l'utilisateur voie ce que Jaris va installer avant même de cliquer "Continuer". L'ancienne analyse comparative complète reste disponible à la main depuis
 * Options → Modèles pour qui veut vérifier/affiner au-delà de ce qui est déjà vérifié.
 */
export default function CapacityScan({ onDone }: CapacityScanProps): JSX.Element {
  const [picks, setPicks] = useState<MyModelPicksData | null>(null)
  const [installing, setInstalling] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const [result, setResult] = useState<CapacityScanResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.jaris.getMyModelPicks().then(setPicks)
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
        <div className="welcome-mascot">
          <JarisOrb emotion={result ? 'happy' : 'thinking'} size={96} />
        </div>
        <h1>{result ? 'Configuration terminée' : 'Configuration de Jaris'}</h1>

        {!result && !installing && !error && (
          <>
            <p>
              Jaris a regardé ta machine et choisi, pour chaque rôle, le meilleur modèle qui y tient — voici
              ce qu'il va installer.
            </p>
            {picks === null ? <p className="capacity-scan__status">Détection du matériel...</p> : <MyModelPicks picks={picks} title="Modèles choisis pour ta machine" />}
            <button onClick={start} disabled={picks === null}>
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
              <li>Rapide : {formatModelName(result.models.flash)}</li>
              <li>Médium : {formatModelName(result.models.medium)}</li>
              <li>Puissant : {formatModelName(result.models.large)}</li>
              <li>Vision : {formatModelName(result.visionModel)}</li>
            </ul>
            <p className="capacity-scan__hint">
              Jaris choisit automatiquement le modèle le plus adapté à chaque question. Modifiable plus tard
              depuis Options → Modèles.
            </p>
            {result.skippedModels && result.skippedModels.length > 0 && (
              <div className="capacity-scan__warning">
                <p>
                  Attention : {result.skippedModels.length > 1 ? 'certains modèles ci-dessus ne sont' : 'un des modèles ci-dessus n\'est'} en
                  réalité pas installé, Jaris utilisera un repli moins bon en attendant :
                </p>
                <ul>
                  {result.skippedModels.map(({ model, reason }) => (
                    <li key={model}>
                      {formatModelName(model)} : {reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {result.blockedModels && result.blockedModels.length > 0 && (
              <div className="capacity-scan__warning">
                <p>
                  {result.blockedModels.length > 1 ? 'Ces meilleurs modèles n\'ont' : 'Ce meilleur modèle n\'a'} pas pu être
                  téléchargé pour l'instant, Jaris utilise le suivant à la place :
                </p>
                <ul>
                  {result.blockedModels.map(({ model, reason }) => (
                    <li key={model}>
                      {formatModelName(model)} : {reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <button onClick={finish}>Continuer</button>
          </>
        )}
      </div>
    </div>
  )
}
