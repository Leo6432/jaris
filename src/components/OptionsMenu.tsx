import { useEffect, useMemo, useRef, useState } from 'react'
import type { ConversationEntry, GmailStatus, ModelOverviewResult, ModelTiers, Profile } from '../../shared/ipc'

interface VoiceOption {
  id: string
  description: string
  gradient: string
}

/**
 * État d'un modèle candidat pendant un run de benchmark (##PULL_MODEL_PROGRESS##/##MODEL_TESTING##/
 * ##MODEL_DONE##/##MODEL_SKIPPED##, voir scripts/benchmark-models.mjs) — affiché dans le tableau de suivi
 * en direct, à la place du journal brut qui ne montrait qu'un flux de texte difficile à suivre en un coup
 * d'œil ("on n'a aucune vue d'ensemble : quels modèles sont faits, en cours, pas encore commencés").
 */
type ModelRunStatus =
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

const TTS_VOICES: VoiceOption[] = [
  { id: 'M1', description: 'Vive, énergique', gradient: 'linear-gradient(135deg, #37e2ff, #2b6cff)' },
  { id: 'M2', description: 'Grave, sérieuse', gradient: 'linear-gradient(135deg, #2b6cff, #1c3f99)' },
  { id: 'M3', description: 'Autoritaire, confiante', gradient: 'linear-gradient(135deg, #6c5ce7, #341f97)' },
  { id: 'M4', description: 'Douce, jeune', gradient: 'linear-gradient(135deg, #55e6c1, #10ac84)' },
  { id: 'M5', description: 'Chaleureuse, narrative', gradient: 'linear-gradient(135deg, #feca57, #ff9f43)' },
  { id: 'F1', description: 'Calme, posée', gradient: 'linear-gradient(135deg, #ff9ff3, #f368e0)' },
  { id: 'F2', description: 'Vive, enjouée', gradient: 'linear-gradient(135deg, #ff6b81, #ee5253)' },
  { id: 'F3', description: 'Professionnelle', gradient: 'linear-gradient(135deg, #48dbfb, #0abde3)' },
  { id: 'F4', description: 'Nette, confiante', gradient: 'linear-gradient(135deg, #c8d6e5, #8395a7)' },
  { id: 'F5', description: 'Douce, bienveillante', gradient: 'linear-gradient(135deg, #ffdfba, #ffb8b8)' }
]

const DEFAULT_VOICE_INDEX = TTS_VOICES.findIndex((v) => v.id === 'M3')

