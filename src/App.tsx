import { useCallback, useEffect, useRef, useState } from 'react'
import CapacityScan from '@/components/CapacityScan'
import ChatPanel from '@/components/ChatPanel'
import ChatWidget from '@/components/ChatWidget'
import CodePanel from '@/components/CodePanel'
import RuntimeSetup from '@/components/RuntimeSetup'
import JarisOrb from '@/components/JarisOrb'
import MemoryBrain from '@/components/MemoryBrain'
import OptionsMenu from '@/components/OptionsMenu'
import { playSoundCueIfEnabled } from '@/lib/soundDesign'
import { useJarisStore, type JarisEmotion } from '@/store/useJarisStore'
import type { AppVersionStatus, MemoryGraph, OllamaVersionStatus, WidgetMode } from '../shared/ipc'
import ModelPicker from '@/components/ModelPicker'

const STATUS_LABEL: Record<JarisEmotion, string> = {
  idle: 'Prêt à t’aider',
  listening: "Jaris t'écoute",
  thinking: 'Jaris réfléchit...',
  happy: 'Tâche accomplie',
  surprised: 'Oups !'
}

/** Les 3 modes de la colonne latérale permanente (étape 30). */
type AppMode = 'voice' | 'chat' | 'code'

const MODES: Array<{ id: AppMode; label: string; hint: string }> = [
  { id: 'voice', label: 'Agent vocal', hint: 'Parler à Jaris' },
  { id: 'chat', label: 'Chat', hint: 'Écrire à Jaris' },
  { id: 'code', label: 'Code', hint: 'Générer une application' }
]

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

  // Taille de l'orbe de l'écran Agent vocal (défaut 320px, comme avant) : Léo a signalé que réduire la
  // fenêtre pendant/après une demande transforme le cercle en une simple ligne orange ondulée — l'orbe
  // restait à 320px fixe et se faisait ROGNER par `.app-main` (overflow: hidden) dès que la fenêtre devenait
  // plus petite que lui, ne laissant visible qu'une fine bande horizontale au milieu de l'anneau irrégulier.
  // **Premier correctif (v0.5.5) insuffisant, remplacé ici** : `.app__orb-stage` prenait, via `flex: 1`,
  // TOUT l'espace restant dans `.app--voice` — ce qui poussait le statut/l'astuce tout en bas de l'écran sur
  // une fenêtre normale/grande (signalé par Léo : "pourquoi le texte est tout en bas"), alors qu'avant ce
  // premier correctif l'orbe et le texte formaient un seul groupe CENTRÉ ensemble. Corrigé en mesurant
  // directement la hauteur du bloc statut/astuce/conversation (`.app__voice-footer` ci-dessous, via
  // `getBoundingClientRect` sur le nœud trouvé dans le conteneur observé) plutôt que de lui laisser du
  // flex-grow décider : la taille de l'orbe est déduite de "hauteur totale du conteneur moins hauteur du
  // footer", sans jamais toucher à `justify-content: center` sur `.app` — l'orbe et le footer redeviennent un
  // groupe centré comme à l'origine, qui rétrécit ENSEMBLE si besoin plutôt que de se répartir aux deux bouts
  // de l'écran. Un seul `ResizeObserver` observe À LA FOIS le conteneur (redimensionnement de la fenêtre) ET
  // le footer (apparition du transcript/de la réponse, qui change sa hauteur sans changer celle de la
  // fenêtre) — measure() relit toujours les deux tailles fraîches via le DOM plutôt que de se fier à
  // `entry.contentRect`, donc peu importe lequel des deux déclenche le rappel. Rétrécit jusqu'à
  // MINIMAL_SIZE_THRESHOLD (JarisOrb.tsx), où le rendu simplifié du widget replié prend le relais plutôt que
  // de continuer à rogner un anneau détaillé.
  const [orbSize, setOrbSize] = useState(320)
  const orbResizeObserverRef = useRef<ResizeObserver | null>(null)
  const voiceLayoutRef = useCallback((el: HTMLDivElement | null) => {
    orbResizeObserverRef.current?.disconnect()
    orbResizeObserverRef.current = null
    if (!el) return
    const ORB_MAX = 320
    const ORB_MIN = 24
    const MARGIN = 24
    const update = (): void => {
      const footer = el.querySelector<HTMLElement>('.app__voice-footer')
      const footerHeight = footer?.getBoundingClientRect().height ?? 0
      const available = Math.min(el.clientWidth, el.clientHeight - footerHeight) - MARGIN
      setOrbSize(Math.max(ORB_MIN, Math.min(ORB_MAX, available)))
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    const footer = el.querySelector<HTMLElement>('.app__voice-footer')
    if (footer) observer.observe(footer)
    orbResizeObserverRef.current = observer
  }, [])

  // undefined = pas encore chargé, null = pas de profil (premier lancement)
  const [profileName, setProfileName] = useState<string | null | undefined>(undefined)
  const [capacityScanDone, setCapacityScanDone] = useState<boolean | undefined>(undefined)
  const [runtimeReady, setRuntimeReady] = useState<boolean | undefined>(undefined)
  const [nameInput, setNameInput] = useState('')
  const [memoryGraph, setMemoryGraph] = useState<MemoryGraph | null>(null)
  const [newModels, setNewModels] = useState<string[]>([])
  const [appMode, setAppMode] = useState<AppMode>('voice')
  const [ollamaVersionStatus, setOllamaVersionStatus] = useState<OllamaVersionStatus | null>(null)
  const [ollamaPopupDismissed, setOllamaPopupDismissed] = useState(false)
  const [appVersionStatus, setAppVersionStatus] = useState<AppVersionStatus | null>(null)
  const [appPopupDismissed, setAppPopupDismissed] = useState(false)

  const openMemoryBrain = (): void => {
    void window.jaris.getMemoryGraph().then(setMemoryGraph)
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
    if (profileName === null) {
      return (
        <div className="app">
          <form className="app__onboarding" onSubmit={handleOnboardingSubmit}>
            <div className="welcome-mascot">
              <JarisOrb emotion="happy" size={120} />
            </div>
            <h1>Bonjour !</h1>
            <p>Comment dois-je t'appeler ?</p>
            <input
              autoFocus
              value={nameInput}
              onChange={(event) => setNameInput(event.target.value)}
              placeholder="Ton prénom"
            />
            <button type="submit">Valider</button>
          </form>
        </div>
      )
    }

    // Avant tout le reste : sans Python ni Ollama installés, ni la voix ni la conversation ne peuvent
    // fonctionner. `undefined` = on ne sait pas encore (statut en cours de lecture), surtout pas "à
    // installer" : ça ferait clignoter cet écran à chaque démarrage sur une machine déjà prête.
    if (runtimeReady === false) {
      return <RuntimeSetup onDone={() => setRuntimeReady(true)} />
    }

    if (!capacityScanDone) {
      return (
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

    return (
      <div className="app-shell">
        <nav className="sidebar">
          <div className="sidebar__brand">
            <JarisOrb emotion="idle" size={34} />
            Jaris
          </div>

          <div className="sidebar__modes">
            {MODES.map(({ id, label, hint }) => (
              <button
                key={id}
                className={`sidebar__mode${appMode === id ? ' sidebar__mode--active' : ''}`}
                onClick={() => setAppMode(id)}
              >
                <span className="sidebar__mode-label">{label}</span>
                <span className="sidebar__mode-hint">{hint}</span>
              </button>
            ))}
          </div>

          <div className="sidebar__footer">
            <button className="sidebar__link" onClick={openMemoryBrain}>
              Cerveau de Jaris
            </button>
            <OptionsMenu />
          </div>
        </nav>

        <main className="app-main">
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
                {ollamaVersionStatus.latest}. Ouvre Options → Modèles pour mettre à jour.
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
                {appVersionStatus.latest}. Ouvre Options → Mise à jour pour l'installer.
              </p>
              <button onClick={() => setAppPopupDismissed(true)}>Fermer</button>
            </div>
          )}

          {appMode === 'voice' && (
            <div className="app app--voice" ref={voiceLayoutRef}>
              {/* Pas d'audioElRef ici : seul le widget a un <audio> monté, l'orbe de cette fenêtre suit juste
                  l'émotion sans vibrer avec la voix (évite toute double lecture du son des réponses).
                  onClick : une des 3 façons d'activer Jaris (Options → Activation, étape 81), avec la même
                  relecture du profil à la volée que le "+" ci-dessus plutôt qu'un état React à synchroniser.
                  Orbe en enfant DIRECT de .app (pas dans un conteneur à part) : voir voiceLayoutRef ci-dessus
                  — orbe et .app__voice-footer forment un seul groupe, centré par le justify-content:center
                  déjà présent sur .app, qui rétrécit ensemble plutôt que de se répartir aux deux bouts de
                  l'écran. */}
              <JarisOrb
                emotion={emotion}
                size={orbSize}
                onClick={() => {
                  void window.jaris.getProfile().then((profile) => {
                    if (profile?.activationOrbClickEnabled === false) return
                    window.jaris.triggerWake()
                  })
                }}
              />
              {/* Regroupe tout ce qui n'est pas l'orbe : voiceLayoutRef mesure la hauteur de CE bloc (pas
                  chacun de ses enfants séparément) pour déduire l'espace réellement laissé à l'orbe. */}
              <div className="app__voice-footer">
                <div className="app__status">{STATUS_LABEL[emotion]}</div>
                <div className="app__hint">
                  Astuce : dis « Jaris », clique sur lui, ou appuie sur le + du pavé numérique depuis
                  n'importe quelle appli, pour activer l'écoute (personnalisable dans Options → Activation)
                </div>

                {/* Étape 141 : même sélecteur que le Chat et le mode Code — Auto ou un modèle précis pour la voix. */}
                <div className="app__model-picker">
                  <ModelPicker mode="voice" />
                </div>

                {(transcript || reply) && (
                  <div className="app__conversation">
                    {transcript && <p className="app__transcript">« {transcript} »</p>}
                    {reply && <p className="app__reply">{reply}</p>}
                  </div>
                )}

                {setupStatus && !setupStatus.ready && (
                  <div className="app__setup-warning">
                    Échec du démarrage du pipeline vocal :
                    <ul>
                      {setupStatus.missing.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                    Voir le README pour les étapes d'installation.
                  </div>
                )}
              </div>
            </div>
          )}

          {appMode === 'chat' && <ChatPanel />}
          {appMode === 'code' && <CodePanel />}
        </main>

        {memoryGraph && <MemoryBrain graph={memoryGraph} onClose={() => setMemoryGraph(null)} />}
      </div>
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
