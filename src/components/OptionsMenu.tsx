import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  AppVersionStatus,
  LaunchAtStartupStatus,
  AudioInputDevice,
  ContextLengthOptions,
  ConversationEntry,
  MyModelPicks as MyModelPicksData,
  ModelPullProgress,
  ModelsLocationStatus,
  OllamaVersionStatus,
  Profile,
  UpdateProgress,
  MicTestDonePayload,
  WakeTestHeardPayload
} from '../../shared/ipc'
import { CAPABILITIES } from '../../shared/capabilities'
import AllModelsOverview from './AllModelsOverview'
import AppUpdateProgress from './AppUpdateProgress'
import { SettingGroup, SettingRow, Toggle } from './SettingsLayout'
import AnywhereSettings from './AnywhereSettings'
import MyModelPicks from './MyModelPicks'
import ModelPullBar from './ModelPullBar'
import JarisOrb from './JarisOrb'
import { formatModelName } from '../lib/formatModelName'
import { formatContextLength } from '../lib/formatContextLength'
import { migrateLegacyCodeConversations } from '../lib/codeConversations'
import { selectedInputDevice } from '../lib/inputDeviceChoice'
import { currentLocale, t, tn } from '../lib/i18n'
import { LANGUAGES, languageInfo, type LanguageSetting } from '../../shared/i18n/languages'
import type { MessageKey } from '../../shared/i18n'

interface VoiceOption {
  id: string
  /** Clé du catalogue (shared/i18n/fr.ts) : traduite au moment du rendu, jamais figée à la langue du démarrage. */
  description: MessageKey
  /** Couleur de l'anneau JarisOrb pour distinguer cette voix (voir color? dans JarisOrb.tsx) — même forme
   * (anneau déchiqueté) que sur l'accueil pour toutes les voix, JAMAIS un cercle lisse générique : seule la
   * couleur change, à la demande explicite de Léo ("fait pas un cercle rond... fait le même cercle que dans
   * l'accueil... change juste la couleur pour différencier les voix"). */
  color: string
}

const TTS_VOICES: VoiceOption[] = [
  { id: 'M1', description: 'options.voice.M1', color: '#37e2ff' },
  { id: 'M2', description: 'options.voice.M2', color: '#2b6cff' },
  { id: 'M3', description: 'options.voice.M3', color: '#6c5ce7' },
  { id: 'M4', description: 'options.voice.M4', color: '#55e6c1' },
  { id: 'M5', description: 'options.voice.M5', color: '#feca57' },
  { id: 'F1', description: 'options.voice.F1', color: '#ff9ff3' },
  { id: 'F2', description: 'options.voice.F2', color: '#ff6b81' },
  { id: 'F3', description: 'options.voice.F3', color: '#48dbfb' },
  { id: 'F4', description: 'options.voice.F4', color: '#c8d6e5' },
  { id: 'F5', description: 'options.voice.F5', color: '#ffb8b8' }
]

const DEFAULT_VOICE_INDEX = TTS_VOICES.findIndex((v) => v.id === 'M3')

/**
 * Nombre de barres du visualiseur de test micro (façon Discord : une fenêtre glissante des derniers niveaux
 * sonores, pas un seul cercle qui pulse) — voir micLevels plus bas.
 */
const MIC_TEST_BAR_COUNT = 42

/**
 * Test du mot « Jaris » (étape 187, Léo : « fais un tableau avec par exemple réussi 10, Jain 5 fois, Onal 10 fois ») :
 * au lieu d'une ligne par essai, les essais sont REGROUPÉS — toutes les réussites sur une ligne, puis chaque mot
 * mal compris avec son nombre de fois, le plus fréquent d'abord. C'est ce classement qui dit quoi corriger.
 * Plafond large (un test ne dure pas si longtemps) pour ne jamais grossir sans fin si le test reste ouvert.
 */
const WAKE_TEST_MAX_HEARD = 500

export interface WakeTestRow {
  label: string
  count: number
  matched: boolean
}

/** Pur (testé à part) : regroupe les essais du test en lignes du tableau. */
/** Verdict affiché sous le test micro (étape 188) : `ok` colore la phrase en vert, sinon en rouge. */
export interface MicTestVerdict {
  ok: boolean
  text: string
}

/**
 * Traduit la fin d'un test micro en une phrase pour Léo. Un flux fait uniquement de zéros ne vient jamais d'un
 * micro trop faible (un vrai micro a toujours un léger souffle) : c'est Windows qui ne donne aucun son.
 */
export function micTestVerdict(done: MicTestDonePayload): MicTestVerdict {
  if (done.detected) return { ok: true, text: t('options.micTest.detected') }
  if (done.silentStream) {
    return {
      ok: false,
      text: t('options.micTest.silent')
    }
  }
  return { ok: false, text: t('options.micTest.tooQuiet') }
}

