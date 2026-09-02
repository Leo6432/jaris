import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AudioInputDevice,
  ConversationEntry,
  GmailStatus,
  HardwareTierPreview as HardwareTierPreviewData,
  OllamaVersionStatus,
  Profile
} from '../../shared/ipc'
import HardwareTierPreview from './HardwareTierPreview'

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

/**
 * Nombre de barres du visualiseur de test micro (façon Discord : une fenêtre glissante des derniers niveaux
 * sonores, pas un seul cercle qui pulse) — voir micLevels plus bas.
 */
const MIC_TEST_BAR_COUNT = 42

type Tab = 'connexions' | 'voix' | 'audio' | 'modeles' | 'historique'

/**
 * Chromium ajoute des pseudo-périphériques "default"/"communications" en plus des vrais haut-parleurs
 * physiques (mêmes libellés ou très proches, deviceId littéralement "default"/"communications") : les
 * exclure plutôt que de montrer 2-3 entrées pour le même haut-parleur physique. Dédupliqué par libellé au
 * cas où il en resterait quand même (rare, mais pas de raison de les montrer deux fois).
 */
function dedupeAudioOutputs(devices: MediaDeviceInfo[]): MediaDeviceInfo[] {
  const seenLabels = new Set<string>()
  const result: MediaDeviceInfo[] = []
  for (const device of devices) {
    if (device.kind !== 'audiooutput') continue
    if (device.deviceId === 'default' || device.deviceId === 'communications') continue
    const key = device.label.trim().toLowerCase()
    if (key && seenLabels.has(key)) continue
    if (key) seenLabels.add(key)
    result.push(device)
  }
  return result
}

/**
 * "3/3", "6/6" etc. en petit badge coloré (vert = parfait, ambre = partiel, rouge = raté) plutôt qu'en
 * texte brut au milieu du tableau — un coup d'œil suffit pour repérer les bons/mauvais élèves, pas besoin
 * de lire chaque cellule. "—" (jamais testé) reste un texte neutre, pas un badge. Exporté : réutilisé par
 * HardwareTierPreview.tsx (paliers de configuration) et ModelAnalysisProgress.tsx (analyse comparative
 * complète, toujours lançable via `npm run benchmark:models`), pas seulement ici.
 */
