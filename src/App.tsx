import { useEffect, useRef, useState } from 'react'
import CapacityScan from '@/components/CapacityScan'
import ChatPanel from '@/components/ChatPanel'
import GmailOnboarding from '@/components/GmailOnboarding'
import JarisOrb from '@/components/JarisOrb'
import MemoryBrain from '@/components/MemoryBrain'
import OptionsMenu from '@/components/OptionsMenu'
import { useJarisStore, type JarisEmotion } from '@/store/useJarisStore'
import type { MemoryGraph } from '../shared/ipc'

const STATUS_LABEL: Record<JarisEmotion, string> = {
  idle: 'Jaris dort...',
  listening: "Jaris t'écoute",
  thinking: 'Jaris réfléchit...',
  happy: 'Tâche accomplie',
  surprised: 'Oups !'
}

/** Les modes de la colonne latérale permanente (étape 30). */
type AppMode = 'voice' | 'chat'

const MODES: Array<{ id: AppMode; label: string; hint: string }> = [
  { id: 'voice', label: 'Agent vocal', hint: 'Parler à Jaris' },
  { id: 'chat', label: 'Chat', hint: 'Écrire à Jaris' }
]

/**
 * Deux fenêtres partagent ce même bundle (étape 19) : le widget flottant, toujours là en bas à droite
 * (`?mode=widget`), et la fenêtre de réglages classique pour l'onboarding/Options/cerveau de Jaris
 * (`?mode=full`, ou pas de paramètre du tout en développement).
 */
const MODE = new URLSearchParams(window.location.search).get('mode') === 'widget' ? 'widget' : 'full'

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
  const [gmailOnboardingDone, setGmailOnboardingDone] = useState<boolean | undefined>(undefined)
  const [capacityScanDone, setCapacityScanDone] = useState<boolean | undefined>(undefined)
  const [nameInput, setNameInput] = useState('')
  const [memoryGraph, setMemoryGraph] = useState<MemoryGraph | null>(null)
  const [newModels, setNewModels] = useState<string[]>([])
  const [appMode, setAppMode] = useState<AppMode>('voice')

  const openMemoryBrain = (): void => {
    void window.jaris.getMemoryGraph().then(setMemoryGraph)
  }

  useEffect(() => {
    window.jaris.getProfile().then((profile) => {
      setProfileName(profile?.name ?? null)
      setGmailOnboardingDone(profile?.gmailOnboardingDone ?? false)
      setCapacityScanDone(profile?.capacityScanDone ?? false)
    })
  }, [])

  const handleOnboardingSubmit = (event: React.FormEvent): void => {
    event.preventDefault()
    const name = nameInput.trim()
    if (!name) return
    void window.jaris.saveProfile({ name }).then(() => {
      setProfileName(name)
      setGmailOnboardingDone(false)
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
          audioRef.current.src = audioUrlRef.current
          void audioRef.current.play()
        }
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

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      // Ignoré dès que l'utilisateur est en train d'écrire quelque part (message du mode Chat, champs du
      // menu Options...) : sans ça, taper un "+" dans un texte déclencherait l'écoute au lieu d'écrire le
      // caractère.
      const target = event.target as HTMLElement | null
      const typing =
        target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable
      if (typing) return

      if (event.key === '+' && !event.repeat) {
        window.jaris.triggerWake()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // La fenêtre du widget est créée transparente côté Electron (voir electron/main.ts), mais ça ne suffit
  // pas : tant que <html>/<body> gardent leur fond dégradé sombre, on verrait quand même un rectangle
  // opaque à la place du widget.
  useEffect(() => {
    if (MODE === 'widget') {
      document.documentElement.classList.add('body--widget')
      document.body.classList.add('body--widget')
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

    if (!gmailOnboardingDone) {
      return <GmailOnboarding onDone={() => setGmailOnboardingDone(true)} />
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
          <div className="sidebar__brand">JARIS</div>

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
                <strong>{newModels.join(', ')}</strong>. Ouvre Options → Modèles puis « Tester tous les
                modèles » pour voir s'ils conviennent mieux à ta config.
              </p>
              <button onClick={dismissNewModels}>Fermer</button>
            </div>
          )}

          {appMode === 'voice' && (
            <div className="app app--voice">
              {/* Pas d'audioElRef ici : seul le widget a un <audio> monté, l'orbe de cette fenêtre suit juste
                  l'émotion sans vibrer avec la voix (évite toute double lecture du son des réponses). */}
              <JarisOrb emotion={emotion} />
              <div className="app__status">{STATUS_LABEL[emotion]}</div>
              <div className="app__hint">
                Astuce : dis « Hey Jarvis » ou appuie sur le + du pavé numérique, depuis n'importe quelle
                appli, pour activer l'écoute
              </div>

              {(transcript || reply) && (
                <div className="app__conversation">
                  {transcript && <p className="app__transcript">« {transcript} »</p>}
                  {reply && <p className="app__reply">{reply}</p>}
                </div>
              )}

              {setupStatus && !setupStatus.ready && (
                <div className="app__setup-warning">
                  Pipeline vocal pas encore configuré :
                  <ul>
                    {setupStatus.missing.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                  Voir le README pour les étapes d'installation.
                </div>
              )}
            </div>
          )}

          {appMode === 'chat' && <ChatPanel />}
        </main>

        {memoryGraph && <MemoryBrain graph={memoryGraph} onClose={() => setMemoryGraph(null)} />}
      </div>
    )
  }

  // MODE === 'widget' : uniquement créé une fois l'onboarding terminé, donc profileName est déjà connu ici.
  return (
    <div className="app app--widget">
      <JarisOrb emotion={emotion} audioElRef={audioRef} size={160} onClick={() => window.jaris.openSettings()} />
      <div className="app__status app__status--widget">{STATUS_LABEL[emotion]}</div>

      {(transcript || reply) && (
        <div className="app__conversation app__conversation--widget">
          {transcript && <p className="app__transcript">« {transcript} »</p>}
          {reply && <p className="app__reply">{reply}</p>}
        </div>
      )}

      <audio
        ref={audioRef}
        hidden
        onEnded={() => window.jaris.notifyAudioEnded()}
        onError={() => window.jaris.notifyAudioEnded()}
      />
    </div>
  )
}