export function groupWakeHeard(heard: WakeTestHeardPayload[]): WakeTestRow[] {
  const recognized = heard.filter((h) => h.matched).length
  const misses = new Map<string, WakeTestRow>()
  for (const h of heard) {
    if (h.matched) continue
    // « Rice. », « Rice? » et « rice » sont le même mot compris : regroupés, affichés sans ponctuation finale.
    const shown = h.tooShort ? t('options.wakeTest.tooShort') : h.text ? h.text.replace(/[\s.,!?;:…]+$/u, '') : t('options.wakeTest.nothing')
    const key = shown.toLowerCase()
    const row = misses.get(key) ?? { label: h.tooShort || !h.text ? shown : t('common.quoted', { text: shown }), count: 0, matched: false }
    row.count += 1
    misses.set(key, row)
  }
  const rows = [...misses.values()].sort((a, b) => b.count - a.count)
  return recognized ? [{ label: t('options.wakeTest.recognized'), count: recognized, matched: true }, ...rows] : rows
}

// Refonte étape 115 (Léo : "il ya des categorie dans les options qui peuvent etre ensemble, refait
// totalement option bien comme claude gpt") : Micro et Activation (2 réglages, chacun quelques lignes)
// n'avaient aucune raison d'être des onglets à part entière — regroupés dans "Voix", qui parle déjà de
// l'expérience vocale dans son ensemble. Même chose pour Mise à jour/Stockage/Historique, trois réglages
// "à propos de l'application" plutôt que trois sujets distincts — regroupés dans "Général", à la manière du
// même onglet chez ChatGPT/Claude (thème, langue, effacer les discussions...). 9 onglets -> 5.
// Étape 214 : « Téléphone » revient (Léo : « on va faire parler depuis son téléphone »), cette fois pour
// parler à Jaris depuis le téléphone — rien à voir avec l'ancien onglet Mobile connecté retiré à l'étape 116.
type Tab = 'capacites' | 'voix' | 'modeles' | 'telephone' | 'general'

/**
 * Titre + sous-titre en tête de chaque page de réglages (design importé, "Options Jaris.dc.html") —
 * absents du code jusqu'ici : les 3 comparaisons précédentes (v0.14.6 à v0.14.9) s'étaient concentrées sur
 * le contenu DES cartes, jamais sur ce qui vit AU-DESSUS d'elles, repéré seulement quand Léo a renvoyé une
 * capture de la page COMPLÈTE plutôt que juste le panneau recadré ("non tu a pas compris ma demande...").
 * "Ce que Jaris sait faire" (capacites) garde sa propre phrase d'intro DANS sa section (étape 111), pas ce
 * gabarit — seuls les 3 onglets de réglages en ont besoin.
 */