export function ReliabilityBadge({ value }: { value: string | null }): JSX.Element {
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
  const [hardwareTiers, setHardwareTiers] = useState<HardwareTierPreviewData[] | null>(null)
  const [ollamaVersionStatus, setOllamaVersionStatus] = useState<OllamaVersionStatus | null>(null)
  const [updatingOllama, setUpdatingOllama] = useState(false)
  const [ollamaUpdateMessage, setOllamaUpdateMessage] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const audioUrlRef = useRef<string | null>(null)
  const [retestingConfig, setRetestingConfig] = useState(false)
  const [inputDevices, setInputDevices] = useState<AudioInputDevice[] | null>(null)
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[] | null>(null)
  const [savingAudioDevice, setSavingAudioDevice] = useState(false)
  const [micTesting, setMicTesting] = useState(false)
  // Fenêtre glissante des derniers niveaux sonores (une valeur par évènement mic_test_level, ~12/seconde) :
  // affichée comme une rangée de barres qui défilent façon Discord, pas un seul chiffre.
  const [micLevels, setMicLevels] = useState<number[]>(() => Array(MIC_TEST_BAR_COUNT).fill(0))
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

  // Pas la peine à chaque ouverture du menu si l'utilisateur ne va jamais voir cet onglet Modèles :
  // previewHardwareTiers relit scripts/verified-tool-scores.md/benchmark-results.md côté main.
  useEffect(() => {
    if (tab === 'modeles' && hardwareTiers === null) {
      void window.jaris.previewHardwareTiers().then(setHardwareTiers)
    }
  }, [tab, hardwareTiers])

  // Contrairement à hardwareTiers ci-dessus (coûteux, relit un fichier), une simple lecture d'une valeur
  // déjà en cache côté main (voir getOllamaVersionStatus) : pas besoin de garde "déjà chargé", on relit à
  // chaque ouverture de l'onglet — utile si le check réseau en tâche de fond au lancement de Jaris n'avait
  // pas encore fini la première fois que l'utilisateur a ouvert cet onglet.
  useEffect(() => {
    if (tab === 'modeles') {
      void window.jaris.getOllamaVersionStatus().then(setOllamaVersionStatus)
    }
  }, [tab])

  // Idem pour les listes de micros/haut-parleurs : coûteux à peupler pour rien si l'utilisateur ne va
  // jamais ouvrir l'onglet Micro & Haut-parleur. Les micros viennent de PortAudio (côté Python, voir
  // --list-devices dans voice_server.py) ; les haut-parleurs viennent de l'API navigateur MediaDevices —
  // deux catalogues de périphériques totalement séparés, qui ne peuvent pas être recoupés (voir la doc de
  // setAudioInputDevice).
  useEffect(() => {
    if (tab !== 'audio' || inputDevices !== null) return
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
          .then((devices) => setOutputDevices(dedupeAudioOutputs(devices)))
          .catch(() => setOutputDevices([]))
      })
  }, [tab, inputDevices])

  // Visualiseur + verdict pendant un test micro (voir mic_test_* dans voice_server.py), abonné une seule
  // fois au montage comme les autres onLog/onReply de l'appli (App.tsx) plutôt qu'à chaque ouverture de
  // l'onglet Micro & Haut-parleur.
  useEffect(() => {
    const offLevel = window.jaris.onMicTestLevel(({ level }) =>
      setMicLevels((prev) => [...prev.slice(1), level])
    )
    const offDone = window.jaris.onMicTestDone(({ detected }) => {
      setMicTesting(false)
      setMicTestResult(detected)
    })
    return () => {
      offLevel()
      offDone()
    }
  }, [])

  // Redétecte le matériel (VRAM/RAM) et télécharge directement les modèles déjà connus pour cette
  // configuration (runQuickSetup, même chemin que l'écran d'accueil) — utile après un changement matériel
  // (nouvelle carte graphique...), sans repasser par l'ancienne analyse comparative complète (des dizaines
  // de minutes à tout retélécharger/retester alors que verified-tool-scores.md connaît déjà le gagnant).
  const handleRetestConfiguration = async (): Promise<void> => {
    setError(null)
    setRetestingConfig(true)
    try {
      const result = await window.jaris.runQuickSetup()
      setProfile((prev) => (prev ? { ...prev, models: result.models, visionModel: result.visionModel, capacityScanDone: true } : prev))
      setHardwareTiers(await window.jaris.previewHardwareTiers())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRetestingConfig(false)
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

  const handleUpdateOllama = (): void => {
    setUpdatingOllama(true)
    setOllamaUpdateMessage(null)
    window.jaris
      .updateOllama()
      .then(({ message }) => {
        setOllamaUpdateMessage(message)
        return window.jaris.getOllamaVersionStatus()
      })
      .then(setOllamaVersionStatus)
      .finally(() => setUpdatingOllama(false))
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

  /**
   * Bascule le test micro plutôt qu'un test à durée fixe : l'utilisateur active quand il veut parler et
   * désactive lui-même quand il a fini (voir stopTestMic dans voice_server.py). L'arrêt est appliqué tout
   * de suite côté UI (pas seulement envoyé au sidecar) : si le pipeline vocal n'est pas dans un état sain
   * (ex: le micro n'a pas pu s'ouvrir), la commande stop est silencieusement ignorée côté main/sidecar et le
   * bouton resterait bloqué sur "Arrêter le test" pour toujours sans ça — voir mic_test_done qui, lui,
   * arrivera quand même mettre à jour le verdict s'il finit par arriver.
   */
  const toggleMicTest = (): void => {
    if (micTesting) {
      window.jaris.stopTestMicrophone()
      setMicTesting(false)
      setMicLevels(Array(MIC_TEST_BAR_COUNT).fill(0))
      return
    }
    setError(null)
    setMicTestResult(null)
    setMicLevels(Array(MIC_TEST_BAR_COUNT).fill(0))
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
            className={`options-menu__tab${tab === 'audio' ? ' options-menu__tab--active' : ''}`}
            onClick={() => setTab('audio')}
          >
            Micro &amp; Haut-parleur
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
        <button
          className="options-page__close"
          onClick={() => {
            // Un test micro actif tourne côté sidecar indépendamment de cette fenêtre (voir voice_server.py) :
            // sans ça, fermer Options pendant un test le laisserait actif en arrière-plan, sans bouton pour
            // l'arrêter puisque ce panneau n'est plus affiché. Reset local aussi (pas seulement l'envoi de
            // la commande) : ce composant ne démonte pas en fermant Options (voir `if (!open)` plus bas), la
            // prochaine ouverture doit donc retrouver "Tester le micro", pas "Arrêter le test" pour rien.
            if (micTesting) {
              window.jaris.stopTestMicrophone()
              setMicTesting(false)
              setMicLevels(Array(MIC_TEST_BAR_COUNT).fill(0))
            }
            setOpen(false)
          }}
        >
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

        {tab === 'audio' && (
          <div className="options-menu__section options-menu__audio-devices">
            <div className="options-menu__section-title">Micro utilisé</div>
            <label className="options-menu__field">
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

            <div className="options-menu__section-title">Haut-parleur utilisé</div>
            <label className="options-menu__field">
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

            <div className="options-menu__section-title">Tester le micro</div>
            <div className="options-menu__mic-test">
              {/* Rangée de barres façon Discord plutôt qu'un seul indicateur : chaque barre est un niveau
                  sonore récent (mic_test_level, ~12/seconde, voir voice_server.py), la plus récente à
                  droite — les anciennes défilent vers la gauche à mesure que de nouvelles arrivent
                  (micLevels ci-dessus), pour une vraie sensation de mouvement pendant qu'on parle plutôt
                  qu'un seul chiffre qui saute. */}
              <div className="options-menu__mic-bars">
                {micLevels.map((level, i) => (
                  <div
                    key={i}
                    className="options-menu__mic-bar"
                    style={{ height: `${10 + Math.min(1, level) * 90}%` }}
                  />
                ))}
              </div>
              <button
                className={`options-menu__action${micTesting ? ' options-menu__action--danger' : ''}`}
                onClick={toggleMicTest}
              >
                {micTesting ? 'Arrêter le test' : 'Tester le micro'}
              </button>
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
            {ollamaVersionStatus?.outdated && (
              <div className="options-menu__ollama-warning">
                Ollama {ollamaVersionStatus.current} installé, la dernière version est{' '}
                {ollamaVersionStatus.latest} — certains modèles récents peuvent refuser de se télécharger tant
                qu'Ollama n'est pas à jour.
                <div className="options-menu__ollama-update-actions">
                  <button onClick={handleUpdateOllama} disabled={updatingOllama}>
                    {updatingOllama ? 'Mise à jour en cours…' : 'Mettre à jour'}
                  </button>
                  <a href="https://ollama.com/download" target="_blank" rel="noreferrer">
                    ou télécharge manuellement sur ollama.com/download
                  </a>
                </div>
                {updatingOllama && (
                  <p className="options-menu__ollama-update-note">
                    Une fenêtre Windows peut demander une autorisation (élévation) — accepte-la pour continuer.
                  </p>
                )}
                {!updatingOllama && ollamaUpdateMessage && <p>{ollamaUpdateMessage}</p>}
              </div>
            )}

            <div className="options-menu__section-title">Les 3 paliers de configuration</div>
            {hardwareTiers === null ? (
              <p className="capacity-scan__status">Chargement...</p>
            ) : (
              <HardwareTierPreview tiers={hardwareTiers} />
            )}

            <button className="options-menu__action" onClick={() => void handleRetestConfiguration()} disabled={retestingConfig}>
              {retestingConfig ? 'Nouvelle détection en cours...' : 'Retester la configuration'}
            </button>
            <p className="options-menu__model-overview-hint">
              Redétecte la VRAM/RAM (utile après un changement matériel, par exemple une nouvelle carte
              graphique) et télécharge directement les modèles déjà connus pour cette nouvelle configuration,
              sans repasser par une analyse comparative complète.
            </p>
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
