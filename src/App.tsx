import { useCallback, useEffect, useRef, useState } from 'react'
import CapacityScan from '@/components/CapacityScan'
import ChatPanel from '@/components/ChatPanel'
import ChatWidget from '@/components/ChatWidget'
import CodePanel from '@/components/CodePanel'
import ErrorBoundary from '@/components/ErrorBoundary'
import ImagePanel from '@/components/ImagePanel'
import VideoPanel from '@/components/VideoPanel'
import KeepAlive from '@/components/KeepAlive'
import RuntimeSetup from '@/components/RuntimeSetup'
import JarisOrb from '@/components/JarisOrb'
import MemoryBrain from '@/components/MemoryBrain'
import OptionsMenu from '@/components/OptionsMenu'
import { playSoundCueIfEnabled } from '@/lib/soundDesign'
import { useJarisStore, type JarisEmotion } from '@/store/useJarisStore'
import type { AppVersionStatus, MemoryGraph, OllamaVersionStatus, WidgetMode, WindowChrome } from '../shared/ipc'
import ModelEffortPicker from '@/components/ModelEffortPicker'
import { ShellSlotsContext, VoiceLaunchContext } from '@/lib/shellContext'
import logo64 from '@/assets/jaris-logo-64.png'
import logo160 from '@/assets/jaris-logo-160.png'

const STATUS_LABEL: Record<JarisEmotion, string> = {
  idle: 'Parle à Jaris',
  listening: "Jaris t'écoute…",
  thinking: 'Jaris réfléchit…',
  happy: 'Jaris répond',
  surprised: 'Oups !'
}

/** Les modes de la barre latérale permanente (étape 30 ; Image à la place du Montage depuis l'étape 200). */
type AppMode = 'voice' | 'chat' | 'code' | 'image' | 'video'

/**
 * Design v2 (maquette « Jaris v2.dc.html », style Windows 11) : un rail d'icônes à gauche, libellé court sous
 * chaque icône, dans cet ordre. `label` est le nom affiché dans le rail, `title` celui de l'en-tête, `panel` le
 * titre de la colonne de liste à côté du rail (absente en Vocal : rien à lister).
 */
const MODES: Array<{ id: AppMode; label: string; title: string; panel?: string; icon: string }> = [
  { id: 'chat', label: 'Chat', title: 'Chat', panel: 'Conversations', icon: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z' },
  { id: 'voice', label: 'Vocal', title: 'Agent vocal', icon: 'M9 6a3 3 0 0 1 6 0v5a3 3 0 0 1-6 0zM5 11a7 7 0 0 0 14 0M12 18v3' },
  { id: 'code', label: 'Code', title: 'Code', panel: 'Projets', icon: 'M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16' },
  { id: 'image', label: 'Image', title: 'Image', panel: 'Images', icon: 'M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15.5 9.5h.01' },
  { id: 'video', label: 'Vidéo', title: 'Vidéo', panel: 'Vidéos', icon: 'M3 6h13v12H3zM16 10l5-3v10l-5-3' }
]

const ICON_BRAIN =
  'M9.5 3a3.5 3.5 0 0 0-3.4 4.4A3.5 3.5 0 0 0 5 13.6 3.5 3.5 0 0 0 9.5 21H12V3H9.5ZM14.5 3a3.5 3.5 0 0 1 3.4 4.4 3.5 3.5 0 0 1 1.1 6.2 3.5 3.5 0 0 1-4.5 7.4H12V3h2.5Z'
const ICON_WIDGET = 'M6 3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3zM12 12h6v6h-6z'
const ICON_OPTIONS =
  'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1'

function LineIcon({ d, size = 18 }: { d: string; size?: number }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

/**
 * Barre de titre façon Windows 11 : zone de déplacement de la fenêtre ; les boutons réduire/agrandir/fermer
 * sont les vrais de Windows, posés par-dessus à droite (titleBarOverlay, main.ts).
 */
function TitleBar(): JSX.Element {
  return (
    <div className="titlebar">
      <img className="titlebar__logo" src={logo64} alt="" />
      <span className="titlebar__name">Jaris</span>
    </div>
  )
}

function PanelToggleIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M9 4v16" />
    </svg>
  )
}

/** Une entrée de navigation : icône et libellé, avec un état actif discret. */
function RailButton({ label, icon, active, onClick, title }: {
  label: string
  icon: string
  active: boolean
  onClick: () => void
  title?: string
}): JSX.Element {
  return (
    <button
      className={`rail__item${active ? ' rail__item--active' : ''}`}
      onClick={onClick}
      title={title ?? label}
      aria-current={active ? 'page' : undefined}
    >
      <LineIcon d={icon} size={20} />
      <span className="rail__label">{label}</span>
    </button>
  )
}

