import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  AppVersionStatus,
  AudioInputDevice,
  ContextLengthOptions,
  ConversationEntry,
  MyModelPicks as MyModelPicksData,
  ModelsLocationStatus,
  OllamaVersionStatus,
  Profile,
  UpdateProgress
} from '../../shared/ipc'
import { CAPABILITIES } from '../../shared/capabilities'
import AllModelsOverview from './AllModelsOverview'
import AppUpdateProgress from './AppUpdateProgress'
import MyModelPicks from './MyModelPicks'
import JarisOrb from './JarisOrb'
import { formatModelName } from '../lib/formatModelName'
import { formatContextLength } from '../lib/formatContextLength'

interface VoiceOption {
  id: string
  description: string
  /** Couleur de l'anneau JarisOrb pour distinguer cette voix (voir color? dans JarisOrb.tsx) — même forme
   * (anneau déchiqueté) que sur l'accueil pour toutes les voix, JAMAIS un cercle lisse générique : seule la
   * couleur change, à la demande explicite de Léo ("fait pas un cercle rond... fait le même cercle que dans
   * l'accueil... change juste la couleur pour différencier les voix"). */
  color: string
}

const TTS_VOICES: VoiceOption[] = [
  { id: 'M1', description: 'Vive, énergique', color: '#37e2ff' },
  { id: 'M2', description: 'Grave, sérieuse', color: '#2b6cff' },
  { id: 'M3', description: 'Autoritaire, confiante', color: '#6c5ce7' },
  { id: 'M4', description: 'Douce, jeune', color: '#55e6c1' },
  { id: 'M5', description: 'Chaleureuse, narrative', color: '#feca57' },
  { id: 'F1', description: 'Calme, posée', color: '#ff9ff3' },
  { id: 'F2', description: 'Vive, enjouée', color: '#ff6b81' },
  { id: 'F3', description: 'Professionnelle', color: '#48dbfb' },
  { id: 'F4', description: 'Nette, confiante', color: '#c8d6e5' },
  { id: 'F5', description: 'Douce, bienveillante', color: '#ffb8b8' }
]

const DEFAULT_VOICE_INDEX = TTS_VOICES.findIndex((v) => v.id === 'M3')

/**
 * Nombre de barres du visualiseur de test micro (façon Discord : une fenêtre glissante des derniers niveaux
 * sonores, pas un seul cercle qui pulse) — voir micLevels plus bas.
 */
const MIC_TEST_BAR_COUNT = 42

// Refonte étape 115 (Léo : "il ya des categorie dans les options qui peuvent etre ensemble, refait
// totalement option bien comme claude gpt") : Micro et Activation (2 réglages, chacun quelques lignes)
// n'avaient aucune raison d'être des onglets à part entière — regroupés dans "Voix", qui parle déjà de
// l'expérience vocale dans son ensemble. Même chose pour Mise à jour/Stockage/Historique, trois réglages
// "à propos de l'application" plutôt que trois sujets distincts — regroupés dans "Général", à la manière du
// même onglet chez ChatGPT/Claude (thème, langue, effacer les discussions...). 9 onglets -> 5.
type Tab = 'capacites' | 'voix' | 'modeles' | 'general'

/**
 * Titre + sous-titre en tête de chaque page de réglages (design importé, "Options Jaris.dc.html") —
 * absents du code jusqu'ici : les 3 comparaisons précédentes (v0.14.6 à v0.14.9) s'étaient concentrées sur
 * le contenu DES cartes, jamais sur ce qui vit AU-DESSUS d'elles, repéré seulement quand Léo a renvoyé une
 * capture de la page COMPLÈTE plutôt que juste le panneau recadré ("non tu a pas compris ma demande...").
 * "Ce que Jaris sait faire" (capacites) garde sa propre phrase d'intro DANS sa section (étape 111), pas ce
 * gabarit — seuls les 3 onglets de réglages en ont besoin.
 */
