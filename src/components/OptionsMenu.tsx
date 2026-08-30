import { useEffect, useMemo, useRef, useState } from 'react'
import type { ConversationEntry, GmailStatus, ModelOverviewResult, ModelTiers, Profile } from '../../shared/ipc'

interface VoiceOption {
  id: string
  description: string
  gradient: string
}

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
  const [benchmarkProgress, setBenchmarkProgress] = useState<{ phase: 'pull' | 'test'; done: number; total: number } | null>(null)
  // % de téléchargement du modèle EN COURS (pas juste "N modèles sur M") : un seul gros modèle
  // (qwen3.6:35b-a3b, north-mini-code-1.0...) ferait sinon stagner la barre plusieurs minutes d'affilée.
  const [currentPullPercent, setCurrentPullPercent] = useState(0)
  const audioRef = useRef<HTMLAudioElement>(null)
  const audioUrlRef = useRef<string | null>(null)
  const benchmarkLogRef = useRef<HTMLPreElement>(null)

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

  // Les lignes ##PULL_PROGRESS##/##PULL_MODEL_PROGRESS##/##TEST_PROGRESS## (scripts/benchmark-models.mjs)
  // sont au format machine, jamais affichées telles quelles : elles alimentent la barre de progression
  // plutôt que le journal.
  useEffect(() => {
    return window.jaris.onModelBenchmarkLine((line) => {
      const modelPullMatch = /^##PULL_MODEL_PROGRESS## (\d+)$/.exec(line)
      if (modelPullMatch) {
        setCurrentPullPercent(Number(modelPullMatch[1]))
        return
      }
      const pullMatch = /^##PULL_PROGRESS## (\d+) (\d+)$/.exec(line)
      if (pullMatch) {
        setBenchmarkProgress({ phase: 'pull', done: Number(pullMatch[1]), total: Number(pullMatch[2]) })
        return
      }
      const testMatch = /^##TEST_PROGRESS## (\d+) (\d+)$/.exec(line)
      if (testMatch) {
        setBenchmarkProgress({ phase: 'test', done: Number(testMatch[1]), total: Number(testMatch[2]) })
        return
      }
      setBenchmarkLog((prev) => [...prev, line])
    })
  }, [])

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
    setBenchmarkProgress(null)
    setCurrentPullPercent(0)
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
      setBenchmarkProgress(null)
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
              Teste chaque modèle candidat qui tient dans la VRAM détectée (télécharge ceux qui manquent,
              peut être plusieurs dizaines de Go au premier lancement), choisit et active le meilleur de
              chaque palier d'après les résultats (fiabilité d'appel d'outils, puis vitesse), et supprime
              tout le reste.
            </p>

            {benchmarkProgress &&
              (() => {
                // Pendant le téléchargement, le % du modèle en cours affine le compte "N/M" (sinon un seul
                // gros modèle ferait stagner la barre plusieurs minutes sans aucun mouvement visible).
                const fraction =
                  benchmarkProgress.phase === 'pull'
                    ? Math.min(1, (benchmarkProgress.done + currentPullPercent / 100) / Math.max(1, benchmarkProgress.total))
                    : Math.min(1, benchmarkProgress.done / Math.max(1, benchmarkProgress.total))

                return (
                  <div className="options-menu__progress">
                    <div className="options-menu__progress-label">
                      {/* Étape 1/2 puis 2/2, pas juste "Téléchargement"/"Test" : sans ce repère, la barre qui
                          retombe à 0 en passant du téléchargement au test donne l'impression que toute
                          l'analyse recommence depuis le début, alors que c'est la 2e étape qui démarre. */}
                      Étape {benchmarkProgress.phase === 'pull' ? '1/2' : '2/2'} —{' '}
                      {benchmarkProgress.phase === 'pull' ? 'Téléchargement' : 'Test'} : {benchmarkProgress.done}/{benchmarkProgress.total}
                      {benchmarkProgress.phase === 'pull' && currentPullPercent > 0 && currentPullPercent < 100 && (
                        <> (modèle en cours : {currentPullPercent}%)</>
                      )}
                    </div>
                    <div className="options-menu__progress-bar">
                      <div className="options-menu__progress-bar-fill" style={{ width: `${fraction * 100}%` }} />
                    </div>
                  </div>
                )
              })()}

            {(benchmarking || benchmarkLog.length > 0) && (
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