/** Ce qu'affiche le gros bouton de l'Agent vocal selon l'état : le logo au repos, des barres qui bougent
 *  quand Jaris écoute ou parle, trois points quand il réfléchit (maquette Jaris.dc.html). */
function VoiceVisual({ emotion }: { emotion: JarisEmotion }): JSX.Element {
  // Design v2 : le logo reste toujours au centre (estompé pendant la réflexion), et deux anneaux couleur
  // d'accent s'élargissent autour quand Jaris écoute ou parle.
  const ringing = emotion === 'listening' || emotion === 'happy'
  return (
    <>
      {ringing && (
        <>
          <span className="voice-screen__ring" aria-hidden="true" />
          <span className="voice-screen__ring voice-screen__ring--late" aria-hidden="true" />
        </>
      )}
      <img className="voice-screen__logo" src={logo160} alt="" />
    </>
  )
}

/**
 * Deux fenêtres partagent ce même bundle : le widget flottant, toujours là en haut au centre de l'écran
 * (`?mode=widget`, façon "notch" depuis l'étape 68 — bas à droite avant), et la fenêtre de réglages classique
 * pour l'onboarding/Options/cerveau de Jaris (`?mode=full`, ou pas de paramètre du tout en développement).
 */
const MODE = new URLSearchParams(window.location.search).get('mode') === 'widget' ? 'widget' : 'full'

/** Taille de l'orbe replié au repos (étape 68, agrandie à la demande de Léo en usage réel : "agrandit un
 * peu") — le côté Electron (main.ts, WIDGET_COLLAPSED_WIDTH/HEIGHT) doit rester assez grand pour le contenir
 * sans le couper. */
const WIDGET_ORB_COLLAPSED_SIZE = 32
const WIDGET_ORB_EXPANDED_SIZE = 160