const TAB_META: Partial<Record<Tab, { title: string; subtitle: string }>> = {
  voix: { title: 'Voix', subtitle: "La voix de Jaris, les périphériques qu'il utilise, et les façons de le réveiller." },
  modeles: { title: 'Modèles', subtitle: 'Ce que ta machine fait tourner, et combien Jaris garde en tête pendant une conversation.' },
  general: { title: 'Général', subtitle: "L'application elle-même : version, fichiers, historique." }
}

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
 * MyModelPicks.tsx (modèles choisis pour ta machine) et ModelAnalysisProgress.tsx (analyse comparative
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

/**
 * Une ligne de réglage uniforme (étape 116, Léo : "tu voit sur claude chatgpt tout se ressemble mais dans
 * les option rien ne se ressemble micro comment se déclencher") : intitulé + description à gauche, le
 * contrôle (case à cocher, menu déroulant, bouton, valeur en lecture seule...) aligné à droite. Avant cette
 * refonte, chaque type de réglage avait sa propre mise en forme ad hoc (`.options-menu__field` pour un menu
 * déroulant, `.options-menu__checkbox` en ligne isolée pour une case à cocher, un bouton nu pour une action)
 * — Léo comparait "Micro utilisé" (un menu) et "Comment se déclencher" (des cases) et n'y voyait aucun point
 * commun. `stacked` réserve le cas où le contrôle a besoin de toute la largeur (le curseur de longueur de
 * contexte, un visualiseur de micro) plutôt que de rester coincé à droite d'une ligne étroite.
 */
function SettingRow({
  label,
  description,
  stacked = false,
  className,
  children
}: {
  label: string
  description?: React.ReactNode
  stacked?: boolean
  className?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className={`options-menu__row${stacked ? ' options-menu__row--stacked' : ''}${className ? ` ${className}` : ''}`}>
      <div className="options-menu__row-text">
        <span className="options-menu__row-label">{label}</span>
        {description && <p className="options-menu__row-description">{description}</p>}
      </div>
      <div className="options-menu__row-control">{children}</div>
    </div>
  )
}

/**
 * Interrupteur à coins coupés (refonte visuelle Options, étape 119 — maquette `Options Jaris.dc.html`),
 * remplace la case à cocher native utilisée jusqu'ici dans `SettingRow` : une case de formulaire par défaut
 * est la seule commande de tout l'écran qui ne suivait pas la famille de boutons HUD (coins coupés en
 * `clip-path`, pas de coins arrondis). Un `<button role="switch">` plutôt qu'un vrai `<input type="checkbox">`
 * stylé : impossible d'obtenir un rail + curseur en `clip-path` sur une case native (son apparence est
 * remplacée en bloc par `accent-color`/`appearance`, pas composée de deux calques indépendants) — `aria-checked`
 * garde la même sémantique d'accessibilité qu'une case à cocher pour qui utilise un lecteur d'écran.
 */
function Toggle({
  checked,
  onChange,
  disabled = false,
  label
}: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  label: string
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`options-menu__switch${checked ? ' options-menu__switch--on' : ''}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="options-menu__switch-knob" />
    </button>
  )
}

/** Regroupe plusieurs `SettingRow` dans une même carte (fond + bordure), avec un titre au-dessus — le
 *  "groupe de réglages" façon Claude/ChatGPT, plutôt que des lignes qui flottent seules dans la page. */
function SettingGroup({
  title,
  description,
  children
}: {
  title: string
  description?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="options-menu__group">
      <div className="options-menu__section-title">{title}</div>
      {description && <p className="options-menu__group-description">{description}</p>}
      <div className="options-menu__group-rows">{children}</div>
    </div>
  )
}

export default function OptionsMenu(): JSX.Element {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('voix')
  const [error, setError] = useState<string | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [voiceIndex, setVoiceIndex] = useState(DEFAULT_VOICE_INDEX)
  const [previewing, setPreviewing] = useState(false)
  const [history, setHistory] = useState<ConversationEntry[] | null>(null)
  const [clearingHistory, setClearingHistory] = useState(false)
  const [myPicks, setMyPicks] = useState<MyModelPicksData | null>(null)
  /**
   * Curseur de longueur de contexte (Léo : "jaris voit les model et regarde la vram et propose une barre
   * comme sur ollama... personnalisé à chacun pour que le dernier ne dépasse pas la vram") — `null` tant
   * que non chargé, recalculé à chaque ouverture de l'onglet (voir l'effet plus bas).
   */
  const [contextLengthOptions, setContextLengthOptions] = useState<ContextLengthOptions | null>(null)
  const [savingContextLength, setSavingContextLength] = useState(false)
  const [ollamaVersionStatus, setOllamaVersionStatus] = useState<OllamaVersionStatus | null>(null)
  const [updatingOllama, setUpdatingOllama] = useState(false)
  const [ollamaUpdateMessage, setOllamaUpdateMessage] = useState<string | null>(null)
  const [appVersionStatus, setAppVersionStatus] = useState<AppVersionStatus | null>(null)
  const [installedVersion, setInstalledVersion] = useState<string | null>(null)
  const [updatingApp, setUpdatingApp] = useState(false)
  const [appUpdateMessage, setAppUpdateMessage] = useState<string | null>(null)
  /** Avancement du téléchargement en cours (étape 98) — `null` tant qu'aucun octet n'est encore arrivé. */
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress | null>(null)
  const [ollamaUpdateProgress, setOllamaUpdateProgress] = useState<UpdateProgress | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [updateCheckMessage, setUpdateCheckMessage] = useState<string | null>(null)
  const [modelsLocation, setModelsLocation] = useState<ModelsLocationStatus | null>(null)
  const [movingModelsLocation, setMovingModelsLocation] = useState(false)
  const [modelsLocationMessage, setModelsLocationMessage] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const audioUrlRef = useRef<string | null>(null)
  const [retestingConfig, setRetestingConfig] = useState(false)
  const [inputDevices, setInputDevices] = useState<AudioInputDevice[] | null>(null)
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[] | null>(null)
  const [savingAudioDevice, setSavingAudioDevice] = useState(false)
  const [savingWakewordSetting, setSavingWakewordSetting] = useState(false)
  const [micTesting, setMicTesting] = useState(false)
  // Fenêtre glissante des derniers niveaux sonores (une valeur par évènement mic_test_level, ~12/seconde) :
  // affichée comme une rangée de barres qui défilent façon Discord, pas un seul chiffre.
  const [micLevels, setMicLevels] = useState<number[]>(() => Array(MIC_TEST_BAR_COUNT).fill(0))
  const [micTestResult, setMicTestResult] = useState<boolean | null>(null)

  useEffect(() => {
    window.jaris.getProfile().then((p) => {
      setProfile(p)
      const savedIndex = TTS_VOICES.findIndex((v) => v.id === p?.ttsVoice)
      if (savedIndex !== -1) setVoiceIndex(savedIndex)
    })
  }, [])

  // Prévient main.ts (`optionsOpen`) à chaque ouverture/fermeture — Léo : "quand on est dans les option,
  // jaris ne doit pas partir en widget quand on part". Cette page vit dans fullWindow (pas une fenêtre à
  // part), donc rien côté main ne savait jusqu'ici la distinguer du reste de l'app pour le handler 'blur'
  // (repli en widget sur perte de focus). Effet de nettoyage (composant jamais démonté en pratique, mais un
  // `true` oublié à `false` bloquerait le repli en widget pour toute la session) plutôt qu'un simple appel
  // dans les deux handlers `onClick` d'ouverture/fermeture, pour ne dépendre que d'UNE seule source de
  // vérité (`open`) au lieu de deux endroits à synchroniser à la main.
  useEffect(() => {
    window.jaris.setOptionsOpen(open)
    return () => window.jaris.setOptionsOpen(false)
  }, [open])

  // Chargé seulement à l'ouverture de l'onglet (pas au montage comme les autres réglages ci-dessus) :
  // l'historique peut contenir jusqu'à 300 échanges, pas la peine de le lire à chaque ouverture du menu
  // Options si l'utilisateur ne va jamais voir cet onglet.
  useEffect(() => {
    if (tab === 'general' && history === null) {
      void window.jaris.getConversationHistory().then(setHistory)
    }
  }, [tab, history])

  // Pas la peine à chaque ouverture du menu si l'utilisateur ne va jamais voir cet onglet Modèles :
  // getMyModelPicks relit scripts/verified-tool-scores.md/benchmark-results.md côté main.
  // PAS de lecture automatique à l'ouverture de l'onglet, contrairement aux autres réglages : la toute
  // première lecture déclenche une demande d'autorisation Windows (documenté par Microsoft pour
  // UserNotificationListener). Une fenêtre système qui surgit parce qu'on a simplement ouvert un onglet
  // serait incompréhensible — c'est le clic sur le bouton qui la provoque, en sachant pourquoi.

  useEffect(() => {
    if (tab === 'modeles' && myPicks === null) {
      void window.jaris.getMyModelPicks().then(setMyPicks)
    }
  }, [tab, myPicks])

  // Contrairement à myPicks ci-dessus (coûteux, relit un fichier), une simple lecture d'une valeur
  // déjà en cache côté main (voir getOllamaVersionStatus) : pas besoin de garde "déjà chargé", on relit à
  // chaque ouverture de l'onglet — utile si le check réseau en tâche de fond au lancement de Jaris n'avait
  // pas encore fini la première fois que l'utilisateur a ouvert cet onglet.
  useEffect(() => {
    if (tab === 'modeles') {
      void window.jaris.getOllamaVersionStatus().then(setOllamaVersionStatus)
      // Recalculé à CHAQUE ouverture de l'onglet, jamais mis en cache : la VRAM libre change d'un
      // lancement à l'autre selon ce qui tourne en parallèle sur la machine (jeu, navigateur...).
      void window.jaris.getContextLengthOptions().then(setContextLengthOptions)
    }
    if (tab === 'general') {
      void window.jaris.getAppVersionStatus().then(setAppVersionStatus)
      void window.jaris.getAppVersion().then(setInstalledVersion)
      // "Fichiers et moteur local" (Ollama + dossier des modèles) a rejoint Général à l'étape 122, sur
      // demande explicite de Léo — ces deux lectures doivent donc s'armer avec l'onglet, pas avec 'modeles'
      // qui ne montre plus ce bloc depuis ce même correctif (sinon la carte resterait vide au premier clic).
      void window.jaris.getOllamaVersionStatus().then(setOllamaVersionStatus)
      void window.jaris.getModelsLocationStatus().then(setModelsLocation)
    }
  }, [tab])

  // Avancement du déplacement (Ollama/Python arrêtés, copie en cours, redémarrage...) : abonné une seule
  // fois comme les autres onLog/onModelBenchmarkLine, pas seulement pendant que l'onglet Modèles est ouvert
  // — l'opération continue même si l'utilisateur change d'onglet entre-temps.
  useEffect(() => {
    return window.jaris.onModelsLocationProgress(setModelsLocationMessage)
  }, [])

  // Même raisonnement pour le téléchargement de la mise à jour (étape 98) : abonné une seule fois au
  // montage, pas seulement pendant que l'onglet "Mise à jour" est affiché — le téléchargement continue si
  // l'utilisateur change d'onglet entre-temps, et l'avancement doit être à jour quand il revient.
  // Les deux boutons ("Mettre à jour" de Jaris et celui d'Ollama) partagent ce canal depuis l'étape 112 :
  // chacun ne garde QUE les avancements qui le concernent. Sans ce tri, télécharger l'installeur d'Ollama
  // ferait avancer la barre de l'onglet "Mise à jour" de Jaris, qui ne télécharge pourtant rien du tout.
  useEffect(() => {
    return window.jaris.onUpdateProgress((progress) => {
      if (progress.target === 'ollama') setOllamaUpdateProgress(progress)
      else setUpdateProgress(progress)
    })
  }, [])

  const handleContextLengthChange = (value: number): void => {
    // Optimiste : le curseur bouge tout de suite, l'enregistrement se fait en tâche de fond. `current`
    // est le seul champ qui change ; `max`/`availableSteps` restent ceux déjà calculés pour cette machine.
    setContextLengthOptions((prev) => (prev ? { ...prev, current: value } : prev))
    setSavingContextLength(true)
    window.jaris
      .setContextLength(value)
      .catch(() => {})
      .finally(() => setSavingContextLength(false))
  }

  const handleChooseModelsLocation = (): void => {
    setModelsLocationMessage(null)
    setMovingModelsLocation(true)
    window.jaris
      .chooseModelsLocation()
      .then(({ success, message }) => {
        if (message) setModelsLocationMessage(message)
        if (success) return window.jaris.getModelsLocationStatus().then(setModelsLocation)
      })
      .catch((err: unknown) => setModelsLocationMessage(err instanceof Error ? err.message : String(err)))
      .finally(() => setMovingModelsLocation(false))
  }

  // Idem pour les listes de micros/haut-parleurs : coûteux à peupler pour rien si l'utilisateur ne va
  // jamais ouvrir l'onglet Voix (Micro/Haut-parleur en fait partie depuis l'étape 115). Les micros
  // viennent de PortAudio (côté Python, voir
  // --list-devices dans voice_server.py) ; les haut-parleurs viennent de l'API navigateur MediaDevices —
  // deux catalogues de périphériques totalement séparés, qui ne peuvent pas être recoupés (voir la doc de
  // setAudioInputDevice).
  useEffect(() => {
    if (tab !== 'voix' || inputDevices !== null) return
    void window.jaris.listAudioInputDevices().then(setInputDevices).catch(() => setInputDevices([]))
    // `navigator.mediaDevices` n'existe que dans un contexte sécurisé (https/localhost) — absent en pratique
    // seulement hors production (bundle de test chargé sur about:blank, voir scripts/test-options-*-ui.mjs),
    // mais un accès direct sans garde plante toute la page Options (exception non rattrapée dans un effet React,
    // sans limite de dégâts) plutôt que de simplement laisser le haut-parleur au choix par défaut du système.
    if (!navigator.mediaDevices) {
      setOutputDevices([])
      return
    }
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
      setMyPicks(await window.jaris.getMyModelPicks())
      // Un modèle ignoré (trop gros pour VRAM+RAM, ou pas assez de disque) ne doit jamais passer inaperçu :
      // sans ça, le profil listait un modèle qui n'est en réalité pas installé, jusqu'à ce que Jaris échoue
      // à l'utiliser bien plus tard, loin du vrai moment de la cause (voir aussi CapacityScan.tsx).
      if (result.skippedModels?.length) {
        setError(
          `Configuration mise à jour, mais ${result.skippedModels.length > 1 ? 'ces modèles ont' : 'ce modèle a'} ` +
            `été ignoré : ${result.skippedModels.map((s) => `${s.model} (${s.reason})`).join(' ; ')}`
        )
      }
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

  /**
   * Contrairement à handleUpdateOllama ci-dessous, ne relit jamais le statut après coup : une mise à jour
   * réussie ferme Jaris une seconde plus tard (voir updateApp, appUpdater.ts) pour laisser l'installeur
   * remplacer l'exécutable — le message de succès reste affiché jusqu'à la fermeture plutôt que d'essayer
   * un appel IPC qui n'a plus grand sens à ce moment-là.
   */
  const handleUpdateApp = (): void => {
    setUpdatingApp(true)
    setAppUpdateMessage(null)
    // Remis à zéro à chaque tentative : sinon un nouvel essai après un échec repartirait visuellement du
    // pourcentage atteint la fois précédente, alors que le téléchargement, lui, recommence du début.
    setUpdateProgress(null)
    window.jaris
      .updateApp()
      .then(({ message }) => setAppUpdateMessage(message))
      .catch((err: unknown) => setAppUpdateMessage(err instanceof Error ? err.message : String(err)))
      .finally(() => setUpdatingApp(false))
  }

  /**
   * Bouton "Rechercher une mise à jour" (façon Windows Update) : contrairement au check silencieux au
   * démarrage (checkAppFreshness), celui-ci force une vraie requête réseau et affiche le résultat explicite
   * — trouvé, à jour, ou l'erreur telle quelle (utile pour diagnostiquer un réseau qui bloque l'accès à
   * GitHub, cas où le bandeau automatique ne peut jamais apparaître). Met aussi à jour appVersionStatus pour
   * que le bandeau "Mettre à jour" ci-dessus apparaisse tout de suite si une nouvelle version est trouvée,
   * sans attendre le prochain lancement de Jaris.
   */
  const handleCheckForUpdate = (): void => {
    setCheckingUpdate(true)
    setUpdateCheckMessage(null)
    window.jaris
      .checkForUpdate()
      .then(({ status, error }) => {
        if (error) {
          setUpdateCheckMessage(`Vérification impossible : ${error}`)
          return
        }
        if (status) {
          setAppVersionStatus(status)
          setUpdateCheckMessage(
            status.outdated
              ? `Nouvelle version disponible : ${status.latest} (tu as ${status.current}).`
              : `Jaris est à jour (${status.current}).`
          )
        } else {
          setUpdateCheckMessage("Aucune version publiée n'a été trouvée sur GitHub.")
        }
      })
      .catch((err: unknown) => setUpdateCheckMessage(err instanceof Error ? err.message : String(err)))
      .finally(() => setCheckingUpdate(false))
  }

  const handleUpdateOllama = (): void => {
    setUpdatingOllama(true)
    setOllamaUpdateMessage(null)
    // Remis à zéro à chaque tentative, comme pour Jaris : sinon un nouvel essai repartirait visuellement du
    // pourcentage atteint la fois précédente, alors que le téléchargement, lui, recommence du début.
    setOllamaUpdateProgress(null)
    window.jaris
      .updateOllama()
      .then(({ message }) => {
        setOllamaUpdateMessage(message)
        return window.jaris.getOllamaVersionStatus()
      })
      .then(setOllamaVersionStatus)
      .catch((err: unknown) => {
        // updateOllama() (main.ts) attrape déjà tout en interne, donc ne devrait normalement jamais
        // rejeter — filet de sécurité quand même : sans ce .catch, une exception ici laissait le bouton
        // revenir à "Mettre à jour" sans JAMAIS afficher le moindre message, succès ou échec.
        setOllamaUpdateMessage(err instanceof Error ? err.message : String(err))
      })
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

  /** Design sonore (étape 31) : absent/true par défaut (voir App.tsx), false pour tout couper. */
  const toggleSoundEffects = async (enabled: boolean): Promise<void> => {
    if (!profile) return
    setError(null)
    const updated = { ...profile, soundEffectsEnabled: enabled }
    setProfile(updated)
    try {
      await window.jaris.saveProfile(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * Options → Activation (étape 81) : touche "+" et clic sur l'orbe sont de simples champs du profil,
   * relus à la volée par App.tsx (comme soundEffectsEnabled ci-dessus) — aucun redémarrage du pipeline
   * vocal nécessaire, contrairement à toggleWakeword juste en dessous.
   */
  const toggleActivationKey = async (enabled: boolean): Promise<void> => {
    if (!profile) return
    setError(null)
    const updated = { ...profile, activationKeyEnabled: enabled }
    setProfile(updated)
    try {
      await window.jaris.saveProfile(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const toggleActivationOrbClick = async (enabled: boolean): Promise<void> => {
    if (!profile) return
    setError(null)
    const updated = { ...profile, activationOrbClickEnabled: enabled }
    setProfile(updated)
    try {
      await window.jaris.saveProfile(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * Contrairement aux deux bascules ci-dessus, le mot d'activation redémarre le pipeline vocal (voir
   * setWakewordEnabled dans main.ts — le sidecar Python décide de charger le détecteur ONNX une seule fois,
   * à son démarrage, pas quelque chose qui se bascule à chaud) : même pattern que chooseInputDevice
   * (savingWakewordSetting affiche un message pendant les quelques secondes de rechargement des modèles).
   */
  const toggleActivationWakeword = async (enabled: boolean): Promise<void> => {
    if (!profile) return
    setError(null)
    setSavingWakewordSetting(true)
    try {
      await window.jaris.setWakewordEnabled(enabled)
      setProfile((prev) => (prev ? { ...prev, activationWakeWordEnabled: enabled } : prev))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSavingWakewordSetting(false)
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

  return createPortal(
    <div className="options-page" role="dialog" aria-modal="true" aria-label="Options de Jaris">
      <header className="options-page__header">
        <div>
          <span className="options-page__eyebrow">Jaris</span>
          <h2>Options</h2>
        </div>
        <button
          className="options-page__close"
          onClick={() => {
            // Un test micro actif tourne côté sidecar indépendamment de cette fenêtre : l'arrêter ici
            // évite qu'il continue en arrière-plan après la fermeture de la page des réglages.
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
      </header>

      <div className="options-page__body">
        <aside className="options-page__navigation" aria-label="Sections des options">
          {/* Deux catégories distinctes, à la demande de Léo (étape 111) : "Ce que Jaris sait faire" n'est
              pas un réglage — on n'y change rien, on y découvre. Le laisser en tête de "Réglages" le faisait
              passer pour un panneau de configuration de plus. */}
          <span className="options-page__navigation-label">Découvrir</span>
          <nav className="options-menu__tabs">
            <button className={`options-menu__tab${tab === 'capacites' ? ' options-menu__tab--active' : ''}`} onClick={() => setTab('capacites')}>
              Ce que Jaris sait faire
            </button>
          </nav>
          <span className="options-page__navigation-label options-page__navigation-label--next">Réglages</span>
          <nav className="options-menu__tabs">
            <button className={`options-menu__tab${tab === 'voix' ? ' options-menu__tab--active' : ''}`} onClick={() => setTab('voix')}>
              Voix
            </button>
            <button className={`options-menu__tab${tab === 'modeles' ? ' options-menu__tab--active' : ''}`} onClick={() => setTab('modeles')}>
              Modèles
            </button>
            <button className={`options-menu__tab${tab === 'general' ? ' options-menu__tab--active' : ''}`} onClick={() => setTab('general')}>
              Général
            </button>
          </nav>
        </aside>

        <main className="options-page__workspace">
          <div className="options-page__content">
        {TAB_META[tab] && (
          <div className="options-page__tab-header">
            <h3>{TAB_META[tab]!.title}</h3>
            <p>{TAB_META[tab]!.subtitle}</p>
          </div>
        )}
        {tab === 'capacites' && (
          <div className="options-menu__section">
            <p className="options-menu__capability-intro">
              Tu n'as rien à activer : dis-le, ou écris-le dans le Chat. Les phrases en exemple marchent
              telles quelles.
            </p>
            {CAPABILITIES.map((group) => (
              <section key={group.title} className="options-menu__capability-group">
                <h3 className="options-menu__capability-group-title">{group.title}</h3>
                <p className="options-menu__capability-group-summary">{group.summary}</p>
                {/* Les limitations ("les messages sont hors de portée") ne sont PAS des cartes : ce sont des
                    notes. Les rendre comme les autres laisserait croire à une capacité de plus, exactement la
                    famille des fausses confirmations déjà corrigée plusieurs fois dans ce projet. */}
                <div className="options-menu__capability-cards">
                  {group.items
                    .filter((item) => !item.limitation)
                    .map((item) => (
                      <article key={item.title} className="options-menu__capability">
                        <h4 className="options-menu__capability-title">{item.title}</h4>
                        <p className="options-menu__capability-description">{item.description}</p>
                        {item.example && (
                          <p className="options-menu__capability-example">
                            <span className="options-menu__capability-example-label">{group.exampleLabel ?? 'Dis'}</span>
                            <span className="options-menu__capability-example-text">« {item.example} »</span>
                          </p>
                        )}
                      </article>
                    ))}
                </div>
                {group.items
                  .filter((item) => item.limitation)
                  .map((item) => (
                    <p key={item.title} className="options-menu__capability-limitation">
                      <strong>{item.title}.</strong> {item.description}
                    </p>
                  ))}
              </section>
            ))}
          </div>
        )}

        {tab === 'voix' && (
          <div className="options-menu__section options-menu__section--voix">
            {/* Refonte étape 120 : la maquette "Options Jaris.dc.html" montre en réalité une carte COMPACTE,
                orbe + flèches à GAUCHE et bloc de texte à DROITE (nom+descripteur sur une ligne, points,
                phrase d'aide) — pas la grande carte centrée verticalement héritée de l'écran d'accueil que
                les étapes 76-78 avaient fixée ici (dont la contrainte "même taille que l'accueil" est donc
                explicitement abandonnée pour CETTE carte précise : Léo l'a redemandé sans ambiguïté après
                plusieurs captures, "tu a toujours pas compris que c'etais ça que faut changer, je veut que
                ça ressemble a ça", capture de la carte compacte à l'appui). L'écran d'accueil (App.tsx,
                mode 'voice') garde lui son orbe à 320px, seule CETTE carte du menu Options change. */}
            <SettingGroup title="La voix de Jaris">
            <div className="options-menu__voice-picker">
              <div className="options-menu__voice-nav">
                <button className="options-menu__arrow" onClick={() => void chooseVoice(voiceIndex - 1)} disabled={previewing}>
                  ‹
                </button>
                <JarisOrb emotion="idle" color={voice.color} size={100} />
                <button className="options-menu__arrow" onClick={() => void chooseVoice(voiceIndex + 1)} disabled={previewing}>
                  ›
                </button>
              </div>
              <div className="options-menu__voice-info">
                <div className="options-menu__voice-heading">
                  <span className="options-menu__voice-name">{previewing ? 'Lecture...' : voice.id}</span>
                  <span className="options-menu__voice-description">{voice.description}</span>
                </div>
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
                <p className="options-menu__voice-hint">
                  Chaque voix est écoutée dès qu'elle est choisie. Le cercle prend sa couleur pour que tu la
                  reconnaisses d'un coup d'œil.
                </p>
              </div>
            </div>
            </SettingGroup>

            {/* Micro/Haut-parleur/Activation rejoignent Voix depuis l'étape 115 (Léo : "des categorie...
                peuvent etre ensemble") : trois réglages qui parlent tous de l'expérience vocale, pas trois
                sujets distincts — même page, à la façon d'un onglet de réglages Claude/ChatGPT. Chaque
                réglage passe maintenant par `SettingRow` (étape 116, Léo : "dans les option rien ne se
                ressemble micro comment se déclencher") : intitulé + description à gauche, contrôle à
                droite, quel que soit le type de contrôle (case, menu, bouton) — plus de mise en forme ad hoc
                différente d'un réglage à l'autre.
                "Son" et "Micro et haut-parleur" fusionnés en un seul groupe "Son et périphériques" à l'étape
                119 (maquette "Options Jaris.dc.html") : "Son" ne contenait qu'UNE ligne (le bip d'interface),
                exactement la "carte à une seule ligne" que la maquette dit d'éliminer — les deux parlent de
                la même chose (ce que Jaris fait entendre/écoute), pas de deux sujets distincts. */}
            <SettingGroup title="Son et périphériques">
              <SettingRow
                label="Micro utilisé"
                description={
                  inputDevices !== null && inputDevices.length === 0
                    ? 'Aucun micro détecté par PortAudio.'
                    : savingAudioDevice
                      ? 'Changement de micro : redémarrage du pipeline vocal (rechargement des modèles)…'
                      : 'Changer de micro relance l\'écoute : quelques secondes.'
                }
              >
                <select
                  className="options-menu__select"
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
              </SettingRow>

              <SettingRow label="Haut-parleur utilisé" description="Là où Jaris parle.">
                <select
                  className="options-menu__select"
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
              </SettingRow>

              <SettingRow label="Bips d'interface" description="Un son court à l'écoute, la réflexion, un clic.">
                <Toggle
                  label="Bips d'interface"
                  checked={profile?.soundEffectsEnabled !== false}
                  onChange={(next) => void toggleSoundEffects(next)}
                />
              </SettingRow>
              <SettingRow label="Tester le micro" description="Vérifie que Jaris capte bien ta voix.">
                <button
                  className={`options-menu__action${micTesting ? ' options-menu__action--danger' : ''}`}
                  onClick={toggleMicTest}
                >
                  {micTesting ? 'Arrêter' : 'Tester'}
                </button>
              </SettingRow>
              {(micTesting || micTestResult !== null) && (
                <div className="options-menu__mic-test-detail">
                  {/* Rangée de barres façon Discord plutôt qu'un seul indicateur : chaque barre est un
                      niveau sonore récent (mic_test_level, ~12/seconde, voir voice_server.py), la plus
                      récente à droite — les anciennes défilent vers la gauche à mesure que de nouvelles
                      arrivent (micLevels ci-dessus), pour une vraie sensation de mouvement pendant qu'on
                      parle plutôt qu'un seul chiffre qui saute. */}
                  <div className="options-menu__mic-bars">
                    {micLevels.map((level, i) => (
                      <div
                        key={i}
                        className="options-menu__mic-bar"
                        style={{ height: `${10 + Math.min(1, level) * 90}%` }}
                      />
                    ))}
                  </div>
                  {!micTesting && micTestResult !== null && (
                    <p className={micTestResult ? 'options-menu__mic-result--ok' : 'options-menu__mic-result--bad'}>
                      {micTestResult ? 'Micro détecté : du son a bien été capté.' : "Rien capté : vérifie que le bon micro est sélectionné et qu'il n'est pas coupé."}
                    </p>
                  )}
                </div>
              )}
            </SettingGroup>

            <SettingGroup
              title="Déclencher l'écoute"
              description="Les trois façons sont indépendantes : garde celles que tu utilises."
            >
              <SettingRow label="Touche « + » du pavé numérique" description="La façon la plus fiable, même en jeu.">
                <Toggle
                  label="Touche « + » du pavé numérique"
                  checked={profile?.activationKeyEnabled !== false}
                  onChange={(next) => void toggleActivationKey(next)}
                />
              </SettingRow>
              <SettingRow label="Clic sur le cercle de Jaris" description="Sur la page Agent vocal comme sur le widget.">
                <Toggle
                  label="Clic sur le cercle de Jaris"
                  checked={profile?.activationOrbClickEnabled !== false}
                  onChange={(next) => void toggleActivationOrbClick(next)}
                />
              </SettingRow>
              <SettingRow
                label="Dire « Jaris » à voix haute"
                description={
                  savingWakewordSetting
                    ? 'Redémarrage du pipeline vocal (rechargement des modèles)…'
                    : 'Pas toujours parfait : « Jarvis » peut aussi le réveiller.'
                }
              >
                <Toggle
                  label="Dire « Jaris » à voix haute"
                  checked={profile?.activationWakeWordEnabled !== false}
                  disabled={savingWakewordSetting}
                  onChange={(next) => void toggleActivationWakeword(next)}
                />
              </SettingRow>
            </SettingGroup>
          </div>
        )}

        {tab === 'modeles' && (
          <div className="options-menu__section">
            {/* Longueur de mémoire AU-DESSUS des paliers de configuration (Léo, étape 117 : "met juste le
                context au dessus des palier") : les deux parlent de "quel modèle/combien de mémoire pour ce
                modèle", mais le réglage qu'on vient justement de toucher (le curseur) ne doit pas se
                retrouver sous un gros tableau qu'il faut d'abord dépasser pour le retrouver. */}
            {contextLengthOptions && (
              <SettingGroup title="Mémoire de conversation">
                <SettingRow
                  stacked
                  className="options-menu__context-row"
                  label="Combien Jaris garde en tête"
                  description={
                    <>
                      Comme le curseur "Context length" d'Ollama, sauf que le maximum est déjà limité à ce
                      que ta carte graphique peut encaisser sans déborder. Actuellement :{' '}
                      <strong>{formatContextLength(contextLengthOptions.current)}</strong>
                      {savingContextLength ? ' (enregistrement…)' : ''}
                    </>
                  }
                >
                  <input
                    type="range"
                    className="options-menu__context-slider"
                    min={0}
                    max={Math.max(0, contextLengthOptions.availableSteps.length - 1)}
                    value={Math.max(0, contextLengthOptions.availableSteps.indexOf(contextLengthOptions.current))}
                    onChange={(event) => {
                      const step = contextLengthOptions.availableSteps[Number(event.target.value)]
                      if (step !== undefined) handleContextLengthChange(step)
                    }}
                  />
                  <div className="options-menu__context-slider-ticks">
                    {contextLengthOptions.availableSteps.map((step) => (
                      <span key={step}>{formatContextLength(step)}</span>
                    ))}
                  </div>
                </SettingRow>
              </SettingGroup>
            )}

            <SettingGroup title="Ce que ta machine fait tourner">
              {myPicks === null ? (
                <p className="capacity-scan__status">Chargement...</p>
              ) : (
                <>
                  <MyModelPicks picks={myPicks} />
                  <AllModelsOverview />
                </>
              )}
              <SettingRow
                label="Retester la configuration"
                description="Redétecte la VRAM/RAM (utile après un changement matériel, par exemple une
                  nouvelle carte graphique) et télécharge directement les modèles déjà connus pour cette
                  nouvelle configuration, sans repasser par une analyse comparative complète."
              >
                <button className="options-menu__action" onClick={() => void handleRetestConfiguration()} disabled={retestingConfig}>
                  {retestingConfig ? 'Nouvelle détection en cours...' : 'Retester la configuration'}
                </button>
              </SettingRow>
              {profile?.codeModel && (
                <SettingRow
                  label="Modèle du mode Code"
                  description="Choisi et téléchargé automatiquement selon ta configuration, comme les modèles ci-dessus."
                >
                  <strong>{formatModelName(profile.codeModel)}</strong>
                </SettingRow>
              )}
            </SettingGroup>
          </div>
        )}

        {tab === 'general' && (
          <div className="options-menu__section">
            {/* Mise à jour/Historique regroupés dans "Général" depuis l'étape 115 (Léo : "des categorie...
                peuvent etre ensemble") : deux réglages "à propos de l'application" plutôt que deux sujets
                distincts, à la manière du même onglet chez ChatGPT/Claude. Chaque réglage passe par
                `SettingRow`/`SettingGroup` (étape 116) pour la même raison que l'onglet Voix ci-dessus : un
                bouton et une liste doivent se présenter pareil. "Fichiers et moteur local" (Ollama + dossier
                des modèles) était passé dans Modèles à l'étape 119 en suivant la maquette "Options
                Jaris.dc.html" — remis ici à l'étape 122 sur demande explicite de Léo ("deplace Fichiers et
                moteur local avec dossier etc... dans général"), qui l'emporte sur le choix de la maquette. */}
            <SettingGroup title="Mise à jour">
              <SettingRow
                label="Rechercher une mise à jour"
                description={
                  <>
                    Version installée : <strong>{installedVersion ?? appVersionStatus?.current ?? '...'}</strong>
                    {updateCheckMessage ? <> — {updateCheckMessage}</> : null}
                  </>
                }
              >
                <button className="options-menu__action" onClick={handleCheckForUpdate} disabled={checkingUpdate}>
                  {checkingUpdate ? 'Recherche en cours…' : 'Rechercher une mise à jour'}
                </button>
              </SettingRow>

              {appVersionStatus?.outdated && (
                <div className="options-menu__ollama-warning">
                  Jaris {appVersionStatus.current} installé, la dernière version est{' '}
                  {appVersionStatus.latest}.
                  <div className="options-menu__ollama-update-actions">
                    <button onClick={handleUpdateApp} disabled={updatingApp}>
                      {updatingApp ? 'Mise à jour en cours…' : 'Mettre à jour'}
                    </button>
                  </div>
                  {/* Étape 98 : une VRAIE barre qui avance, à la place d'une phrase figée. L'installeur pèse
                      ~98 Mo, soit plusieurs minutes sur une connexion modeste — "on ne sait pas quand c'est
                      terminé et des fois c'est bloqué et ça fait rien" (Léo) décrivait exactement ce vide. */}
                  {updatingApp && <AppUpdateProgress progress={updateProgress} />}
                </div>
              )}
              {!updatingApp && appUpdateMessage && <p className="options-menu__ollama-update-note">{appUpdateMessage}</p>}
            </SettingGroup>

            {/* Ollama et le dossier de stockage des modèles : ce qui fait tourner les modèles sur cette
                machine, pas les modèles eux-mêmes (déjà dans Modèles, à côté du choix du palier). La ligne
                Ollama reste visible même à jour (seule la donnée déjà lue par getOllamaVersionStatus()
                change de forme d'affichage, aucun nouvel appel IPC). */}
            <SettingGroup title="Fichiers et moteur local">
              <SettingRow
                label="Ollama"
                description={
                  ollamaVersionStatus
                    ? ollamaVersionStatus.outdated
                      ? `Version ${ollamaVersionStatus.current} installée · ${ollamaVersionStatus.latest} disponible. Certains modèles récents peuvent refuser de se télécharger tant qu'il n'est pas à jour.`
                      : `Version ${ollamaVersionStatus.current} installée · à jour.`
                    : 'Vérification de la version…'
                }
              >
                {ollamaVersionStatus?.outdated && (
                  <button className="options-menu__action" onClick={handleUpdateOllama} disabled={updatingOllama}>
                    {updatingOllama ? 'Mise à jour en cours…' : 'Mettre à jour'}
                  </button>
                )}
              </SettingRow>
              {ollamaVersionStatus?.outdated && (
                <div className="options-menu__ollama-warning">
                  <a href="https://ollama.com/download" target="_blank" rel="noreferrer">
                    Ou télécharge manuellement sur ollama.com/download
                  </a>
                  {updatingOllama && (
                    <>
                      {/* L'installeur d'Ollama pèse 1,5 Go : plusieurs minutes pendant lesquelles il ne se
                          passait rien à l'écran ("ça bloque depuis 5m", Léo). Même barre que la mise à jour
                          de Jaris (étape 98) plutôt qu'un second indicateur inventé à côté. */}
                      <AppUpdateProgress progress={ollamaUpdateProgress} target="ollama" />
                      <p className="options-menu__ollama-update-note">
                        Une fenêtre Windows peut demander une autorisation (élévation) — accepte-la pour continuer.
                      </p>
                    </>
                  )}
                </div>
              )}
              {/* Hors du bandeau "outdated" ci-dessus, à dessein : une mise à jour réussie fait justement
                  passer ollamaVersionStatus.outdated à false juste après, ce qui ferait disparaître le
                  message de succès avec le reste du bandeau s'il restait imbriqué dedans — jamais vu le
                  message alors que la mise à jour avait réellement marché. */}
              {!updatingOllama && ollamaUpdateMessage && <p className="options-menu__ollama-update-note">{ollamaUpdateMessage}</p>}

              <SettingRow
                label="Dossier des modèles"
                description="Les modèles Ollama, l'environnement Python (voix) et le cache de reconnaissance/synthèse
                  vocale peuvent peser plusieurs dizaines de Go au total — regroupe-les ailleurs (un autre disque,
                  par exemple) sans que rien d'autre n'ait à changer."
              >
                <button className="options-menu__action" onClick={handleChooseModelsLocation} disabled={movingModelsLocation}>
                  {movingModelsLocation ? 'Déplacement en cours…' : 'Choisir un dossier…'}
                </button>
              </SettingRow>
              {modelsLocation && (
                <ul className="options-menu__models-location-list">
                  <li>Modèles Ollama : {modelsLocation.ollamaModelsDir}</li>
                  <li>Environnement Python : {modelsLocation.pythonRuntimeDir}</li>
                  <li>Cache vocal : {modelsLocation.hfCacheDir}</li>
                </ul>
              )}
              {modelsLocationMessage && <p className="options-menu__ollama-update-note">{modelsLocationMessage}</p>}
            </SettingGroup>

            <SettingGroup title="Historique des conversations">
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
                <SettingRow label="Dossier de l'historique" description="Ouvre le fichier où tout est enregistré, ou efface-le complètement.">
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
                </SettingRow>
              )}
            </SettingGroup>
          </div>
        )}

        <audio ref={audioRef} hidden />
        {error && <div className="options-menu__error">{error}</div>}
          </div>
        </main>
      </div>
    </div>,
    document.body
  )
}
