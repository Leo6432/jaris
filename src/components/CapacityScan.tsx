import { useEffect, useState } from 'react'
import type { CapacityScanResult, ModelOverviewResult } from '../../shared/ipc'
import { useModelAnalysis } from '../hooks/useModelAnalysis'
import ModelAnalysisProgress, { ANALYSIS_NOTICE } from './ModelAnalysisProgress'

interface CapacityScanProps {
  onDone: () => void
}

/**
 * Premier lancement : Jaris teste TOUS les modèles candidats compatibles avec la machine (comme "Lancer
 * l'analyse" dans Options → Modèles, voir useModelAnalysis) plutôt qu'un choix rapide basé sur la seule
 * VRAM totale — décision explicite de Léo : "je veux que la personne soit obligée de faire l'analyse
 * complète pour démarrer sa première fois avec Jaris", même si ça prend plus longtemps qu'un scan rapide.
 * Pas d'échappatoire "continuer quand même" sur un échec (contrairement à l'ancien scan rapide) : sans
 * modèle réellement testé et retenu, Jaris ne peut de toute façon rien faire — seule une nouvelle tentative
 * a un sens.
 */
export default function CapacityScan({ onDone }: CapacityScanProps): JSX.Element {
  const [modelOverview, setModelOverview] = useState<ModelOverviewResult | null>(null)
  const [started, setStarted] = useState(false)
  const [result, setResult] = useState<CapacityScanResult | null>(null)
  const analysis = useModelAnalysis(modelOverview)

  useEffect(() => {
    void window.jaris.getModelOverview().then(setModelOverview)
  }, [])

  const start = (): void => {
    setStarted(true)
    setResult(null)
    analysis
      .run()
      .then(async (scan) => {
        setResult(scan)
        const profile = await window.jaris.getProfile()
        if (profile) {
          await window.jaris.saveProfile({ ...profile, models: scan.models, visionModel: scan.visionModel, capacityScanDone: true })
        }
      })
      .catch(() => {
        // analysis.error porte déjà le message : rien de plus à faire ici, l'écran d'échec ci-dessous
        // propose juste de réessayer (voir le commentaire au-dessus du composant).
      })
  }

  const finish = (): void => onDone()

  return (
    <div className="app">
      <div className="app__onboarding capacity-scan">
        <h1>{result ? 'Analyse terminée' : 'Analyse de ton PC...'}</h1>

        {!started && (
          <>
            <p>
              Jaris teste chaque modèle candidat qui tient sur ta machine (VRAM, RAM et espace disque) pour
              choisir le meilleur de chaque palier, plutôt que de deviner d'après la taille seule. Ça peut
              prendre du temps (potentiellement plusieurs dizaines de minutes, et plusieurs Go de
              téléchargement) selon ta connexion et ton matériel.
            </p>
            <p className="options-menu__analysis-notice">{ANALYSIS_NOTICE}</p>
            <button onClick={start} disabled={modelOverview === null}>
              {modelOverview === null ? 'Préparation...' : "Démarrer l'analyse"}
            </button>
          </>
        )}

        {started && !result && !analysis.error && (
          <>
            <div className="capacity-scan__spinner" />
            <ModelAnalysisProgress state={analysis} modelOverview={modelOverview} />
          </>
        )}

        {analysis.error && (
          <>
            <p className="capacity-scan__status">L'analyse a échoué : {analysis.error}</p>
            <ModelAnalysisProgress state={analysis} modelOverview={modelOverview} />
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
