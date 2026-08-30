import { useEffect, useRef, useState } from 'react'
import type { AnalysisScope, CapacityScanResult, ModelOverviewResult } from '../../shared/ipc'

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
 * Poids de chaque NOUVEL événement dans la moyenne mobile exponentielle (EWMA) du débit de progression, pour
 * l'estimation de temps restant — voir ewmaRateRef. 0.25 : un seul événement anormal (ex: un test sur un
 * gros modèle RAM-offloadé qui prend 25 minutes pour presque aucun avancement, voir "Puissant") ne pèse que
 * pour 25% de la nouvelle estimation, pas 100% — contrairement à une fenêtre glissante (essayée avant),
 * repérée en simulation pour rester bloquée sur UN SEUL événement lent (ETA à 163 min pour une vraie
 * remontée à 4 min, le bug signalé : "il me disait 14h mais c'est beaucoup moins"), potentiellement pendant
 * plusieurs minutes après coup — l'EWMA se corrige, elle, en 1-2 événements suivants.
 */
const EWMA_ALPHA = 0.25

export interface ModelAnalysisState {
  benchmarking: boolean
  /** Périmètre du run EN COURS (ou du dernier lancé) — 'all' tant qu'aucun run n'a encore démarré. */
  scope: AnalysisScope
  pullCount: { done: number; total: number } | null
  testCount: { done: number; total: number } | null
  progressFraction: number
  etaMs: number | null
  modelRunStatus: Record<string, ModelRunStatus>
  benchmarkLog: string[]
  error: string | null
  /**
   * Lance scripts/benchmark-models.mjs (via l'IPC runModelAnalysis) et suit sa progression en direct.
   * `scope` ('all' par défaut) limite le test à un seul palier, bien plus rapide — voir AnalysisScope.
   */
  run: (scope?: AnalysisScope) => Promise<CapacityScanResult>
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
  const [scope, setScope] = useState<AnalysisScope>('all')
  const [pullCount, setPullCount] = useState<{ done: number; total: number } | null>(null)
  const [testCount, setTestCount] = useState<{ done: number; total: number } | null>(null)
  const [progressFraction, setProgressFraction] = useState(0)
  const [etaMs, setEtaMs] = useState<number | null>(null)
  const [modelRunStatus, setModelRunStatus] = useState<Record<string, ModelRunStatus>>({})
  const [benchmarkLog, setBenchmarkLog] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  // Débit de progression estimé (poids par seconde) par moyenne mobile exponentielle (EWMA) du débit
  // INSTANTANÉ entre deux événements ##PROGRESS## consécutifs, pas une simple moyenne depuis le tout début
  // du run (essayée d'abord : reste bloquée sur le rythme des tout premiers modèles, rapides, quand un gros
  // modèle lent arrive plus tard) ni une fenêtre glissante brute (essayée ensuite : un seul test isolé très
  // lent sur un gros modèle "Puissant" pouvait rester coincé dans la fenêtre plusieurs minutes, faisant
  // dire "14h" alors que la vraie remontée était de quelques minutes). Voir EWMA_ALPHA.
  const ewmaRateRef = useRef<number | null>(null)
  const lastProgressRef = useRef<{ t: number; w: number } | null>(null)
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
      // Téléchargement et test tournent maintenant EN PARALLÈLE (voir pullConcurrencyFor côté script) :
      // jusqu'à 2 à 4 modèles peuvent être en cours de téléchargement à la fois selon la RAM détectée, chaque
      // ligne précise donc lequel.
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

        // Débit INSTANTANÉ depuis le dernier événement, mélangé à la moyenne mobile existante (EWMA) plutôt
        // que de remplacer purement et simplement l'estimation — voir le commentaire d'ewmaRateRef plus haut.
        const now = Date.now()
        const previous = lastProgressRef.current
        lastProgressRef.current = { t: now, w: done }
        if (previous) {
          const dtS = (now - previous.t) / 1000
          // Ignore un intervalle quasi nul (deux lignes émises au même instant) : diviser par ~0 donnerait un
          // débit instantané délirant qui pèserait à tort dans la moyenne mobile.
          if (dtS >= 0.5) {
            const instantRate = (done - previous.w) / dtS
            ewmaRateRef.current = ewmaRateRef.current === null ? instantRate : EWMA_ALPHA * instantRate + (1 - EWMA_ALPHA) * ewmaRateRef.current
          }
        }
        if (ewmaRateRef.current !== null && ewmaRateRef.current > 0) {
          etaFrozenRef.current = { ms: (Math.max(0, total - done) / ewmaRateRef.current) * 1000, capturedAt: now }
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

  const run = async (requestedScope: AnalysisScope = 'all'): Promise<CapacityScanResult> => {
    setError(null)
    setBenchmarking(true)
    setScope(requestedScope)
    setBenchmarkLog([])
    setPullCount(null)
    setTestCount(null)
    setProgressFraction(0)
    setEtaMs(null)
    ewmaRateRef.current = null
    lastProgressRef.current = null
    etaFrozenRef.current = null
    // Tableau de suivi initialisé avec TOUS les candidats connus à "en attente" : sans ça, un modèle
    // n'apparaîtrait dans le tableau qu'au moment où une ligne le mentionne pour la première fois. Pas filtré
    // par périmètre ici (ModelAnalysisProgress s'en charge à l'affichage, voir SCOPE_TO_TIER_LABEL) : garder
    // le statut de TOUS les modèles, même hors périmètre, ne coûte rien et évite de le perdre au passage.
    const initialStatus: Record<string, ModelRunStatus> = {}
    for (const group of modelOverviewRef.current?.groups ?? []) {
      for (const entry of group.entries) initialStatus[entry.model] = { kind: 'pending' }
    }
    setModelRunStatus(initialStatus)
    try {
      return await window.jaris.runModelAnalysis(requestedScope)
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

  return { benchmarking, scope, pullCount, testCount, progressFraction, etaMs, modelRunStatus, benchmarkLog, error, run }
}
