import { useEffect, useRef, useState } from 'react'
import type { CapacityScanResult, ModelOverviewResult } from '../../shared/ipc'

/**
 * État d'un modèle candidat pendant un run de benchmark (##PULL_MODEL_PROGRESS##/##MODEL_TESTING##/
 * ##MODEL_DONE##/##MODEL_SKIPPED##, voir scripts/benchmark-models.mjs) — affiché dans le tableau de suivi
 * en direct (voir ModelAnalysisProgress.tsx), à la place d'un journal brut difficile à suivre en un coup
 * d'œil ("on n'a aucune vue d'ensemble : quels modèles sont faits, en cours, pas encore commencés").
 */
export type ModelRunStatus =
  | { kind: 'pending' }
  | { kind: 'downloading'; percent: number }
  | { kind: 'testing' }
  | { kind: 'done'; correct: number; total: number }
  | { kind: 'skipped' }

/**
 * Fenêtre glissante (ms) sur laquelle le rythme récent de progression est mesuré pour l'estimation de temps
 * restant — voir progressSamplesRef. Ni trop courte (bruit d'un seul événement) ni trop longue (traînerait
 * le rythme d'un modèle précédent, plus rapide ou plus lent, sur le modèle actuel).
 */
const PROGRESS_WINDOW_MS = 90000

export interface ModelAnalysisState {
  benchmarking: boolean
  pullCount: { done: number; total: number } | null
  testCount: { done: number; total: number } | null
  progressFraction: number
  etaMs: number | null
  modelRunStatus: Record<string, ModelRunStatus>
  benchmarkLog: string[]
  error: string | null
  /** Lance scripts/benchmark-models.mjs (via l'IPC runModelAnalysis) et suit sa progression en direct. */
  run: () => Promise<CapacityScanResult>
}

/**
 * Logique partagée entre l'onglet Modèles (OptionsMenu.tsx, ré-analyse à la main) et l'écran d'onboarding
 * (CapacityScan.tsx, désormais OBLIGATOIRE au premier lancement — voir son commentaire) : les deux lancent
 * exactement le même run complet et doivent afficher la même progression en direct, pas de raison de
 * dupliquer cette mécanique deux fois.
 *
 * `modelOverview` sert UNIQUEMENT à initialiser le tableau de suivi avec tous les candidats connus à "en
 * attente" dès le lancement (sinon un modèle n'apparaîtrait qu'au moment où une ligne le mentionne pour la
 * première fois, aucune vue d'ensemble avant que ça démarre).
 */