/** "3 min", "1 h 20", "moins d'une minute"... à partir d'une estimation en ms. */
function formatEta(ms: number): string {
  const totalMinutes = Math.round(ms / 60000)
  if (totalMinutes < 1) return "moins d'une minute"
  if (totalMinutes < 60) return `${totalMinutes} min`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes}`
}

type Tab = 'connexions' | 'voix' | 'modeles' | 'historique'

// Reflète THINK_LEVEL dans electron/services/assistant.ts : chaque palier a un effort de réflexion Ollama
// fixe (low/medium/high), utile à afficher pour comprendre pourquoi deux paliers pointant sur le même
// modèle (matériel contraint) ne répondent quand même pas pareil.
const TIER_LABELS: Array<{ key: keyof ModelTiers; label: string; think: string }> = [
  { key: 'flash', label: 'Rapide', think: 'basse' },
  { key: 'medium', label: 'Médium', think: 'moyenne' },
  { key: 'large', label: 'Puissant', think: 'haute' }
]

/**
 * "3/3", "6/6" etc. en petit badge coloré (vert = parfait, ambre = partiel, rouge = raté) plutôt qu'en
 * texte brut au milieu du tableau — un coup d'œil suffit pour repérer les bons/mauvais élèves, pas besoin
 * de lire chaque cellule. "—" (jamais testé) reste un texte neutre, pas un badge.
 */
function ReliabilityBadge({ value }: { value: string | null }): JSX.Element {
  if (!value) return <span className="options-menu__badge options-menu__badge--none">—</span>
  const match = /^(\d+)\/(\d+)$/.exec(value)
  if (!match) return <span className="options-menu__badge options-menu__badge--none">{value}</span>
  const [, correctStr, totalStr] = match
  const correct = Number(correctStr)
  const total = Number(totalStr)
  const level = total === 0 ? 'none' : correct === total ? 'good' : correct === 0 ? 'bad' : 'mid'
  return <span className={`options-menu__badge options-menu__badge--${level}`}>{value}</span>
}

/** Badge d'état pour une ligne du tableau de suivi en direct (pendant un run) — voir ModelRunStatus. */
function RunStatusBadge({ status }: { status: ModelRunStatus | undefined }): JSX.Element {
  if (!status || status.kind === 'pending') {
    return <span className="options-menu__badge options-menu__badge--none">En attente</span>
  }
  if (status.kind === 'downloading') {
    return <span className="options-menu__badge options-menu__badge--mid">Téléchargement {status.percent}%</span>
  }
  if (status.kind === 'testing') {
    return <span className="options-menu__badge options-menu__badge--mid">Test en cours</span>
  }
  if (status.kind === 'skipped') {
    return <span className="options-menu__badge options-menu__badge--bad">Ignoré</span>
  }
  const level = status.total === 0 ? 'none' : status.correct === status.total ? 'good' : status.correct === 0 ? 'bad' : 'mid'
  return (
    <span className={`options-menu__badge options-menu__badge--${level}`}>
      Terminé ({status.correct}/{status.total})
    </span>
  )
}

export default function OptionsMenu(): JSX.Element {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('connexions')
  const [status, setStatus] = useState<GmailStatus | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [voiceIndex, setVoiceIndex] = useState(DEFAULT_VOICE_INDEX)
  const [previewing, setPreviewing] = useState(false)
  const [history, setHistory] = useState<ConversationEntry[] | null>(null)
  const [clearingHistory, setClearingHistory] = useState(false)
  const [modelOverview, setModelOverview] = useState<ModelOverviewResult | null>(null)
  const [benchmarking, setBenchmarking] = useState(false)
  const [benchmarkLog, setBenchmarkLog] = useState<string[]>([])
  // Compteurs "N/M" lisibles par un humain (nombre de MODÈLES téléchargés, nombre de TESTS effectués) — pas
  // ce qui pilote la barre/l'ETA (voir progressFraction plus bas), juste un texte informatif à côté.
  const [pullCount, setPullCount] = useState<{ done: number; total: number } | null>(null)
  const [testCount, setTestCount] = useState<{ done: number; total: number } | null>(null)
  // Avancement pondéré global (0..1), Go à télécharger + poids de test confondus dans UN SEUL total (voir
  // ##PROGRESS## côté script) : il n'y a plus de "phase 1 puis phase 2" à afficher séparément, téléchargement
  // et test avancent en même temps.
  const [progressFraction, setProgressFraction] = useState(0)
  // Temps restant estimé (ms), affiché à côté de la barre. `null` = pas encore assez de recul pour estimer
  // (tout début du run, ou rythme pas encore mesurable) plutôt que d'afficher un chiffre qui n'a pas de sens.
  const [etaMs, setEtaMs] = useState<number | null>(null)
  // État de CHAQUE modèle candidat pendant un run, affiché dans le tableau de suivi en direct ci-dessous (à
  // la place du journal brut) : où en est-il, palier par palier — voir ModelRunStatus plus bas.
  const [modelRunStatus, setModelRunStatus] = useState<Record<string, ModelRunStatus>>({})
  const audioRef = useRef<HTMLAudioElement>(null)
  const audioUrlRef = useRef<string | null>(null)
  const benchmarkLogRef = useRef<HTMLPreElement>(null)
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

  useEffect(() => {
    window.jaris.getGmailStatus().then(setStatus)
    window.jaris.getProfile().then((p) => {
      setProfile(p)
      const savedIndex = TTS_VOICES.findIndex((v) => v.id === p?.ttsVoice)
      if (savedIndex !== -1) setVoiceIndex(savedIndex)
    })
  }, [])

  // Chargé seulement à l'ouverture de l'onglet (pas au montage comme les autres réglages ci-dessus) :
  // l'historique peut contenir jusqu'à 300 échanges, pas la peine de le lire à chaque ouverture du menu
  // Options si l'utilisateur ne va jamais voir cet onglet.
  useEffect(() => {
    if (tab === 'historique' && history === null) {
      void window.jaris.getConversationHistory().then(setHistory)
    }
  }, [tab, history])

  // Idem pour le tableau comparatif des modèles candidats (relit scripts/benchmark-results.md côté main) :
  // pas la peine à chaque ouverture du menu si l'utilisateur ne va jamais voir cet onglet.
  useEffect(() => {
    if (tab === 'modeles' && modelOverview === null) {
      void window.jaris.getModelOverview().then(setModelOverview)
    }
  }, [tab, modelOverview])

  // Les lignes ##PULL_PROGRESS##/##PULL_MODEL_PROGRESS##/##TEST_PROGRESS##/##PROGRESS##/##MODEL_TESTING##/
  // ##MODEL_DONE##/##MODEL_SKIPPED## (scripts/benchmark-models.mjs) sont au format machine, jamais affichées
  // telles quelles : elles alimentent la barre de progression et le tableau de suivi plutôt que le journal.
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

  useEffect(() => {
    benchmarkLogRef.current?.scrollTo({ top: benchmarkLogRef.current.scrollHeight })
  }, [benchmarkLog])

  const handleRunAnalysis = async (): Promise<void> => {
    if (
      !window.confirm(
        'Ça va installer tout modèle candidat manquant qui tient dans la VRAM détectée (potentiellement ' +
          "plusieurs dizaines de Go), tester chacun d'eux (peut prendre longtemps), puis ACTIVER le " +
          'meilleur modèle de chaque palier et supprimer tout le reste. Continuer ?'
      )
    ) {
      return
    }
    setError(null)
    setBenchmarking(true)
    setBenchmarkLog([])
    setPullCount(null)
    setTestCount(null)
    setProgressFraction(0)
    setEtaMs(null)
    progressSamplesRef.current = []
    etaFrozenRef.current = null
    // Tableau de suivi initialisé avec TOUS les candidats connus (modelOverview, déjà chargé puisque ce
    // bouton vit dans l'onglet Modèles) à "en attente" : sans ça, un modèle n'apparaîtrait dans le tableau
    // qu'au moment où une ligne le mentionne pour la première fois, aucune vue d'ensemble avant que ça démarre.
    const initialStatus: Record<string, ModelRunStatus> = {}
    for (const group of modelOverview?.groups ?? []) {
      for (const entry of group.entries) initialStatus[entry.model] = { kind: 'pending' }
    }
    setModelRunStatus(initialStatus)
    try {
      const result = await window.jaris.runModelAnalysis()
      // Reflète tout de suite les nouveaux modèles retenus + le tableau comparatif à jour, sans avoir à
      // changer d'onglet et revenir pour forcer un rechargement.
      setProfile((prev) => (prev ? { ...prev, models: result.models, visionModel: result.visionModel, capacityScanDone: true } : prev))
      setModelOverview(await window.jaris.getModelOverview())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBenchmarking(false)
      setPullCount(null)
      setTestCount(null)
      setEtaMs(null)
    }
  }

  const handleClearHistory = async (): Promise<void> => {
    if (!window.confirm("Supprimer définitivement tout l'historique des conversations ?")) return
    setError(null)
    setClearingHistory(true)
    try {
      await window.jaris.clearConversationHistory()
      setHistory([])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setClearingHistory(false)
    }
  }

  const voice = useMemo(() => TTS_VOICES[voiceIndex], [voiceIndex])

  // Modèles actuellement retenus (un par palier + vision, depuis le profil ; plus le palier Code, qui n'a
  // pas de choix stocké dans le profil — voir modelOverview.codeModel), pour encadrer leur ligne dans le
  // tableau comparatif ci-dessous.
  const selectedModels = useMemo(() => {
    const set = new Set<string>()
    if (profile?.models?.flash) set.add(profile.models.flash)
    if (profile?.models?.medium) set.add(profile.models.medium)
    if (profile?.models?.large) set.add(profile.models.large)
    if (profile?.visionModel) set.add(profile.visionModel)
    if (modelOverview?.codeModel) set.add(modelOverview.codeModel)
    return set
  }, [profile, modelOverview])

  const handleConnect = (): void => {
    setError(null)
    setConnecting(true)
    window.jaris
      .connectGmail()
      .then(setStatus)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setConnecting(false))
  }

  const handleDisconnect = (): void => {
    setError(null)
    void window.jaris.disconnectGmail().then(() => setStatus({ connected: false, email: null }))
  }

  const chooseVoice = async (index: number): Promise<void> => {
    const nextIndex = (index + TTS_VOICES.length) % TTS_VOICES.length
    setVoiceIndex(nextIndex)
    setError(null)
    setPreviewing(true)
    try {
      const nextVoice = TTS_VOICES[nextIndex]
      const audio = await window.jaris.previewVoice(nextVoice.id)
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current)
      const blob = new Blob([audio], { type: 'audio/wav' })
      audioUrlRef.current = URL.createObjectURL(blob)
      if (audioRef.current) {
        audioRef.current.src = audioUrlRef.current
        await audioRef.current.play()
      }

      if (profile) {
        const updated = { ...profile, ttsVoice: nextVoice.id }
        setProfile(updated)
        await window.jaris.saveProfile(updated)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPreviewing(false)
    }
  }

  if (!open) {
    return (
      <button className="options-menu__trigger" onClick={() => setOpen(true)}>
        Options
      </button>
    )
  }

  return (
    <div className="options-page">
      <div className="options-page__header">
        <div className="options-menu__tabs">
          <button
            className={`options-menu__tab${tab === 'connexions' ? ' options-menu__tab--active' : ''}`}
            onClick={() => setTab('connexions')}
          >
            Connexions
          </button>
          <button
            className={`options-menu__tab${tab === 'voix' ? ' options-menu__tab--active' : ''}`}
            onClick={() => setTab('voix')}
          >
            Voix
          </button>
          <button
            className={`options-menu__tab${tab === 'modeles' ? ' options-menu__tab--active' : ''}`}
            onClick={() => setTab('modeles')}
          >
            Modèles
          </button>
          <button
            className={`options-menu__tab${tab === 'historique' ? ' options-menu__tab--active' : ''}`}
            onClick={() => setTab('historique')}
          >
            Historique
          </button>
        </div>
        <button className="options-page__close" onClick={() => setOpen(false)}>
          Fermer
        </button>
      </div>

      <div className="options-page__content">
        {tab === 'connexions' && (
          <div className="options-menu__section">
            <div className="options-menu__section-title">Mail</div>
            {status?.connected ? (
              <>
                <div className="options-menu__account">{status.email}</div>
                <button className="options-menu__action" onClick={handleDisconnect}>
                  Déconnecter
                </button>
              </>
            ) : (
              <button className="options-menu__action" onClick={handleConnect} disabled={connecting}>
                {connecting ? 'Connexion...' : 'Connecter Gmail'}
              </button>
            )}
          </div>
        )}

        {tab === 'voix' && (
          <div className="options-menu__voice-picker">
            <div className="options-menu__voice-nav">
              <button className="options-menu__arrow" onClick={() => void chooseVoice(voiceIndex - 1)} disabled={previewing}>
                ‹
              </button>
              <div className="options-menu__voice-orb" style={{ background: voice.gradient }} />
              <button className="options-menu__arrow" onClick={() => void chooseVoice(voiceIndex + 1)} disabled={previewing}>
                ›
              </button>
            </div>
            <div className="options-menu__voice-name">{previewing ? 'Lecture...' : voice.id}</div>
            <div className="options-menu__voice-description">{voice.description}</div>
            <div className="options-menu__voice-dots">
              {TTS_VOICES.map((v, i) => (
                <button
                  key={v.id}
                  className={`options-menu__dot${i === voiceIndex ? ' options-menu__dot--active' : ''}`}
                  onClick={() => void chooseVoice(i)}
                  disabled={previewing}
                  aria-label={v.id}
                />
              ))}
            </div>
          </div>
        )}

        {tab === 'modeles' && (
          <div className="options-menu__section">
            <div className="options-menu__section-title">Modèles actuellement retenus</div>
            <div className="options-menu__current-picks">
              {TIER_LABELS.map(({ key, label, think }) => (
                <div key={key} className="options-menu__pick" title={`Réflexion : ${think}`}>
                  <span className="options-menu__pick-tier">{label}</span>
                  <span className="options-menu__pick-model">{profile?.models?.[key] ?? '—'}</span>
                </div>
              ))}
              <div className="options-menu__pick">
                <span className="options-menu__pick-tier">Vision</span>
                <span className="options-menu__pick-model">{profile?.visionModel ?? '—'}</span>
              </div>
              <div className="options-menu__pick">
                <span className="options-menu__pick-tier">Code</span>
                <span className="options-menu__pick-model">{modelOverview?.codeModel ?? '—'}</span>
              </div>
            </div>

            <div className="options-menu__section-title options-menu__model-overview-title">Tous les modèles candidats</div>
            {modelOverview === null ? (
              <p className="capacity-scan__status">Chargement...</p>
            ) : (
              <div className="options-menu__model-overview-scroll">
                {modelOverview.groups.map((group) => {
                  // Chaque palier a sa propre épreuve (appel d'outils pour la conversation, compréhension
                  // d'image pour Vision, génération de HTML valide pour Code) — la colonne change de nom en
                  // conséquence. L'intelligence (MMLU-Pro) ne s'applique qu'aux modèles de conversation :
                  // masquée plutôt qu'affichée vide partout ailleurs.
                  const isVision = group.tier === 'Vision'
                  const isCode = group.tier === 'Code'
                  const reliabilityLabel = isVision ? 'Précision' : isCode ? 'Qualité du code' : 'Tool-calling'
                  return (
                    <div key={group.tier} className="options-menu__model-group">
                      <div className="options-menu__model-group-title">{group.tier}</div>
                      <table className="options-menu__model-overview">
                        <thead>
                          <tr>
                            <th>Modèle</th>
                            <th className="options-menu__col-num">VRAM</th>
                            <th className="options-menu__col-num">Vitesse</th>
                            <th className="options-menu__col-num">{reliabilityLabel}</th>
                            {!isVision && <th className="options-menu__col-num">Intelligence</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {group.entries.map((entry) => (
                            <tr key={entry.model} className={selectedModels.has(entry.model) ? 'options-menu__model-row--selected' : undefined}>
                              <td className="options-menu__model-name" title={entry.model}>
                                {entry.model}
                              </td>
                              <td className="options-menu__col-num">{entry.vramGb} Go</td>
                              <td className="options-menu__col-num">
                                {entry.speedTokPerSec !== null ? `${entry.speedTokPerSec.toFixed(1)} tok/s` : '—'}
                              </td>
                              <td className="options-menu__col-num">
                                <ReliabilityBadge value={entry.toolCalling} />
                              </td>
                              {!isVision && (
                                <td className="options-menu__col-num">{entry.intelligence !== null ? entry.intelligence : '—'}</td>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )
                })}
              </div>
            )}
            <p className="options-menu__model-overview-hint">
              Entourés en cyan : les modèles actuellement retenus. Vitesse et fiabilité viennent d'un run
              local du bouton ci-dessous, s'il a déjà tourné sur cette machine — jamais pour ceux qui
              dépassent la VRAM détectée{modelOverview?.vramGb != null ? ` (${modelOverview.vramGb} Go)` : ''}.
              Intelligence = score MMLU-Pro publié, quand il existe.
            </p>

            <button className="options-menu__action" onClick={() => void handleRunAnalysis()} disabled={benchmarking}>
              {benchmarking ? 'Analyse en cours...' : 'Tester tous les modèles et choisir les meilleurs'}
            </button>
            <p className="options-menu__model-overview-hint">
              Teste chaque modèle candidat qui tient dans la VRAM, la RAM ET l'espace disque détectés
              (télécharge ceux qui manquent, jusqu'à 2 à la fois pendant que les modèles déjà installés
              passent déjà leurs tests, peut être plusieurs dizaines de Go au premier lancement), choisit et
              active le meilleur de chaque palier d'après les résultats (fiabilité d'appel d'outils, puis
              vitesse), et supprime tout le reste.
            </p>

            {benchmarking && (
              <div className="options-menu__progress">
                <div className="options-menu__progress-label">
                  Analyse en cours — {Math.round(progressFraction * 100)}%
                  {/* Pondéré par la vraie taille des modèles (voir ##PROGRESS## côté script), pas juste le
                      nombre de modèles restants — sinon un seul gros modèle en fin de liste faisait
                      s'effondrer l'estimation d'un coup. `null` tant qu'il n'y a pas assez de recul pour
                      estimer, plutôt qu'un chiffre inventé. */}
                  {etaMs !== null && <> — temps restant estimé : {formatEta(etaMs)}</>}
                </div>
                <div className="options-menu__progress-bar">
                  <div className="options-menu__progress-bar-fill" style={{ width: `${progressFraction * 100}%` }} />
                </div>
                {/* Téléchargement et test tournent maintenant en parallèle (PULL_CONCURRENCY côté script) :
                    plus de "Étape 1/2 puis 2/2", les deux compteurs avancent en même temps. */}
                <div className="options-menu__progress-sub">
                  {pullCount && (
                    <span>
                      Téléchargements : {pullCount.done}/{pullCount.total}
                    </span>
                  )}
                  {testCount && (
                    <span>
                      Tests : {testCount.done}/{testCount.total}
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Tableau de suivi en direct plutôt que le journal brut du script (retiré) : une vue d'ensemble
                de chaque candidat (en attente / en téléchargement / en cours de test / terminé / ignoré),
                pas un flux de texte à faire défiler pour deviner où en est le run. */}
            {benchmarking && modelOverview && (
              <div className="options-menu__model-overview-scroll">
                {modelOverview.groups.map((group) => (
                  <div key={group.tier} className="options-menu__model-group">
                    <div className="options-menu__model-group-title">{group.tier}</div>
                    <table className="options-menu__model-overview">
                      <tbody>
                        {group.entries.map((entry) => (
                          <tr key={entry.model}>
                            <td className="options-menu__model-name" title={entry.model}>
                              {entry.model}
                            </td>
                            <td>
                              <RunStatusBadge status={modelRunStatus[entry.model]} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            )}

            {/* Journal complet gardé seulement pour le cas d'erreur (le tableau ci-dessus ne montre pas le
                détail des messages) — jamais affiché en fonctionnement normal, à la demande de Léo ("enlève
                le panel le script en bas"). */}
            {!benchmarking && error && benchmarkLog.length > 0 && (
              <pre ref={benchmarkLogRef} className="options-menu__benchmark-log">
                {benchmarkLog.join('\n')}
              </pre>
            )}
          </div>
        )}

        {tab === 'historique' && (
          <div className="options-menu__section">
            <div className="options-menu__section-title">Historique des conversations</div>
            {history === null ? (
              <p className="capacity-scan__status">Chargement...</p>
            ) : history.length === 0 ? (
              <p className="options-menu__history-empty">Aucun échange enregistré pour l'instant.</p>
            ) : (
              <ul className="options-menu__history-list">
                {[...history].reverse().map((entry) => (
                  <li key={entry.id} className="options-menu__history-entry">
                    <div className="options-menu__history-date">{new Date(entry.timestamp).toLocaleString('fr-FR')}</div>
                    <div className="options-menu__history-transcript">« {entry.transcript} »</div>
                    <div className="options-menu__history-reply">{entry.reply}</div>
                  </li>
                ))}
              </ul>
            )}
            {history !== null && (
              <div className="options-menu__history-actions">
                <button className="options-menu__action" onClick={() => void window.jaris.openConversationHistoryFile()}>
                  Ouvrir le dossier
                </button>
                {history.length > 0 && (
                  <button
                    className="options-menu__action options-menu__action--danger"
                    onClick={() => void handleClearHistory()}
                    disabled={clearingHistory}
                  >
                    {clearingHistory ? 'Suppression...' : "Supprimer l'historique"}
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        <audio ref={audioRef} hidden />
        {error && <div className="options-menu__error">{error}</div>}
      </div>
    </div>
  )
}
