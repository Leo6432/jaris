import { useEffect, useMemo, useRef, useState } from 'react'
import type { AnalysisScope, AudioInputDevice, ConversationEntry, GmailStatus, ModelOverviewResult, ModelTiers, Profile } from '../../shared/ipc'
import { useModelAnalysis } from '../hooks/useModelAnalysis'
import ModelAnalysisProgress, { ANALYSIS_NOTICE } from './ModelAnalysisProgress'

/** Options du popup de choix de périmètre (voir handleRunAnalysis) — tout, ou un seul palier à la fois. */
const ANALYSIS_SCOPE_OPTIONS: Array<{ scope: AnalysisScope; label: string }> = [
  { scope: 'flash', label: 'Rapide seulement' },
  { scope: 'medium', label: 'Médium seulement' },
  { scope: 'large', label: 'Puissant seulement' },
  { scope: 'vision', label: 'Vision seulement' },
  { scope: 'code', label: 'Code seulement' }
]

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
  const audioRef = useRef<HTMLAudioElement>(null)
  const audioUrlRef = useRef<string | null>(null)
  // Logique de run + progression partagée avec l'écran d'onboarding (CapacityScan.tsx) — voir useModelAnalysis.
  const analysis = useModelAnalysis(modelOverview)
  const [scopeDialogOpen, setScopeDialogOpen] = useState(false)
  const [inputDevices, setInputDevices] = useState<AudioInputDevice[] | null>(null)
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[] | null>(null)
  const [savingAudioDevice, setSavingAudioDevice] = useState(false)
  const [micTesting, setMicTesting] = useState(false)
  const [micLevel, setMicLevel] = useState(0)
  const [micTestResult, setMicTestResult] = useState<boolean | null>(null)

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

  // Idem pour les listes de micros/haut-parleurs : coûteux à peupler pour rien si l'utilisateur ne va
  // jamais ouvrir l'onglet Voix. Les micros viennent de PortAudio (côté Python, voir --list-devices dans
  // voice_server.py) ; les haut-parleurs viennent de l'API navigateur MediaDevices — deux catalogues de
  // périphériques totalement séparés, qui ne peuvent pas être recoupés (voir la doc de setAudioInputDevice).
  useEffect(() => {
    if (tab !== 'voix' || inputDevices !== null) return
    void window.jaris.listAudioInputDevices().then(setInputDevices).catch(() => setInputDevices([]))
    // getUserMedia doit être appelé au moins une fois pour que enumerateDevices() révèle les vrais noms des
    // haut-parleurs plutôt que des libellés vides (voir le handler de permission media dans main.ts, qui
    // accorde silencieusement l'accès sans popup système).
    void navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => stream.getTracks().forEach((track) => track.stop()))
      .catch(() => {
        // Pas de micro accessible au navigateur ou permission refusée : enumerateDevices() ci-dessous
        // renverra quand même les haut-parleurs, juste sans libellé détaillé.
      })
      .finally(() => {
        void navigator.mediaDevices
          .enumerateDevices()
          .then((devices) => setOutputDevices(devices.filter((d) => d.kind === 'audiooutput')))
          .catch(() => setOutputDevices([]))
      })
  }, [tab, inputDevices])

  // Jauge de niveau + verdict pendant un test micro (voir mic_test_* dans voice_server.py), abonné une
  // seule fois au montage comme les autres onLog/onReply de l'appli (App.tsx) plutôt qu'à chaque ouverture
  // de l'onglet Voix.
  useEffect(() => {
    const offLevel = window.jaris.onMicTestLevel(({ level }) => setMicLevel(level))
    const offDone = window.jaris.onMicTestDone(({ detected }) => {
      setMicTesting(false)
      setMicTestResult(detected)
      setMicLevel(0)
    })
    return () => {
      offLevel()
      offDone()
    }
  }, [])

  const handleRunAnalysis = async (scope: AnalysisScope): Promise<void> => {
    setScopeDialogOpen(false)
    setError(null)
    try {
      const result = await analysis.run(scope)
      // Reflète tout de suite les nouveaux modèles retenus + le tableau comparatif à jour, sans avoir à
      // changer d'onglet et revenir pour forcer un rechargement.
      setProfile((prev) => (prev ? { ...prev, models: result.models, visionModel: result.visionModel, capacityScanDone: true } : prev))
      setModelOverview(await window.jaris.getModelOverview())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
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

  /**
   * Change de micro : sauvegardé côté main (profil) qui redémarre tout le pipeline vocal avec le nouvel
   * index (voir setAudioInputDevice dans main.ts — le sidecar Python n'ouvre son micro qu'une fois au
   * démarrage, changer de micro sans relancer n'est pas possible). Le rechargement des modèles (mot
   * d'activation + transcription) prend quelques secondes, d'où le message pendant `savingAudioDevice`.
   */
  const chooseInputDevice = async (value: string): Promise<void> => {
    setError(null)
    setSavingAudioDevice(true)
    setMicTestResult(null)
    try {
      const deviceIndex = value === '' ? null : Number(value)
      await window.jaris.setAudioInputDevice(deviceIndex)
      setProfile((prev) => (prev ? { ...prev, audioInputDeviceIndex: deviceIndex } : prev))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSavingAudioDevice(false)
    }
  }

  /**
   * Change de haut-parleur : contrairement au micro, pas de redémarrage nécessaire — juste enregistré dans
   * le profil, relu à chaque nouvelle réponse par le widget avant de lire l'audio (voir App.tsx, setSinkId).
   */
  const chooseOutputDevice = async (deviceId: string): Promise<void> => {
    if (!profile) return
    setError(null)
    const updated = { ...profile, audioOutputDeviceId: deviceId }
    setProfile(updated)
    try {
      await window.jaris.saveProfile(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const runMicTest = (): void => {
    setError(null)
    setMicTestResult(null)
    setMicTesting(true)
    window.jaris.testMicrophone()
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

            <div className="options-menu__section options-menu__audio-devices">
              <div className="options-menu__section-title">Micro &amp; haut-parleur</div>

              <label className="options-menu__field">
                <span>Micro utilisé</span>
                <select
                  value={profile?.audioInputDeviceIndex ?? ''}
                  onChange={(e) => void chooseInputDevice(e.target.value)}
                  disabled={inputDevices === null || savingAudioDevice}
                >
                  <option value="">Défaut du système</option>
                  {inputDevices?.map((device) => (
                    <option key={device.index} value={device.index}>
                      {device.name}
                    </option>
                  ))}
                </select>
              </label>
              {inputDevices !== null && inputDevices.length === 0 && (
                <p className="options-menu__model-overview-hint">Aucun micro détecté par PortAudio.</p>
              )}
              {savingAudioDevice && (
                <p className="options-menu__model-overview-hint">
                  Changement de micro : redémarrage du pipeline vocal (rechargement des modèles)...
                </p>
              )}

              <label className="options-menu__field">
                <span>Haut-parleur utilisé</span>
                <select
                  value={profile?.audioOutputDeviceId || ''}
                  onChange={(e) => void chooseOutputDevice(e.target.value)}
                  disabled={outputDevices === null}
                >
                  <option value="">Défaut du système</option>
                  {outputDevices?.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label || device.deviceId}
                    </option>
                  ))}
                </select>
              </label>

              <button className="options-menu__action" onClick={runMicTest} disabled={micTesting}>
                {micTesting ? 'Test en cours...' : 'Tester le micro'}
              </button>
              {micTesting && (
                <div className="options-menu__mic-meter">
                  <div className="options-menu__mic-meter-fill" style={{ width: `${Math.min(100, micLevel * 100)}%` }} />
                </div>
              )}
              {!micTesting && micTestResult !== null && (
                <p className={micTestResult ? 'options-menu__mic-result--ok' : 'options-menu__mic-result--bad'}>
                  {micTestResult ? 'Micro détecté : du son a bien été capté.' : "Rien capté : vérifie que le bon micro est sélectionné et qu'il n'est pas coupé."}
                </p>
              )}
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

            <button className="options-menu__action" onClick={() => setScopeDialogOpen(true)} disabled={analysis.benchmarking}>
              {analysis.benchmarking ? 'Analyse en cours...' : 'Tester tous les modèles et choisir les meilleurs'}
            </button>
            <p className="options-menu__model-overview-hint">
              Teste chaque modèle candidat qui tient dans la VRAM, la RAM ET l'espace disque détectés
              (télécharge ceux qui manquent, jusqu'à 2 à 4 à la fois selon la RAM détectée pendant que les
              modèles déjà installés passent déjà leurs tests, peut être plusieurs dizaines de Go au premier
              lancement), choisit et active le meilleur de chaque palier d'après les résultats (fiabilité
              d'appel d'outils, puis vitesse), et supprime tout le reste.
            </p>

            <ModelAnalysisProgress state={analysis} modelOverview={modelOverview} />

            {scopeDialogOpen && (
              <div className="options-menu__scope-dialog-overlay" onClick={() => setScopeDialogOpen(false)}>
                <div className="options-menu__scope-dialog" onClick={(e) => e.stopPropagation()}>
                  <h3>Quelle analyse lancer ?</h3>
                  <p>
                    Tout analyser installe tout modèle candidat manquant qui tient dans la VRAM/RAM/disque
                    détectés (potentiellement plusieurs dizaines de Go) et teste chacun d'eux — peut prendre
                    longtemps. Tester un seul palier est bien plus rapide et garde les résultats des autres
                    paliers inchangés. Dans les deux cas, le(s) meilleur(s) modèle(s) sont activés et le reste
                    est supprimé.
                  </p>
                  <p className="options-menu__analysis-notice">{ANALYSIS_NOTICE}</p>
                  <div className="options-menu__scope-dialog-options">
                    <button
                      className="options-menu__scope-dialog-all"
                      onClick={() => void handleRunAnalysis('all')}
                    >
                      Tout analyser
                    </button>
                    {ANALYSIS_SCOPE_OPTIONS.map(({ scope, label }) => (
                      <button key={scope} onClick={() => void handleRunAnalysis(scope)}>
                        {label}
                      </button>
                    ))}
                  </div>
                  <button className="options-menu__scope-dialog-cancel" onClick={() => setScopeDialogOpen(false)}>
                    Annuler
                  </button>
                </div>
              </div>
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