export function useModelAnalysis(modelOverview: ModelOverviewResult | null): ModelAnalysisState {
  const [benchmarking, setBenchmarking] = useState(false)
  const [pullCount, setPullCount] = useState<{ done: number; total: number } | null>(null)
  const [testCount, setTestCount] = useState<{ done: number; total: number } | null>(null)
  const [progressFraction, setProgressFraction] = useState(0)
  const [etaMs, setEtaMs] = useState<number | null>(null)
  const [modelRunStatus, setModelRunStatus] = useState<Record<string, ModelRunStatus>>({})
  const [benchmarkLog, setBenchmarkLog] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  // Échantillons récents (horodatage, poids fait) de ##PROGRESS##, pour estimer le temps restant à partir du
  // RYTHME RÉCENT plutôt que de la moyenne depuis le tout début du run : une simple moyenne globale (essayée
  // avant) reste bloquée sur le rythme des tout premiers petits modèles, rapides — dès qu'un gros modèle
  // dense (donc lent) arrive plus tard, l'estimation grimpe brutalement au lieu de baisser (le bug signalé :
  // "il me disait 30 minutes... après il me disait 50 minutes"). Une fenêtre glissante de ~90s s'adapte bien
  // plus vite à un changement de rythme. Ne garde que les échantillons récents (voir PROGRESS_WINDOW_MS).
  const progressSamplesRef = useRef<{ t: number; w: number }[]>([])
  // Estimation "figée" au dernier calcul (ms restants + horodatage du calcul) : le timer ci-dessous fait
  // juste défiler ce chiffre en temps réel entre deux calculs, sans en refaire un nouveau à chaque tick.
  const etaFrozenRef = useRef<{ ms: number; capturedAt: number } | null>(null)
  // Toujours la dernière valeur de modelOverview, lue par `run()` (un useCallback figerait une valeur
  // périmée si modelOverview change entre deux rendus sans que `run` soit recréé).
  const modelOverviewRef = useRef(modelOverview)
  modelOverviewRef.current = modelOverview

  // Les lignes ##PULL_PROGRESS##/##PULL_MODEL_PROGRESS##/##TEST_PROGRESS##/##PROGRESS##/##MODEL_TESTING##/
  // ##MODEL_DONE##/##MODEL_SKIPPED## (scripts/benchmark-models.mjs) sont au format machine, jamais affichées
  // telles quelles : elles alimentent la barre de progression et le tableau de suivi plutôt qu'un journal.
  useEffect(() => {
    return window.jaris.onModelBenchmarkLine((line) => {
      // Téléchargement et test tournent maintenant EN PARALLÈLE (voir PULL_CONCURRENCY côté script) :
      // jusqu'à 2 modèles peuvent être en cours de téléchargement à la fois, chaque ligne précise donc lequel.
      const modelPullMatch = /^##PULL_MODEL_PROGRESS## (\S+) (\d+)$/.exec(line)
      if (modelPullMatch) {
        const [, model, percent] = modelPullMatch
        setModelRunStatus((prev) => ({ ...prev, [model]: { kind: 'downloading', percent: Number(percent) } }))
        return
      }
      const pullMatch = /^##PULL_PROGRESS## (\d+) (\d+)$/.exec(line)
      if (pullMatch) {
        setPullCount({ done: Number(pullMatch[1]), total: Number(pullMatch[2]) })
        return
      }
      const testMatch = /^##TEST_PROGRESS## (\d+) (\d+)$/.exec(line)
      if (testMatch) {
        setTestCount({ done: Number(testMatch[1]), total: Number(testMatch[2]) })
        return
      }
      const testingMatch = /^##MODEL_TESTING## (\S+)$/.exec(line)
      if (testingMatch) {
        setModelRunStatus((prev) => ({ ...prev, [testingMatch[1]]: { kind: 'testing' } }))
        return
      }
      const doneMatch = /^##MODEL_DONE## (\S+) (\d+) (\d+)$/.exec(line)
      if (doneMatch) {
        const [, model, correct, total] = doneMatch
        setModelRunStatus((prev) => ({ ...prev, [model]: { kind: 'done', correct: Number(correct), total: Number(total) } }))
        return
      }
      const skippedMatch = /^##MODEL_SKIPPED## (\S+)$/.exec(line)
      if (skippedMatch) {
        setModelRunStatus((prev) => ({ ...prev, [skippedMatch[1]]: { kind: 'skipped' } }))
        return
      }
      // ##PROGRESS## : avancement pondéré GLOBAL (Go téléchargés + poids de test confondus dans un seul
      // total, voir modelWeightGb côté script) — c'est CETTE progression qui pilote la barre et l'ETA, jamais
      // les compteurs "N/M" ci-dessus (gardés seulement pour le texte "N/M modèles"/"N/M tests").
      const progressMatch = /^##PROGRESS## ([\d.]+) ([\d.]+)$/.exec(line)
      if (progressMatch) {
        const done = Number(progressMatch[1])
        const total = Number(progressMatch[2])
        setProgressFraction(total > 0 ? Math.min(1, done / total) : 0)

        // Estimation de temps restant basée sur le RYTHME RÉCENT (fenêtre glissante), pas la moyenne depuis
        // le tout début — voir le commentaire de progressSamplesRef plus haut.
        const now = Date.now()
        const samples = progressSamplesRef.current
        samples.push({ t: now, w: done })
        while (samples.length > 2 && now - samples[0].t > PROGRESS_WINDOW_MS) samples.shift()
        const oldest = samples[0]
        const dtS = (now - oldest.t) / 1000
        // Ignore un intervalle trop court (une seule ligne, ou deux lignes quasi simultanées) : le débit
        // mesuré serait bruyant, mieux vaut attendre un peu plus de recul qu'afficher un temps délirant.
        if (samples.length >= 2 && dtS >= 3) {
          const rate = (done - oldest.w) / dtS
          if (rate > 0) {
            etaFrozenRef.current = { ms: (Math.max(0, total - done) / rate) * 1000, capturedAt: now }
          }
        }
        return
      }
      setBenchmarkLog((prev) => [...prev, line])
    })
  }, [])

  // Fait défiler le compte à rebours entre deux événements ##PROGRESS## (qui peuvent être espacés de
  // plusieurs minutes pour un gros modèle) plutôt que de le figer jusqu'au prochain événement — sans
  // recalculer l'estimation elle-même à chaque tick, juste la faire défiler depuis la dernière mesure.
  useEffect(() => {
    if (!benchmarking) return
    const id = setInterval(() => {
      if (etaFrozenRef.current === null) {
        setEtaMs(null)
        return
      }
      const { ms, capturedAt } = etaFrozenRef.current
      setEtaMs(Math.max(0, ms - (Date.now() - capturedAt)))
    }, 1000)
    return () => clearInterval(id)
  }, [benchmarking])

  const run = async (): Promise<CapacityScanResult> => {
    setError(null)
    setBenchmarking(true)
    setBenchmarkLog([])
    setPullCount(null)
    setTestCount(null)
    setProgressFraction(0)
    setEtaMs(null)
    progressSamplesRef.current = []
    etaFrozenRef.current = null
    // Tableau de suivi initialisé avec TOUS les candidats connus à "en attente" : sans ça, un modèle
    // n'apparaîtrait dans le tableau qu'au moment où une ligne le mentionne pour la première fois.
    const initialStatus: Record<string, ModelRunStatus> = {}
    for (const group of modelOverviewRef.current?.groups ?? []) {
      for (const entry of group.entries) initialStatus[entry.model] = { kind: 'pending' }
    }
    setModelRunStatus(initialStatus)
    try {
      return await window.jaris.runModelAnalysis()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      throw err
    } finally {
      setBenchmarking(false)
      setPullCount(null)
      setTestCount(null)
      setEtaMs(null)
    }
  }

  return { benchmarking, pullCount, testCount, progressFraction, etaMs, modelRunStatus, benchmarkLog, error, run }
}