const TAB_META: Partial<Record<Tab, { title: MessageKey; subtitle: MessageKey }>> = {
  voix: { title: 'options.tab.voice', subtitle: 'options.tab.voice.subtitle' },
  modeles: { title: 'options.tab.models', subtitle: 'options.tab.models.subtitle' },
  telephone: { title: 'options.tab.phone', subtitle: 'options.tab.phone.subtitle' },
  general: { title: 'options.tab.general', subtitle: 'options.tab.general.subtitle' }
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
 * MyModelPicks.tsx (modèles choisis pour ta machine) et AllModelsOverview.tsx, pas seulement ici.
 */
/**
 * `label` (étape 243) : le nom du test devant le score (« Questions 77/78 », « Demandes 45/48 ») — deux scores
 * côte à côte sans leur nom seraient impossibles à distinguer.
 */
export function ReliabilityBadge({ value, label }: { value: string | null; label?: string }): JSX.Element {
  const prefix = label ? `${label} ` : ''
  if (!value) return <span className="options-menu__badge options-menu__badge--none">{prefix}—</span>
  const match = /^(\d+)\/(\d+)$/.exec(value)
  if (!match) return <span className="options-menu__badge options-menu__badge--none">{prefix}{value}</span>
  const [, correctStr, totalStr] = match
  const correct = Number(correctStr)
  const total = Number(totalStr)
  const level = total === 0 ? 'none' : correct === total ? 'good' : correct === 0 ? 'bad' : 'mid'
  return <span className={`options-menu__badge options-menu__badge--${level}`}>{prefix}{value}</span>
}

/**
 * Nom du test d'après le total du score (étape 243) : un rôle peut afficher le test de conversation, de vision ou
 * de code (le rôle Code retombe sur la conversation quand le modèle n'a pas passé le test de code).
 */
export function scoreTestLabel(value: string | null): string | undefined {
  const total = value?.split('/')[1]
  return total === '78' ? t('options.score.questions') : total === '48' ? t('options.score.requests') : total === '34' ? t('options.score.images') : total === '5' ? t('options.score.code') : undefined
}


interface OptionsMenuProps {
  /**
   * Design v2 (maquette « Jaris v2.dc.html ») : Options est un écran du rail de gauche, affiché dans la zone
   * principale à côté du rail — plus de bouton d'ouverture ni de page plein écran avec « Fermer ». Sans cette
   * option (tests, ancien usage), le composant garde son bouton et sa page plein écran.
   */
  embedded?: boolean
  /**
   * Étape 269 (façon Codex) : emplacement de la colonne de liste, à côté de la barre d'icônes. Fourni, les
   * sections d'Options s'y affichent à la place d'une seconde colonne dans la page ; absent (liste repliée,
   * Options hors de la coque), elles restent dans la page.
   */
  navSlot?: HTMLElement | null
}

export default function OptionsMenu({ embedded = false, navSlot = null }: OptionsMenuProps = {}): JSX.Element {
  const [openState, setOpen] = useState(false)
  const open = embedded || openState
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
  const [launchAtStartup, setLaunchAtStartupStatus] = useState<LaunchAtStartupStatus | null>(null)
  const [savingLaunchAtStartup, setSavingLaunchAtStartup] = useState(false)
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
  // Étape 140, Léo : "je clique sur une nouvelle detection, et ça fait rien ça charge". Le retest télécharge
  // parfois plusieurs Go (G9v3-3B : 1,9 Go) : sans afficher son avancement, le bouton semblait bloqué.
  const [retestLine, setRetestLine] = useState<string | null>(null)
  // Le modèle en cours de téléchargement pendant ce retest (octets reçus / taille), `null` entre deux téléchargements.
  const [retestPull, setRetestPull] = useState<ModelPullProgress | null>(null)
  const [inputDevices, setInputDevices] = useState<AudioInputDevice[] | null>(null)
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[] | null>(null)
  const [savingAudioDevice, setSavingAudioDevice] = useState(false)
  const [savingWakewordSetting, setSavingWakewordSetting] = useState(false)
  const [micTesting, setMicTesting] = useState(false)
  // Fenêtre glissante des derniers niveaux sonores (une valeur par évènement mic_test_level, ~12/seconde) :
  // affichée comme une rangée de barres qui défilent façon Discord, pas un seul chiffre.
  const [micLevels, setMicLevels] = useState<number[]>(() => Array(MIC_TEST_BAR_COUNT).fill(0))
  const [micTestResult, setMicTestResult] = useState<MicTestVerdict | null>(null)
  /** Étape 188 : pourquoi le test micro ou du mot « Jaris » n'a pas pu démarrer (écoute en chargement, arrêtée…). */
  const [voiceTestIssue, setVoiceTestIssue] = useState<{ test: 'mic' | 'wake'; text: string } | null>(null)
  // Étape 180 (Léo : « ça marche 1 fois sur 3 ») : ce que Jaris a compris à chaque « Jaris » dit pendant le test.
  const [wakeTesting, setWakeTesting] = useState(false)
  const [wakeHeard, setWakeHeard] = useState<WakeTestHeardPayload[]>([])
  // Langue (Options → Général) : lue de façon synchrone (comme au démarrage), puis tenue à jour par le changement.
  const [languageSetting, setLanguageSetting] = useState<LanguageSetting>(() => window.jaris.getLanguageState?.()?.setting ?? 'auto')
  const [systemLanguage, setSystemLanguage] = useState(() => window.jaris.getLanguageState?.()?.systemCode ?? 'fr')
  const [savingLanguage, setSavingLanguage] = useState(false)

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

  // Design v2 : quitter l'écran Options par le rail démonte ce composant sans passer par « Fermer ». Un test
  // micro ou du mot « Jaris » tourne côté sidecar, indépendamment de cette page : il faut l'arrêter ici aussi.
  const voiceTestsRef = useRef({ mic: false, wake: false })
  voiceTestsRef.current = { mic: micTesting, wake: wakeTesting }
  useEffect(
    () => () => {
      if (voiceTestsRef.current.mic) window.jaris.stopTestMicrophone()
      if (voiceTestsRef.current.wake) window.jaris.stopTestWakeWord()
    },
    []
  )

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
      // Relu à chaque ouverture de l'onglet : l'entrée de démarrage peut avoir été retirée ou désactivée
      // depuis Windows lui-même (Gestionnaire des tâches) entre-temps.
      void window.jaris.getLaunchAtStartup().then(setLaunchAtStartupStatus)
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
    // « Déplacer » change le dossier de Chromium et efface l'ancien, avec son stockage : les conversations du mode
    // Code que l'ancienne version y gardait doivent être dans leur fichier AVANT. Si ça échoue, rien n'est déplacé.
    migrateLegacyCodeConversations()
      .then((saved) => {
        if (!saved) {
          setModelsLocationMessage(t('options.folder.codeNotSaved'))
          return
        }
        return window.jaris.chooseModelsLocation().then(({ success, message }) => {
          if (message) setModelsLocationMessage(message)
          if (success) return window.jaris.getModelsLocationStatus().then(setModelsLocation)
        })
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
    const offDone = window.jaris.onMicTestDone((done) => {
      setMicTesting(false)
      setMicTestResult(micTestVerdict(done))
    })
    const offWake = window.jaris.onWakeTestHeard((heard) => setWakeHeard((prev) => [...prev, heard].slice(-WAKE_TEST_MAX_HEARD)))
    return () => {
      offLevel()
      offDone()
      offWake()
    }
  }, [])

  // Redétecte le matériel (VRAM/RAM) et télécharge directement les modèles déjà connus pour cette
  // configuration (runQuickSetup, même chemin que l'écran d'accueil) — utile après un changement matériel
  // (nouvelle carte graphique...), sans repasser par l'ancienne analyse comparative complète (des dizaines
  // de minutes à tout retélécharger/retester alors que verified-tool-scores.md connaît déjà le gagnant).
  useEffect(() => {
    if (!retestingConfig) return
    const stopLines = window.jaris.onModelBenchmarkLine(setRetestLine)
    // Même barre que l'écran de configuration (runQuickSetup télécharge ici les mêmes modèles, parfois plusieurs Go) :
    // le processus principal l'envoie déjà à cette fenêtre, il suffisait de l'écouter.
    const stopProgress = window.jaris.onModelPullProgress(setRetestPull)
    return () => {
      stopLines()
      stopProgress()
    }
  }, [retestingConfig])

  const chooseLanguage = (next: LanguageSetting): void => {
    setLanguageSetting(next)
    setSavingLanguage(true)
    setError(null)
    window.jaris
      .setLanguage(next)
      .then((state) => {
        setLanguageSetting(state.setting)
        setSystemLanguage(state.systemCode)
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setSavingLanguage(false))
  }

  const handleRetestConfiguration = async (): Promise<void> => {
    setError(null)
    setRetestLine(t('options.retest.detecting'))
    setRetestPull(null)
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
          tn('options.retest.skipped', result.skippedModels.length, {
            models: result.skippedModels.map((s) => `${s.model} (${s.reason})`).join(' ; ')
          })
        )
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRetestingConfig(false)
      setRetestLine(null)
      setRetestPull(null)
    }
  }

  const handleDeleteUnusedModel = async (model: string): Promise<void> => {
    await window.jaris.deleteUnusedModel(model)
    setMyPicks(await window.jaris.getMyModelPicks())
  }

  const handleClearHistory = async (): Promise<void> => {
    if (!window.confirm(t('options.history.confirmClear'))) return
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
          setUpdateCheckMessage(t('options.update.checkFailed', { error }))
          return
        }
        if (status) {
          setAppVersionStatus(status)
          setUpdateCheckMessage(
            status.outdated
              ? t('options.update.available', { latest: status.latest ?? '', current: status.current })
              : t('options.update.upToDate', { current: status.current })
          )
        } else {
          setUpdateCheckMessage(t('options.update.noRelease'))
        }
      })
      .catch((err: unknown) => setUpdateCheckMessage(err instanceof Error ? err.message : String(err)))
      .finally(() => setCheckingUpdate(false))
  }

  useEffect(
    () =>
      window.jaris.onOllamaVersionStatus(setOllamaVersionStatus),
    []
  )

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

      if (profile) await saveProfileFlag({ ttsVoice: nextVoice.id })
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
      const deviceName = inputDevices?.find((device) => device.index === deviceIndex)?.name ?? null
      setProfile((prev) => (prev ? { ...prev, audioInputDeviceIndex: deviceIndex, audioInputDeviceName: deviceName } : prev))
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
  const chooseOutputDevice = (deviceId: string): Promise<void> => saveProfileFlag({ audioOutputDeviceId: deviceId })

  /** Design sonore (étape 31) : absent/true par défaut (voir App.tsx), false pour tout couper. */
  const toggleSoundEffects = (enabled: boolean): Promise<void> => saveProfileFlag({ soundEffectsEnabled: enabled })

  /** Correcteur de ce que tu as dit (étape 207) : relu à chaque phrase par le pipeline vocal, sans redémarrage. */
  const toggleVoiceCorrection = (enabled: boolean): Promise<void> => saveProfileFlag({ voiceCorrectionEnabled: enabled })

  /**
   * Étape 328 : seuls les champs changés partent, appliqués côté main sur le profil RELU — jamais la copie gardée
   * depuis l'ouverture d'Options, qui effaçait ce que Jaris avait changé entre-temps (modèles, micro, choix du Chat).
   * Le profil renvoyé remplace ensuite cette copie, à jour.
   */
  const saveProfileFlag = async (change: Partial<Profile>): Promise<void> => {
    if (!profile) return
    setError(null)
    setProfile((prev) => (prev ? { ...prev, ...change } : prev))
    try {
      const fresh = await window.jaris.patchProfile(change)
      if (fresh) setProfile(fresh)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * Options → Activation (étape 81) : touche "+" et clic sur l'orbe sont de simples champs du profil,
   * relus à la volée par App.tsx (comme soundEffectsEnabled ci-dessus) — aucun redémarrage du pipeline
   * vocal nécessaire, contrairement à toggleWakeword juste en dessous.
   */
  const toggleActivationKey = (enabled: boolean): Promise<void> => saveProfileFlag({ activationKeyEnabled: enabled })

  const toggleActivationOrbClick = (enabled: boolean): Promise<void> => saveProfileFlag({ activationOrbClickEnabled: enabled })

  /**
   * Contrairement aux deux bascules ci-dessus, le mot d'activation redémarre le pipeline vocal (voir
   * setWakewordEnabled dans main.ts — le sidecar Python décide d’écouter le mot « Jaris » une seule fois,
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
  /** Même principe que le test micro : l'arrêt est appliqué tout de suite côté écran, quoi que réponde le sidecar. */
  const toggleWakeTest = (): void => {
    if (wakeTesting) {
      window.jaris.stopTestWakeWord()
      setWakeTesting(false)
      return
    }
    setWakeHeard([])
    setVoiceTestIssue(null)
    setWakeTesting(true)
    void window.jaris.testWakeWord().then(({ started, reason }) => {
      if (started) return
      setWakeTesting(false)
      setVoiceTestIssue({ test: 'wake', text: reason ?? t('options.test.couldNotStart') })
    })
  }

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
    setVoiceTestIssue(null)
    setMicTesting(true)
    void window.jaris.testMicrophone().then(({ started, reason }) => {
      if (started) return
      setMicTesting(false)
      setVoiceTestIssue({ test: 'mic', text: reason ?? t('options.test.couldNotStart') })
    })
  }

  if (!open) {
    return (
      <button className="options-menu__trigger" onClick={() => setOpen(true)}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1" />
        </svg>
        {t('options.title')}
      </button>
    )
  }

  const navigation = (
    <aside className="options-page__navigation" aria-label={t('options.nav.label')}>
      {/* Deux catégories distinctes, à la demande de Léo (étape 111) : "Ce que Jaris sait faire" n'est
          pas un réglage — on n'y change rien, on y découvre. Le laisser en tête de "Réglages" le faisait
          passer pour un panneau de configuration de plus. */}
      <span className="options-page__navigation-label">{t('options.nav.discover')}</span>
      <nav className="options-menu__tabs">
        <button className={`options-menu__tab${tab === 'capacites' ? ' options-menu__tab--active' : ''}`} onClick={() => setTab('capacites')}>
          {t('options.tab.capabilities')}
        </button>
      </nav>
      <span className="options-page__navigation-label options-page__navigation-label--next">{t('options.nav.settings')}</span>
      <nav className="options-menu__tabs">
        <button className={`options-menu__tab${tab === 'voix' ? ' options-menu__tab--active' : ''}`} onClick={() => setTab('voix')}>
          {t('options.tab.voice')}
        </button>
        <button className={`options-menu__tab${tab === 'modeles' ? ' options-menu__tab--active' : ''}`} onClick={() => setTab('modeles')}>
          {t('options.tab.models')}
        </button>
        <button className={`options-menu__tab${tab === 'telephone' ? ' options-menu__tab--active' : ''}`} onClick={() => setTab('telephone')}>
          {t('options.tab.phone')}
        </button>
        <button className={`options-menu__tab${tab === 'general' ? ' options-menu__tab--active' : ''}`} onClick={() => setTab('general')}>
          {t('options.tab.general')}
        </button>
      </nav>
    </aside>
  )

  const page = (
    <div
      className={`options-page${embedded ? ' options-page--embedded' : ''}`}
      role={embedded ? undefined : 'dialog'}
      aria-modal={embedded ? undefined : true}
      aria-label={t('options.page.label')}
    >
      <header className="options-page__header">
        <div>
          <h2>{t('options.title')}</h2>
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
            if (wakeTesting) {
              window.jaris.stopTestWakeWord()
              setWakeTesting(false)
            }
            setOpen(false)
          }}
        >
          {t('common.close')}
        </button>
      </header>

      <div className={`options-page__body${navSlot ? ' options-page__body--single' : ''}`}>
        {!navSlot && navigation}
        {navSlot && createPortal(navigation, navSlot)}

        <main className="options-page__workspace">
          <div className="options-page__content">
        {TAB_META[tab] && (
          <div className="options-page__tab-header">
            <h3>{t(TAB_META[tab]!.title)}</h3>
            <p>{t(TAB_META[tab]!.subtitle)}</p>
          </div>
        )}
        {tab === 'capacites' && (
          <div className="options-menu__section">
            <p className="options-menu__capability-intro">{t('options.capabilities.intro')}</p>
            {CAPABILITIES.map((group) => (
              <section key={group.title} className="options-menu__capability-group">
                <h3 className="options-menu__capability-group-title">{t(group.title)}</h3>
                <p className="options-menu__capability-group-summary">{t(group.summary)}</p>
                {/* Les limitations ("les messages sont hors de portée") ne sont PAS des cartes : ce sont des
                    notes. Les rendre comme les autres laisserait croire à une capacité de plus, exactement la
                    famille des fausses confirmations déjà corrigée plusieurs fois dans ce projet. */}
                <div className="options-menu__capability-cards">
                  {group.items
                    .filter((item) => !item.limitation)
                    .map((item) => (
                      <article key={item.title} className="options-menu__capability">
                        <h4 className="options-menu__capability-title">{t(item.title)}</h4>
                        <p className="options-menu__capability-description">{t(item.description)}</p>
                        {item.example && (
                          <p className="options-menu__capability-example">
                            <span className="options-menu__capability-example-label">{t(group.exampleLabel ?? 'capabilities.say')}</span>
                            <span className="options-menu__capability-example-text">{t('common.quoted', { text: t(item.example) })}</span>
                          </p>
                        )}
                      </article>
                    ))}
                </div>
                {group.items
                  .filter((item) => item.limitation)
                  .map((item) => (
                    <p key={item.title} className="options-menu__capability-limitation">
                      <strong>{t(item.title)}.</strong> {t(item.description)}
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
            <SettingGroup title={t('options.voice.group')}>
            <div className="options-menu__voice-picker">
              <div className="options-menu__voice-nav">
                <button className="options-menu__arrow" onClick={() => void chooseVoice(voiceIndex - 1)} disabled={previewing} aria-label={t('options.voice.previous')}>
                  ‹
                </button>
                <JarisOrb emotion="idle" color={voice.color} size={100} />
                <button className="options-menu__arrow" onClick={() => void chooseVoice(voiceIndex + 1)} disabled={previewing} aria-label={t('options.voice.next')}>
                  ›
                </button>
              </div>
              <div className="options-menu__voice-info">
                <div className="options-menu__voice-heading">
                  <span className="options-menu__voice-name">{previewing ? t('options.voice.playing') : voice.id}</span>
                  <span className="options-menu__voice-description">{t(voice.description)}</span>
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
                <p className="options-menu__voice-hint">{t('options.voice.hint')}</p>
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
            <SettingGroup title={t('options.sound.group')}>
              <SettingRow
                label={t('options.sound.mic')}
                description={
                  inputDevices !== null && inputDevices.length === 0
                    ? t('options.sound.mic.none')
                    : savingAudioDevice
                      ? t('options.sound.mic.saving')
                      : t('options.sound.mic.hint')
                }
              >
                <select
                  className="options-menu__select"
                  value={selectedInputDevice(profile, inputDevices)}
                  onChange={(e) => void chooseInputDevice(e.target.value)}
                  disabled={inputDevices === null || savingAudioDevice}
                >
                  <option value="">{t('options.sound.systemDefault')}</option>
                  {inputDevices?.map((device) => (
                    <option key={device.index} value={device.index}>
                      {device.name}
                    </option>
                  ))}
                </select>
              </SettingRow>

              <SettingRow label={t('options.sound.speaker')} description={t('options.sound.speaker.hint')}>
                <select
                  className="options-menu__select"
                  value={profile?.audioOutputDeviceId || ''}
                  onChange={(e) => void chooseOutputDevice(e.target.value)}
                  disabled={outputDevices === null}
                >
                  <option value="">{t('options.sound.systemDefault')}</option>
                  {outputDevices?.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label || device.deviceId}
                    </option>
                  ))}
                </select>
              </SettingRow>

              <SettingRow label={t('options.sound.beeps')} description={t('options.sound.beeps.hint')}>
                <Toggle
                  label={t('options.sound.beeps')}
                  checked={profile?.soundEffectsEnabled !== false}
                  onChange={(next) => void toggleSoundEffects(next)}
                />
              </SettingRow>
              <SettingRow label={t('options.sound.correct')} description={t('options.sound.correct.hint')}>
                <Toggle
                  label={t('options.sound.correct')}
                  checked={profile?.voiceCorrectionEnabled !== false}
                  onChange={(next) => void toggleVoiceCorrection(next)}
                />
              </SettingRow>
              <SettingRow label={t('options.sound.micTest')} description={t('options.sound.micTest.hint')}>
                <button
                  className={`options-menu__action${micTesting ? ' options-menu__action--danger' : ''}`}
                  onClick={toggleMicTest}
                >
                  {micTesting ? t('common.stop') : t('common.test')}
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
                    <p className={micTestResult.ok ? 'options-menu__mic-result--ok' : 'options-menu__mic-result--bad'}>
                      {micTestResult.text}
                    </p>
                  )}
                </div>
              )}
              {voiceTestIssue?.test === 'mic' && (
                <p className="options-menu__mic-result--bad options-menu__voice-test-issue" role="alert">
                  {voiceTestIssue.text}
                </p>
              )}
            </SettingGroup>

            <SettingGroup title={t('options.wake.group')} description={t('options.wake.group.hint')}>
              <SettingRow label={t('options.wake.key')} description={t('options.wake.key.hint')}>
                <Toggle
                  label={t('options.wake.key')}
                  checked={profile?.activationKeyEnabled !== false}
                  onChange={(next) => void toggleActivationKey(next)}
                />
              </SettingRow>
              <SettingRow label={t('options.wake.orb')} description={t('options.wake.orb.hint')}>
                <Toggle
                  label={t('options.wake.orb')}
                  checked={profile?.activationOrbClickEnabled !== false}
                  onChange={(next) => void toggleActivationOrbClick(next)}
                />
              </SettingRow>
              <SettingRow
                label={t('options.wake.word')}
                description={savingWakewordSetting ? t('options.wake.word.saving') : t('options.wake.word.hint')}
              >
                <Toggle
                  label={t('options.wake.word')}
                  checked={profile?.activationWakeWordEnabled !== false}
                  disabled={savingWakewordSetting}
                  onChange={(next) => void toggleActivationWakeword(next)}
                />
              </SettingRow>
              <SettingRow
                label={t('options.wakeTest.label')}
                description={t('options.wakeTest.hint')}
              >
                <button
                  className={`options-menu__action${wakeTesting ? ' options-menu__action--danger' : ''}`}
                  onClick={toggleWakeTest}
                >
                  {wakeTesting ? t('common.stop') : t('common.test')}
                </button>
              </SettingRow>
              {voiceTestIssue?.test === 'wake' && (
                <p className="options-menu__mic-result--bad options-menu__voice-test-issue" role="alert">
                  {voiceTestIssue.text}
                </p>
              )}
              {(wakeTesting || wakeHeard.length > 0) && (
                <div className="options-menu__wake-test">
                  <p className="options-menu__wake-test-summary">
                    {wakeHeard.length === 0
                      ? t('options.wakeTest.yourTurn')
                      : t('options.wakeTest.summary', { recognized: wakeHeard.filter((h) => h.matched).length, total: wakeHeard.length })}
                  </p>
                  {wakeHeard.length > 0 && (
                    <table className="options-menu__wake-test-table">
                      <thead>
                        <tr>
                          <th>{t('options.wakeTest.heard')}</th>
                          <th>{t('options.wakeTest.times')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {groupWakeHeard(wakeHeard).map((row) => (
                          <tr key={row.label} className={row.matched ? 'options-menu__mic-result--ok' : 'options-menu__mic-result--bad'}>
                            <td>{row.label}</td>
                            <td>{row.count}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
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
              <SettingGroup title={t('options.context.group')}>
                <SettingRow
                  stacked
                  className="options-menu__context-row"
                  label={t('options.context.label')}
                  description={
                    <>
                      {t('options.context.hint')}{' '}
                      <strong>{formatContextLength(contextLengthOptions.current)}</strong>
                      {savingContextLength ? ` ${t('options.context.saving')}` : ''}
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

            <SettingGroup title={t('options.models.group')}>
              {myPicks === null ? (
                <p className="capacity-scan__status">{t('common.loading')}</p>
              ) : (
                <>
                  <MyModelPicks picks={myPicks} onDeleteUnused={handleDeleteUnusedModel} />
                  <AllModelsOverview />
                </>
              )}
              <SettingRow
                label={t('options.retest.label')}
                description={t('options.retest.hint')}
              >
                <button className="options-menu__action" onClick={() => void handleRetestConfiguration()} disabled={retestingConfig}>
                  {retestingConfig ? t('options.retest.running') : t('options.retest.label')}
                </button>
              </SettingRow>
              {retestingConfig && (
                <div className="options-menu__retest-progress">
                  <ModelPullBar pull={retestPull} line={retestLine ?? ''} label={t('options.retest.running')} />
                </div>
              )}
              {profile?.codeModel && (
                <SettingRow
                  label={t('options.codeModel.label')}
                  description={t('options.codeModel.hint')}
                >
                  <strong>{formatModelName(profile.codeModel)}</strong>
                </SettingRow>
              )}
            </SettingGroup>
          </div>
        )}

        {tab === 'telephone' && <AnywhereSettings />}

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
            {/* Étape 165 (Léo : « dès que le PC démarre on voit la fenêtre Jaris et pas le fond d'écran, et
                pour l'activer/désactiver »). L'état affiché est celui que Windows a réellement enregistré,
                relu après chaque bascule (voir launchAtStartup.ts), jamais supposé. */}
            <SettingGroup title={t('language.label')}>
              <SettingRow label={t('language.label')} description={savingLanguage ? t('language.saving') : t('language.description')}>
                <select
                  className="options-menu__select"
                  value={languageSetting}
                  onChange={(e) => chooseLanguage(e.target.value as LanguageSetting)}
                  disabled={savingLanguage}
                  aria-label={t('language.label')}
                >
                  <option value="auto">{t('language.auto', { language: languageInfo(systemLanguage).name })}</option>
                  {LANGUAGES.map((language) => (
                    <option key={language.code} value={language.code} lang={language.code}>
                      {language.name}
                    </option>
                  ))}
                </select>
              </SettingRow>
            </SettingGroup>

            <SettingGroup title={t('options.startup.group')}>
              <SettingRow
                label={t('options.startup.label')}
                description={
                  launchAtStartup && !launchAtStartup.supported
                    ? t('options.startup.unsupported')
                    : launchAtStartup?.blockedByWindows
                      ? t('options.startup.blocked')
                      : t('options.startup.hint')
                }
              >
                <Toggle
                  label={t('options.startup.label')}
                  checked={Boolean(launchAtStartup?.enabled)}
                  disabled={!launchAtStartup?.supported || savingLaunchAtStartup}
                  onChange={(next) => {
                    setSavingLaunchAtStartup(true)
                    void window.jaris
                      .setLaunchAtStartup(next)
                      .then(setLaunchAtStartupStatus)
                      // En cas d'échec, on relit l'état réel plutôt que de laisser l'interrupteur mentir.
                      .catch(() => window.jaris.getLaunchAtStartup().then(setLaunchAtStartupStatus))
                      .finally(() => setSavingLaunchAtStartup(false))
                  }}
                />
              </SettingRow>
            </SettingGroup>

            <SettingGroup title={t('options.update.group')}>
              <SettingRow
                label={t('options.update.check')}
                description={
                  <>
                    {t('options.update.installed')} <strong>{installedVersion ?? appVersionStatus?.current ?? '...'}</strong>
                    {updateCheckMessage ? <> — {updateCheckMessage}</> : null}
                  </>
                }
              >
                <button className="options-menu__action" onClick={handleCheckForUpdate} disabled={checkingUpdate}>
                  {checkingUpdate ? t('options.update.checking') : t('options.update.check')}
                </button>
              </SettingRow>

              {appVersionStatus?.outdated && (
                <div className="options-menu__ollama-warning">
                  {t('options.update.outdated', { current: appVersionStatus.current, latest: appVersionStatus.latest ?? '' })}
                  <div className="options-menu__ollama-update-actions">
                    <button onClick={handleUpdateApp} disabled={updatingApp}>
                      {updatingApp ? t('options.update.running') : t('options.update.button')}
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
            <SettingGroup title={t('options.files.group')}>
              {/* Étape 336 : l'Ollama de Jaris (ollamaEngine.ts). Tant que Jaris utilise encore celui de Windows,
                  la ligne le dit et propose d'installer le sien ; ensuite, un bouton apparaît seulement quand une
                  version plus récente est publiée. Plus de fenêtre d'installeur ni d'autorisation Windows. */}
              <SettingRow
                label="Ollama"
                description={
                  !ollamaVersionStatus
                    ? t('options.ollama.checking')
                    : !ollamaVersionStatus.embedded
                      ? ollamaVersionStatus.current
                        ? t('options.ollama.windows', { current: ollamaVersionStatus.current })
                        : t('options.ollama.windowsDown')
                      : !ollamaVersionStatus.current
                        ? t('options.ollama.down')
                        : ollamaVersionStatus.outdated
                          ? t('options.ollama.embeddedOutdated', { current: ollamaVersionStatus.current, latest: ollamaVersionStatus.latest ?? '' })
                          : ollamaVersionStatus.latest
                            ? t('options.ollama.embeddedCurrent', { current: ollamaVersionStatus.current })
                            : t('options.ollama.unknownLatest', { current: ollamaVersionStatus.current })
                }
              >
                {ollamaVersionStatus && (!ollamaVersionStatus.embedded || ollamaVersionStatus.outdated) && (
                  <button className="options-menu__action" onClick={handleUpdateOllama} disabled={updatingOllama}>
                    {updatingOllama
                      ? t('options.update.running')
                      : ollamaVersionStatus.embedded
                        ? t('options.update.button')
                        : t('options.ollama.install')}
                  </button>
                )}
              </SettingRow>
              {ollamaVersionStatus && !ollamaVersionStatus.embedded && !updatingOllama && (
                <p className="options-menu__ollama-update-note">{t('options.ollama.installSize')}</p>
              )}
              {updatingOllama && (
                <div className="options-menu__ollama-warning">
                  {/* Le paquet d'Ollama pèse 1,6 Go : même barre que la mise à jour de Jaris (étape 98). */}
                  <AppUpdateProgress progress={ollamaUpdateProgress} target="ollama" />
                </div>
              )}
              {!updatingOllama && ollamaUpdateMessage && <p className="options-menu__ollama-update-note">{ollamaUpdateMessage}</p>}

              <SettingRow
                label={t('options.folder.label')}
                description={t('options.folder.hint')}
              >
                <button className="options-menu__action" onClick={handleChooseModelsLocation} disabled={movingModelsLocation}>
                  {movingModelsLocation ? t('options.folder.moving') : t('options.folder.move')}
                </button>
              </SettingRow>
              {modelsLocation && (
                <ul className="options-menu__models-location-list">
                  {modelsLocation.items.map((item) => {
                    // « Libellé : chemin » à la française, « Libellé: chemin » ailleurs : la ponctuation suit le
                    // catalogue de la langue, le libellé garde son style à lui.
                    const [before, after] = t('common.labelValue', { label: '\u0000', value: item.path }).split('\u0000')
                    return (
                      <li key={item.label}>
                        {before}
                        <span className="options-menu__models-location-label">{item.label.charAt(0).toUpperCase() + item.label.slice(1)}</span>
                        {after}
                      </li>
                    )
                  })}
                </ul>
              )}
              {modelsLocationMessage && <p className="options-menu__ollama-update-note">{modelsLocationMessage}</p>}
            </SettingGroup>

            <SettingGroup title={t('options.history.group')}>
              {history === null ? (
                <p className="capacity-scan__status">{t('common.loading')}</p>
              ) : history.length === 0 ? (
                <p className="options-menu__history-empty">{t('options.history.empty')}</p>
              ) : (
                <ul className="options-menu__history-list">
                  {[...history].reverse().map((entry) => (
                    <li key={entry.id} className="options-menu__history-entry">
                      <div className="options-menu__history-date">{new Date(entry.timestamp).toLocaleString(currentLocale())}</div>
                      <div className="options-menu__history-transcript">{t('common.quoted', { text: entry.transcript })}</div>
                      <div className="options-menu__history-reply">{entry.reply}</div>
                    </li>
                  ))}
                </ul>
              )}
              {history !== null && (
                <SettingRow label={t('options.history.folder')} description={t('options.history.folder.hint')}>
                  <button className="options-menu__action" onClick={() => void window.jaris.openConversationHistoryFile()}>
                    {t('common.openFolder')}
                  </button>
                  {history.length > 0 && (
                    <button
                      className="options-menu__action options-menu__action--danger"
                      onClick={() => void handleClearHistory()}
                      disabled={clearingHistory}
                    >
                      {clearingHistory ? t('common.deleting') : t('options.history.clear')}
                    </button>
                  )}
                </SettingRow>
              )}
            </SettingGroup>

            <SettingGroup title={t('options.journal.label')}>
              <SettingRow label={t('options.journal.label')} description={t('options.journal.hint')}>
                <button className="options-menu__action" onClick={() => void window.jaris.openRequestJournal(false)}>
                  {t('options.journal.open')}
                </button>
                <button className="options-menu__action" onClick={() => void window.jaris.openRequestJournal(true)}>
                  {t('options.journal.reveal')}
                </button>
              </SettingRow>
            </SettingGroup>
          </div>
        )}

        <audio ref={audioRef} hidden />
        {error && <div className="options-menu__error">{error}</div>}
          </div>
        </main>
      </div>
    </div>
  )

  return embedded ? page : createPortal(page, document.body)
}