export default function App(): JSX.Element {
  const emotion = useJarisStore((state) => state.emotion)
  const setEmotion = useJarisStore((state) => state.setEmotion)
  const transcript = useJarisStore((state) => state.transcript)
  const reply = useJarisStore((state) => state.reply)
  const setupStatus = useJarisStore((state) => state.setupStatus)
  const setTranscript = useJarisStore((state) => state.setTranscript)
  const setReply = useJarisStore((state) => state.setReply)
  const setSetupStatus = useJarisStore((state) => state.setSetupStatus)

  const audioRef = useRef<HTMLAudioElement>(null)
  const audioUrlRef = useRef<string | null>(null)

  // undefined = pas encore chargé, null = pas de profil (premier lancement)
  const [profileName, setProfileName] = useState<string | null | undefined>(undefined)
  const [capacityScanDone, setCapacityScanDone] = useState<boolean | undefined>(undefined)
  const [runtimeReady, setRuntimeReady] = useState<boolean | undefined>(undefined)
  const [nameInput, setNameInput] = useState('')
  const [memoryGraph, setMemoryGraph] = useState<MemoryGraph | null>(null)
  const [newModels, setNewModels] = useState<string[]>([])
  // Étape 252 : ce que Jaris fait pendant une demande vocale (« Je réfléchis… 12 s »), `null` hors demande.
  const [voiceActivity, setVoiceActivity] = useState<string | null>(null)
  const [appMode, setAppMode] = useState<AppMode>('voice')
  const [ollamaVersionStatus, setOllamaVersionStatus] = useState<OllamaVersionStatus | null>(null)
  const [ollamaPopupDismissed, setOllamaPopupDismissed] = useState(false)
  const [appVersionStatus, setAppVersionStatus] = useState<AppVersionStatus | null>(null)
  const [appPopupDismissed, setAppPopupDismissed] = useState(false)
  // Design v2 : colonne de liste repliable (bouton en haut de la colonne, ou en haut à gauche de l'écran une
  // fois repliée), et emplacements qu'elle prête à l'écran affiché (shellContext.ts).
  const [panelOpen, setPanelOpen] = useState(
    () => !(typeof window !== 'undefined' && window.matchMedia?.('(max-width: 700px)').matches)
  )
  // Options est un écran du rail, pas un mode : le mode réel (écoute, widget) reste celui d'avant.
  const [optionsShown, setOptionsShown] = useState(false)
  // Barre de titre dessinée par Jaris — rien tant que le main n'a pas répondu (et jamais
  // hors Windows, où la fenêtre garde sa barre de titre native).
  const [chrome, setChrome] = useState<WindowChrome | null>(null)
  const [newSlot, setNewSlot] = useState<HTMLElement | null>(null)
  const [recentsSlot, setRecentsSlot] = useState<HTMLElement | null>(null)

  // Étape 265 : sur une fenêtre étroite, la liste se pose PAR-DESSUS le contenu (index.css) au lieu de
  // l'écraser à 160 px de large ; choisir une conversation la referme donc, comme un menu. Écouté sur le DOM :
  // la liste y arrive par portail, et les clics d'un portail ne remontent pas par cet arbre-ci dans React.
  useEffect(() => {
    if (!recentsSlot) return
    const onClick = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null
      if (target?.closest('.workspace__item') && window.matchMedia?.('(max-width: 700px)').matches) setPanelOpen(false)
    }
    recentsSlot.addEventListener('click', onClick)
    return () => recentsSlot.removeEventListener('click', onClick)
  }, [recentsSlot])
  const [titleSlot, setTitleSlot] = useState<HTMLElement | null>(null)
  const [appVersion, setAppVersion] = useState<string | null>(null)

  useEffect(() => {
    if (MODE !== 'full') return
    void window.jaris.getAppVersion().then(setAppVersion).catch(() => {})
  }, [])

  useEffect(() => {
    if (MODE !== 'full' || !window.jaris.getWindowChrome) return
    void window.jaris.getWindowChrome().then(setChrome).catch(() => {})
  }, [])

  /**
   * Micro de la barre de saisie : passe sur l'Agent vocal PUIS déclenche l'écoute. Le changement de mode est
   * envoyé au main tout de suite (pas seulement par l'effet plus haut, qui ne tourne qu'après le rendu) :
   * hors de l'Agent vocal, l'écoute est suspendue côté main, et l'ordre des messages IPC garantit qu'elle
   * est rétablie avant que le réveil n'arrive.
   */
  const launchVoice = useCallback((): void => {
    window.jaris.setActiveMode('voice')
    setAppMode('voice')
    setOptionsShown(false)
    window.jaris.triggerWake()
  }, [])

  /** Bouton « Parler à Jaris » et clic sur le logo de l'Agent vocal : une des 3 façons d'activer Jaris
   *  (Options → Voix, étape 81), relue à la volée comme le « + » plus bas. */
  const wakeFromClick = (): void => {
    void window.jaris.getProfile().then((profile) => {
      if (profile?.activationOrbClickEnabled === false) return
      window.jaris.triggerWake()
    })
  }

  // Le Cerveau s'affiche dans la zone principale, comme Options (étape 265) : en calque plein écran, il passait
  // sous les boutons réduire/agrandir/fermer de Windows, qui recouvraient « Ouvrir le dossier » et « Fermer ».
  const openMemoryBrain = (): void => {
    void window.jaris.getMemoryGraph().then((graph) => {
      setOptionsShown(false)
      setMemoryGraph(graph)
    })
  }

  // Suspend la réaction à la voix tant que l'onglet Chat ou Code est actif (à la demande explicite de
  // Léo) : Jaris n'a aucune raison de réagir au mot d'activation pendant que l'utilisateur écrit dans un
  // autre mode. Uniquement depuis la fenêtre de réglages (`?mode=full`, seule à avoir ces onglets) : le
  // widget (`?mode=widget`) n'a pas de sélecteur de mode et ne doit jamais envoyer ce signal.
  useEffect(() => {
    if (MODE !== 'full') return
    window.jaris.setActiveMode(appMode)
    // Repositionne l'état réel côté main quand cette fenêtre redevient visible (ex: rouverte depuis le
    // widget après avoir été repliée) : main.ts force déjà la reprise de l'écoute au repli (voir 'close'/
    // 'minimize' dans main.ts), donc sans ce resync l'onglet resté sur Chat/Code depuis la dernière fois
    // laisserait Jaris écouter alors que l'écran affiche encore Chat/Code, jusqu'au prochain clic d'onglet.
    const resync = (): void => {
      if (document.visibilityState === 'visible') window.jaris.setActiveMode(appMode)
    }
    document.addEventListener('visibilitychange', resync)
    return () => document.removeEventListener('visibilitychange', resync)
  }, [appMode])

  useEffect(() => {
    window.jaris.getProfile().then((profile) => {
      setProfileName(profile?.name ?? null)
      setCapacityScanDone(profile?.capacityScanDone ?? false)
    })
  }, [])

  // Ce que la machine a déjà (Python, Ollama) : relu à chaque démarrage plutôt qu'enregistré dans le
  // profil, parce que c'est l'état réel du disque qui compte — une désinstallation d'Ollama en dehors de
  // Jaris, ou une nouvelle dépendance Python ajoutée par une mise à jour, doit être détectée telle quelle.
  useEffect(() => {
    if (MODE !== 'full') return
    window.jaris
      .getRuntimeSetupStatus()
      .then((status) => setRuntimeReady(status.ready))
      // Statut illisible : on ne bloque pas l'utilisateur derrière un écran d'installation à cause de ça.
      .catch(() => setRuntimeReady(true))
  }, [])

  const handleOnboardingSubmit = (event: React.FormEvent): void => {
    event.preventDefault()
    const name = nameInput.trim()
    if (!name) return
    void window.jaris.saveProfile({ name }).then(() => {
      setProfileName(name)
      setCapacityScanDone(false)
    })
  }

  useEffect(() => {
    window.jaris.getSetupStatus().then(setSetupStatus)

    const unsubscribers = [
      window.jaris.onEmotion(setEmotion),
      window.jaris.onTranscript(setTranscript),
      window.jaris.onVoiceActivity(setVoiceActivity),
      window.jaris.onSetupStatus(setSetupStatus),
      // Seul le widget a un <audio> monté (voir plus bas) : en mode réglages, audioRef.current reste
      // null et cet appel ne fait rien — pas de double lecture de la voix si les deux fenêtres existent.
      window.jaris.onReply(({ reply: replyText, audio }) => {
        setReply(replyText)

        if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current)
        const blob = new Blob([audio], { type: 'audio/wav' })
        audioUrlRef.current = URL.createObjectURL(blob)
        if (audioRef.current) {
          const el = audioRef.current
          el.src = audioUrlRef.current
          // Relit le profil à chaque réponse plutôt qu'une seule fois au montage : le widget et la fenêtre
          // de réglages sont deux fenêtres/process renderer séparés (voir App.tsx en tête de fichier), donc
          // un changement de haut-parleur fait depuis Options (fenêtre réglages) n'apparaîtrait jamais ici
          // sans le relire. Peu fréquent (une seule fois par réponse parlée), le coût est négligeable.
          void window.jaris.getProfile().then((profile) => {
            const sinkId = profile?.audioOutputDeviceId
            const setSinkId = (el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }).setSinkId
            const applySink = sinkId && setSinkId ? setSinkId.call(el, sinkId) : Promise.resolve()
            void applySink.catch(() => {}).then(() => el.play())
          })
        }
      }),
      // Étape 31 : widget et fenêtre de réglages reçoivent tous les deux ce signal (broadcast, main.ts),
      // même quand l'un des deux est caché (juste win.hide(), jamais détruit — voir les commentaires plus
      // haut sur MODE/showFullWindow) : sans ce garde par visibilité, les deux joueraient le son en même
      // temps dès que les deux fenêtres existent, pour un bip entendu deux fois. playSoundCueIfEnabled
      // relit le profil à chaque cue (Options → Voix) plutôt que de le mettre en cache une fois.
      window.jaris.onSoundCue((cue) => {
        if (document.visibilityState !== 'visible') return
        void playSoundCueIfEnabled(cue)
      })
    ]

    return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Popup "nouveaux modèles" (étape 29) : vérifié une seule fois, quand la fenêtre de réglages est prête
  // (onboarding déjà fait) — jamais dans le widget, qui n'a pas la place ni l'onglet Modèles pour agir dessus.
  useEffect(() => {
    if (MODE !== 'full' || !capacityScanDone) return
    window.jaris.getNewModels().then(setNewModels)
  }, [capacityScanDone])

  const dismissNewModels = (): void => {
    void window.jaris.acknowledgeNewModels()
    setNewModels([])
  }

  // Popup "Ollama pas à jour" : même principe que newModels ci-dessus (jamais dans le widget, visible
  // depuis n'importe lequel des 3 modes de la fenêtre de réglages, pas seulement en ouvrant Options →
  // Modèles comme avant) — sinon l'utilisateur pouvait rater l'avertissement pendant des jours s'il
  // n'ouvrait jamais cet onglet précis. Le bandeau détaillé + le bouton "Mettre à jour" restent dans
  // OptionsMenu.tsx (étape 28, sa propre copie de ce même statut) : "Fermer" ici ne fait QUE cacher ce
  // popup pour la session en cours, jamais définitivement — toujours retrouvable dans Options → Modèles.
  useEffect(() => {
    if (MODE !== 'full' || !capacityScanDone) return
    window.jaris.getOllamaVersionStatus().then(setOllamaVersionStatus)
  }, [capacityScanDone])

  // Popup "Jaris pas à jour" (étape 20) : même principe que celui d'Ollama juste au-dessus — visible
  // depuis n'importe lequel des 3 modes, "Fermer" ne fait que le cacher pour la session en cours, toujours
  // retrouvable dans Options → Modèles (bandeau détaillé + bouton "Mettre à jour", OptionsMenu.tsx).
  useEffect(() => {
    if (MODE !== 'full' || !capacityScanDone) return
    window.jaris.getAppVersionStatus().then(setAppVersionStatus)
  }, [capacityScanDone])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      // Ignoré dès que l'utilisateur est en train d'écrire quelque part (message du mode Chat, description
      // du mode Code, champs du menu Options...) : sans ça, taper un "+" dans un texte déclencherait
      // l'écoute au lieu d'écrire le caractère.
      const target = event.target as HTMLElement | null
      const typing =
        target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable
      if (typing) return

      if (event.key === '+' && !event.repeat) {
        // Relit le profil à chaque pression plutôt que de garder un état React à synchroniser (voir
        // playSoundCueIfEnabled, soundDesign.ts, même pattern) : Options → Activation (étape 81) permet de
        // décocher cette touche si Léo préfère les deux autres façons d'activer Jaris.
        void window.jaris.getProfile().then((profile) => {
          if (profile?.activationKeyEnabled === false) return
          window.jaris.triggerWake()
        })
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Coupe la réponse en cours dès que Jaris se remet à écouter (mot d'activation "Jaris", ou + du pavé
  // numérique) : le sidecar Python écoute en continu, indépendamment de ce que fait
  // Electron (voir voicePipeline.ts), donc "listening" peut très bien arriver pendant que la réponse
  // précédente est encore en train d'être lue. Sans ça, la nouvelle capture démarrait bien mais l'ancienne
  // réponse continuait de parler par-dessus. Sans risque de no-op inutile : appeler pause() sur un <audio>
  // déjà à l'arrêt ne fait rien.
  useEffect(() => {
    if (MODE === 'widget' && emotion === 'listening') {
      audioRef.current?.pause()
    }
  }, [emotion])

  // La fenêtre du widget est créée transparente côté Electron (voir electron/main.ts), mais ça ne suffit
  // pas : tant que <html>/<body> gardent leur fond dégradé sombre, on verrait quand même un rectangle
  // opaque à la place du widget.
  useEffect(() => {
    if (MODE === 'widget') {
      document.documentElement.classList.add('body--widget')
      document.body.classList.add('body--widget')
    }
  }, [])

  // Léo, en usage réel, juste après le correctif de la taille native du widget : "on voit d'abord jaris
  // essayer d'aller dans le widget quand il est inactif et apres etre actif mais en 0.5s". Le widget est
  // CACHÉ (win.hide()) la plupart du temps, et Chromium ne peint pas une fenêtre cachée : quand l'émotion
  // passe à 'listening' pendant ce temps, le DOM change bien, mais l'ancien état (replié) reste le dernier
  // état réellement PEINT. À l'affichage, le navigateur reprend donc la transition CSS de .widget-rest/
  // .widget-active (320ms, index.css) depuis cet ancien état — d'où la pilule "repos" visible une demi-
  // seconde avant de se déplier, alors que Jaris écoutait déjà avant même le repli.
  // Corrigé en coupant les transitions tant que la fenêtre est cachée (aucune transition en attente ne peut
  // alors se créer) et en ne les réactivant qu'après une vraie frame peinte dans le bon état.
  // Ce que le widget doit être quand on quitte Jaris : le cercle qui écoute (depuis l'Agent vocal) ou une
  // barre de texte (depuis le Chat) — voir WidgetMode, shared/ipc.ts. Le main décide, le renderer se
  // contente de suivre : les deux doivent dessiner et dimensionner la MÊME forme.
  // Lu au montage ET écouté ensuite : le `widgetMode` envoyé juste avant l'affichage peut arriver alors que
  // ce renderer vient tout juste d'être créé et n'écoute pas encore, et la forme change d'un repli à
  // l'autre sur une fenêtre qui, elle, n'est jamais détruite.
  const [widgetMode, setWidgetMode] = useState<WidgetMode>('voice')
  useEffect(() => {
    if (MODE !== 'widget') return
    void window.jaris.getWidgetMode().then(setWidgetMode)
    return window.jaris.onWidgetMode(setWidgetMode)
  }, [])

  const [widgetInstant, setWidgetInstant] = useState(() => document.visibilityState !== 'visible')
  useEffect(() => {
    if (MODE !== 'widget') return
    let firstFrame = 0
    let secondFrame = 0
    const onVisibilityChange = (): void => {
      if (document.visibilityState !== 'visible') {
        setWidgetInstant(true)
        return
      }
      // Deux frames : la première peint l'état courant sans transition, la seconde rend la main aux
      // animations pour les changements d'émotion suivants, widget déjà à l'écran.
      firstFrame = requestAnimationFrame(() => {
        secondFrame = requestAnimationFrame(() => setWidgetInstant(false))
      })
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      cancelAnimationFrame(firstFrame)
      cancelAnimationFrame(secondFrame)
    }
  }, [])

  if (profileName === undefined) {
    return <div className="app" />
  }

  if (MODE === 'full') {
    // Étape 265 : les écrans du premier lancement n'avaient AUCUNE barre de titre — la barre native étant
    // cachée (titleBarStyle: 'hidden'), la fenêtre ne pouvait même plus être déplacée avant la fin de
    // l'installation. Ils gardent maintenant la même barre que le reste de Jaris.
    const setupShell = (screen: JSX.Element): JSX.Element =>
      chrome?.titleBar ? (
        <div className="app-shell app-shell--titlebar app-shell--setup">
          <TitleBar />
          <div className="app-shell__setup">{screen}</div>
        </div>
      ) : (
        screen
      )

    if (profileName === null) {
      return setupShell(
        <div className="app">
          <form className="app__onboarding" onSubmit={handleOnboardingSubmit}>
            <img className="app__onboarding-logo" src={logo160} alt="Jaris" />
            <h1>Bienvenue sur Jaris</h1>
            <p>
              Ton assistant personnel, 100 % local. Rien ne quitte ton ordinateur, et c'est gratuit. Comment
              dois-je t'appeler ?
            </p>
            <input
              autoFocus
              value={nameInput}
              onChange={(event) => setNameInput(event.target.value)}
              placeholder="Ton prénom"
            />
            <button type="submit">Commencer</button>
          </form>
        </div>
      )
    }

    // Avant tout le reste : sans Python ni Ollama installés, ni la voix ni la conversation ne peuvent
    // fonctionner. `undefined` = on ne sait pas encore (statut en cours de lecture), surtout pas "à
    // installer" : ça ferait clignoter cet écran à chaque démarrage sur une machine déjà prête.
    if (runtimeReady === false) {
      return setupShell(<RuntimeSetup onDone={() => setRuntimeReady(true)} />)
    }

    if (!capacityScanDone) {
      return setupShell(
        <CapacityScan
          onDone={() => {
            setCapacityScanDone(true)
            // Bascule vers le widget flottant : cette fenêtre de réglages se cache, Jaris reste visible
            // en bas à droite de l'écran.
            window.jaris.notifyOnboardingFinished()
          }}
        />
      )
    }

    const currentMode = MODES.find((mode) => mode.id === appMode) ?? MODES[0]
    // La section récente n'est visible que pour les écrans qui ont quelque chose à lister. Son conteneur
    // reste monté quand la barre se replie afin que Workspace conserve ses emplacements de portail.
    // Un écran du rail qui n'est pas un mode (Options, Cerveau) remplace le contenu sans changer le mode réel.
    const screenShown = optionsShown || !!memoryGraph
    const hasPanel = !screenShown && !!currentMode.panel
    const selectMode = (id: AppMode): void => {
      setAppMode(id)
      setOptionsShown(false)
      setMemoryGraph(null)
    }

    return (
      <ShellSlotsContext.Provider value={{ newSlot, recentsSlot, titleSlot }}>
      <VoiceLaunchContext.Provider value={launchVoice}>
      <div className={`app-shell${chrome?.titleBar ? ' app-shell--titlebar' : ''}`}>
        {chrome?.titleBar && <TitleBar />}

        <div className="app-shell__body">
          <aside className={`app-sidebar${hasPanel && panelOpen ? ' app-sidebar--expanded' : ''}`}>
            <nav className="app-sidebar__nav" aria-label="Modes de Jaris">
              <div className="app-sidebar__brand">
                <img src={logo64} alt="" />
                <span>Jaris</span>
              </div>
              {MODES.map(({ id, label, title, icon }) => (
                <RailButton
                  key={id}
                  label={label}
                  title={title}
                  icon={icon}
                  active={!screenShown && appMode === id}
                  onClick={() => selectMode(id)}
                />
              ))}
            </nav>

            <section
              className="app-sidebar__workspace"
              aria-label={currentMode.panel ?? 'Éléments récents'}
              hidden={!hasPanel || !panelOpen}
            >
              <div className="panel__head">
                <span className="panel__title">{currentMode.panel}</span>
                <button
                  className="panel__icon-button"
                  onClick={() => setPanelOpen(false)}
                  title="Réduire la barre latérale"
                  aria-label="Réduire la barre latérale"
                >
                  <PanelToggleIcon />
                </button>
              </div>
              {/* Action de création de l'écran courant, fournie par Workspace : une ligne à part entière sous le
                  titre, comme « Nouveau chat » dans ChatGPT (étape 266). */}
              <div className="panel__new" ref={setNewSlot} />
              {/* Liste de l'écran affiché : conversations, projets, images ou vidéos. */}
              <div className="panel__list" ref={setRecentsSlot} />
              <div className="panel__status">
                <span className="panel__status-dot" />
                Local{appVersion ? ` · v${appVersion}` : ''}
              </div>
            </section>

            <nav className="app-sidebar__utilities" aria-label="Outils de Jaris">
              <RailButton label="Cerveau" title="Cerveau de Jaris" icon={ICON_BRAIN} active={!!memoryGraph} onClick={openMemoryBrain} />
              <RailButton
                label="Widget"
                title="Réduire en widget"
                icon={ICON_WIDGET}
                active={false}
                onClick={() => window.jaris.minimizeToWidget?.()}
              />
              <RailButton
                label="Options"
                icon={ICON_OPTIONS}
                active={optionsShown}
                onClick={() => {
                  setMemoryGraph(null)
                  setOptionsShown(true)
                }}
              />
            </nav>
          </aside>

          <main className="app-main">
            <header className="app-header">
              {hasPanel && !panelOpen && (
                <button
                  className="panel__icon-button"
                  onClick={() => setPanelOpen(true)}
                  title="Afficher la liste"
                  aria-label="Afficher la liste"
                >
                  <PanelToggleIcon />
                </button>
              )}
              {/* L'écran affiché y écrit son titre (conversation ouverte...) par portail ; vide (Agent vocal,
                  Options, écran d'installation), le nom de l'écran s'affiche à la place (data-label, index.css). */}
              <span
                className="app-header__title"
                ref={screenShown ? undefined : setTitleSlot}
                data-label={optionsShown ? 'Options' : memoryGraph ? 'Cerveau de Jaris' : currentMode.title}
              />
            </header>

            {newModels.length > 0 && (
              <div className="app__new-models">
                <p>
                  {newModels.length === 1 ? 'Nouveau modèle disponible : ' : `${newModels.length} nouveaux modèles disponibles : `}
                  <strong>{newModels.join(', ')}</strong>. Ouvre Options → Modèles puis « Retester la
                  configuration » pour voir s'ils conviennent mieux à ta config.
                </p>
                <button onClick={dismissNewModels}>Fermer</button>
              </div>
            )}

            {ollamaVersionStatus?.outdated && !ollamaPopupDismissed && (
              <div className="app__new-models">
                <p>
                  Ollama {ollamaVersionStatus.current} installé, la dernière version est{' '}
                  {ollamaVersionStatus.latest}. Ouvre Options → Général pour mettre à jour.
                </p>
                <button onClick={() => setOllamaPopupDismissed(true)}>Fermer</button>
              </div>
            )}

            {appVersionStatus?.outdated && !appPopupDismissed && (
              <div className="app__new-models">
                <p>
                  {/* Onglet "Mise à jour", pas "Modèles" : celui de Jaris a son propre onglet depuis qu'il a
                      été séparé de celui d'Ollama, mais cette phrase était restée sur l'ancien — envoyer
                      quelqu'un sur un onglet où le bouton n'est pas est une autre façon de "ne rien faire". */}
                  Jaris {appVersionStatus.current} installé, la dernière version est{' '}
                  {appVersionStatus.latest}. Ouvre Options → Général pour l'installer.
                </p>
                <button onClick={() => setAppPopupDismissed(true)}>Fermer</button>
              </div>
            )}

            {optionsShown && (
              <ErrorBoundary label="Les Options">
                <OptionsMenu embedded />
              </ErrorBoundary>
            )}

            {memoryGraph && (
              <ErrorBoundary label="Le Cerveau de Jaris">
                <MemoryBrain graph={memoryGraph} />
              </ErrorBoundary>
            )}

            {!screenShown && appMode === 'voice' && (
              // Design v2 : le logo au centre d'un cercle, des anneaux couleur d'accent quand Jaris écoute ou
              // parle, l'échange en cours dans une carte, et un bouton « Parler à Jaris » bien visible.
              <ErrorBoundary label="L'Agent vocal">
                <div className="app app--voice voice-screen" data-emotion={emotion}>
                  <button
                    type="button"
                    className="voice-screen__button"
                    aria-label="Activer l'écoute"
                    onClick={wakeFromClick}
                  >
                    <VoiceVisual emotion={emotion} />
                  </button>
                  <div className="app__voice-footer">
                    <h1 className="app__status">{STATUS_LABEL[emotion]}</h1>
                    {emotion === 'idle' && <div className="app__hint">Jaris répond à voix haute.</div>}

                    {(transcript || reply || voiceActivity) && (
                      <div className="app__conversation">
                        {transcript && <p className="app__transcript">Toi : « {transcript} »</p>}
                        {voiceActivity && <p className="app__activity">{voiceActivity}</p>}
                        {reply && <p className="app__reply">Jaris : {reply}</p>}
                      </div>
                    )}

                    {emotion === 'idle' && (
                      <button type="button" className="voice-screen__talk" onClick={wakeFromClick}>
                        Parler à Jaris
                      </button>
                    )}

                    <div className="app__hint app__hint--small">
                      Ou dis « Jaris », ou appuie sur + du pavé numérique, depuis n'importe quelle appli.
                    </div>

                    {/* Étape 141 : même sélecteur que le Chat et le mode Code — Auto ou un modèle précis pour la voix. */}
                    <div className="app__model-picker">
                      <ModelEffortPicker mode="voice" />
                    </div>

                    {setupStatus && !setupStatus.ready && (
                      <div className="app__setup-warning">
                        {/* Étape 234 (bêta) : « pipeline vocal », « sidecar » et « voir le README » ne disaient rien à
                            quelqu'un qui n'a jamais vu le code — et aucun fichier d'explication n'est livré avec Jaris. */}
                        La voix ne fonctionne pas pour l'instant (le Chat, lui, marche) :
                        <ul>
                          {setupStatus.missing.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                        Ferme puis relance Jaris : il réessaiera d'installer ce qui manque.
                      </div>
                    )}
                  </div>
                </div>
              </ErrorBoundary>
            )}

            {/* Étape 202 : cachés, jamais détruits, en changeant d'onglet — une génération en cours reste visible au retour. */}
            <KeepAlive active={!screenShown && appMode === 'chat'}>
              <ErrorBoundary label="Le Chat">
                <ChatPanel />
              </ErrorBoundary>
            </KeepAlive>
            <KeepAlive active={!screenShown && appMode === 'code'}>
              <ErrorBoundary label="Le mode Code">
                <CodePanel />
              </ErrorBoundary>
            </KeepAlive>
            <KeepAlive active={!screenShown && appMode === 'image'}>
              <ErrorBoundary label="Le mode Image">
                <ImagePanel />
              </ErrorBoundary>
            </KeepAlive>
            <KeepAlive active={!screenShown && appMode === 'video'}>
              <ErrorBoundary label="Le mode Vidéo">
                <VideoPanel />
              </ErrorBoundary>
            </KeepAlive>
          </main>
        </div>

      </div>
      </VoiceLaunchContext.Provider>
      </ShellSlotsContext.Provider>
    )
  }

  // Quitter Jaris depuis le Chat donne une barre de texte à la place du cercle qui écoute (voir
  // ChatWidget.tsx). Rendu à part plutôt qu'en variante du widget vocal : les deux n'ont ni le même contenu,
  // ni la même mécanique (l'un suit l'émotion du pipeline vocal, l'autre ce que l'utilisateur tape), et les
  // mélanger dans un seul arbre aurait fait cohabiter deux logiques de dépliage sur les mêmes éléments.
  if (widgetMode === 'chat' || widgetMode === 'chat-idle') {
    return (
      <div className={`app app--widget app--widget-chat${widgetMode === 'chat-idle' ? ' app--widget-chat-idle' : ''}${widgetInstant ? ' app--widget-instant' : ''}`}>
        <ChatWidget inactive={widgetMode === 'chat-idle'} />
      </div>
    )
  }

  // Les deux rendus restent montés : le fondu/zoom reste continu, même si l'émotion
  // change de nouveau avant la fin de la transition.
  const widgetCollapsed = emotion === 'idle'
  return (
    <div
      className={`app app--widget${widgetCollapsed ? ' app--widget-collapsed' : ''}${
        widgetInstant ? ' app--widget-instant' : ''
      }`}
    >
      <div className="widget-rest" aria-hidden={!widgetCollapsed}>
        <div className="widget-pill">
          <JarisOrb emotion={emotion} size={WIDGET_ORB_COLLAPSED_SIZE}
            onClick={() => window.jaris.openSettings()} />
        </div>
      </div>
      <div className="widget-active" aria-hidden={widgetCollapsed}>
        <JarisOrb emotion={emotion} audioElRef={audioRef} size={WIDGET_ORB_EXPANDED_SIZE}
          onClick={() => window.jaris.openSettings()} />
      </div>
      <div className="widget-details" aria-hidden={widgetCollapsed}>
        <div className="app__status app__status--widget">{STATUS_LABEL[emotion]}</div>
        {(transcript || reply) && (
          <div className="app__conversation app__conversation--widget">
            {transcript && <p className="app__transcript">« {transcript} »</p>}
            {voiceActivity && <p className="app__activity">{voiceActivity}</p>}
            {reply && <p className="app__reply">{reply}</p>}
          </div>
        )}
      </div>

      <audio
        ref={audioRef}
        hidden
        onEnded={() => window.jaris.notifyAudioEnded()}
        onError={() => window.jaris.notifyAudioEnded()}
      />
    </div>
  )
}
