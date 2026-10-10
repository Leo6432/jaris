import { useEffect, useRef, useState, type CSSProperties } from 'react'
import Composer from '@/components/Composer'
import EmptyState from '@/components/EmptyState'
import Workspace from '@/components/Workspace'
import { formatCodeGenProgress, formatDuration } from '@/lib/formatCodeGenProgress'
import { formatRecentDate } from '@/lib/formatRecentDate'
import { playSoundCueIfEnabled } from '@/lib/soundDesign'
import type { ImageAttachment } from '@/lib/imageAttachment'
import type { CodeGenProgress, GeneratedApp, GeneratedAppSummary } from '../../shared/ipc'
import ModelEffortPicker from './ModelEffortPicker'
import GithubPicker from './GithubPicker'
import BranchPicker from './BranchPicker'
import RepoChanges from './RepoChanges'
import { ipcErrorMessage } from '@/lib/ipcError'
import { readSaved, writeSaved } from '@/lib/savedSetting'
import { CHAT_MIN_WIDTH, clampChatWidth } from '@/lib/splitWidth'
import { useScreenActive } from '@/lib/shellContext'
import type { RepoView } from '../../shared/ipc'

type View = 'preview' | 'code'

/** Largeur de la conversation choisie à la poignée (étape 283), retenue d'une ouverture à l'autre. */
const CHAT_WIDTH_KEY = 'jaris.codeChatWidth'
/** Pas d'une flèche du clavier sur la poignée. */
const CHAT_WIDTH_STEP = 24

/** Un message de la conversation du mode Code (étape 282) : une demande de Léo, ou ce que Jaris a fait. */
interface ChatTurn {
  id: number
  kind: 'user' | 'reply'
  text: string
}

type Outcome = { kind: 'done' | 'stopped'; durationMs: number; text?: string }

/** Le texte du bandeau de fin, réutilisé tel quel quand ce bandeau rejoint l'historique de la conversation. */
function outcomeText(outcome: Outcome): string {
  if (outcome.kind === 'stopped') return `Génération arrêtée après ${formatDuration(outcome.durationMs)}.`
  return `Terminé en ${formatDuration(outcome.durationMs)} — ${outcome.text ?? 'ton application est à jour.'}`
}

/**
 * Coche du bandeau de fin (étape 100). Définie ici et pas dans icons.tsx : la règle du projet est d'extraire
 * une icône au DEUXIÈME usage, pas avant — elle n'est utilisée qu'à cet endroit.
 */
function CheckIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 12.5l5.2 5.2L20 7" />
    </svg>
  )
}

/** Icônes de la barre de l'aperçu (étape 284), propres à cet endroit comme CheckIcon. */
function FolderIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2.2h7.4A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5Z" />
    </svg>
  )
}

/** Deux flèches vers les coins : agrandir. */
function ExpandIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7" />
    </svg>
  )
}

/** Deux flèches vers le centre : réduire. */
function CollapseIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 10h-6V4M14 10l7-7M4 14h6v6M10 14l-7 7" />
    </svg>
  )
}

/**
 * Mode Code (étape 30) : décrire une application en français et la voir tourner, générée à 100% en local.
 * Une fois une première version obtenue, les demandes suivantes sont traitées comme des modifications du
 * fichier en cours (contexte ciblé : seul ce fichier est renvoyé au modèle, pas tout l'historique).
 */
export default function CodePanel(): JSX.Element {
  const [description, setDescription] = useState('')
  const [generating, setGenerating] = useState(false)
  const [statusLines, setStatusLines] = useState<string[]>([])
  const [appResult, setAppResult] = useState<GeneratedApp | null>(null)
  const [view, setView] = useState<View>('preview')
  const [error, setError] = useState<string | null>(null)
  const [recentApps, setRecentApps] = useState<GeneratedAppSummary[]>([])
  const [attachment, setAttachment] = useState<ImageAttachment | null>(null)
  /** Avancement en direct de l'étape en cours (étape 99) — `null` avant le premier appel au modèle. */
  const [progress, setProgress] = useState<CodeGenProgress | null>(null)
  /** Temps écoulé depuis le clic, réaffiché chaque seconde : "ça tourne depuis 2 min" est la première
   *  chose que Léo cherchait des yeux ("on ne sait pas quand c'est terminé"). */
  const [elapsedMs, setElapsedMs] = useState(0)
  /** Issue de la DERNIÈRE génération, affichée à la place du bandeau d'avancement une fois celui-ci fini :
   *  terminée normalement, ou arrêtée à la demande. `null` tant qu'il n'y a rien à annoncer. */
  const [lastOutcome, setLastOutcome] = useState<Outcome | null>(null)
  /** Étape 277 : dépôt GitHub ouvert (choisi dans le bouton GitHub du champ). Remplace l'application générée. */
  const [repo, setRepo] = useState<RepoView | null>(null)
  /**
   * Étape 282 (Léo : « pour le code fais chat à gauche et aperçu à droite comme Claude et ChatGPT ») : la
   * conversation de l'élément ouvert — ses demandes, et ce que Jaris a fait. Gardée en mémoire seulement : elle
   * repart de zéro quand on ouvre un autre élément, comme le bandeau de fin (étape 102).
   */
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const turnIdRef = useRef(0)
  const threadRef = useRef<HTMLDivElement>(null)
  /**
   * Étape 283 (Léo : « pouvoir régler la taille de l'aperçu ») : largeur de la conversation, en pixels, choisie en
   * faisant glisser la séparation ; `null` = largeur d'origine (celle du CSS).
   */
  const [chatWidth, setChatWidth] = useState<number | null>(() => {
    const saved = Number(readSaved(CHAT_WIDTH_KEY))
    return saved >= CHAT_MIN_WIDTH ? saved : null
  })
  const [resizing, setResizing] = useState(false)
  /**
   * Étape 284 (Léo : « pouvoir mettre en grand l'aperçu ») : la conversation se replie et l'aperçu prend toute la
   * largeur, comme le bouton « Agrandir » des aperçus de Claude. Échap ou le même bouton le ramène à sa taille.
   */
  const [previewExpanded, setPreviewExpanded] = useState(false)
  const screenActive = useScreenActive()
  const splitRef = useRef<HTMLDivElement>(null)
  const chatRef = useRef<HTMLElement>(null)
  const [committed, setCommitted] = useState<{ url: string; sha: string } | null>(null)
  /** Description proposée pour l'enregistrement : la dernière demande faite sur le dépôt. */
  const [commitMessage, setCommitMessage] = useState('')
  /** Enregistrement sur GitHub en cours (quelques secondes, sans bandeau d'avancement ni bouton Arrêter). */
  const [committing, setCommitting] = useState(false)
  const statusRef = useRef<HTMLPreElement>(null)
  /** Mis à true par le bouton "Arrêter" : l'échec qui suit est alors un arrêt voulu, pas une panne. */
  const stoppedRef = useRef(false)

  // Repéré par Léo en usage réel ("si on relance jarvis, on a plus rien dans le code") : chaque génération
  // est bien enregistrée sur le disque (generated-apps/<horodatage>-<slug>/), mais rien ne remontrait cette
  // liste après un redémarrage — l'écran de départ repartait toujours à zéro même si le fichier existait
  // toujours. Chargée une fois au montage ; regénérée après chaque génération réussie (voir refreshRecentApps).
  useEffect(() => {
    void window.jaris.getGeneratedApps().then(setRecentApps)
  }, [])

  useEffect(() => {
    return window.jaris.onCodeGenStatus((message) => setStatusLines((prev) => [...prev, message]))
  }, [])

  useEffect(() => {
    return window.jaris.onCodeGenProgress(setProgress)
  }, [])

  // Chronomètre de la génération en cours. Une seconde suffit : ce n'est pas une mesure, c'est un signe que
  // Jaris est toujours vivant — et il s'arrête net dès que la génération est finie.
  useEffect(() => {
    if (!generating) return
    const startedAt = Date.now()
    setElapsedMs(0)
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAt), 1000)
    return () => clearInterval(timer)
  }, [generating])

  useEffect(() => {
    statusRef.current?.scrollTo({ top: statusRef.current.scrollHeight })
  }, [statusLines])

  // Le dernier message reste visible, comme dans le Chat.
  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight })
  }, [turns, generating, lastOutcome, statusLines, error])

  const addTurn = (kind: ChatTurn['kind'], text: string): void => {
    turnIdRef.current += 1
    const id = turnIdRef.current
    setTurns((prev) => [...prev, { id, kind, text }])
  }

  /** Une nouvelle demande commence : le bandeau de la précédente rejoint l'historique au lieu de disparaître. */
  const archiveLastOutcome = (): void => {
    if (lastOutcome) addTurn('reply', outcomeText(lastOutcome))
  }

  /**
   * Le bandeau de fin, le journal et l'erreur décrivent UNE génération précise, celle de l'application
   * affichée. Dès qu'on affiche autre chose, ils ne parlent plus de ce qui est à l'écran — Léo a vu
   * "Terminé en 7 min 56 — ton application est à jour" rester au-dessus d'une AUTRE application, qu'il
   * venait simplement d'ouvrir dans la colonne de gauche (étape 102).
   *
   * Regroupé dans une seule fonction appelée par TOUS les chemins qui changent l'application affichée :
   * trois `setXxx(null)` recopiés à la main dans chaque chemin, c'est exactement ce qui vient d'être
   * oublié une fois.
   */
  const clearGenerationFeedback = (): void => {
    setStatusLines([])
    setLastOutcome(null)
    setError(null)
  }

  /** Changer d'élément affiché (application, dépôt, nouvelle application) : la conversation repart de zéro. */
  const resetConversation = (): void => {
    setTurns([])
    clearGenerationFeedback()
  }

  /** Étape 277 : la demande part à l'agent qui travaille sur le dépôt ouvert, pas au générateur d'application. */
  const runOnRepo = async (current: RepoView, prompt: string): Promise<void> => {
    archiveLastOutcome()
    addTurn('user', prompt)
    // Vidé dès l'envoi, comme ChatGPT : la demande est désormais dans la conversation, pas en double dans le champ.
    setDescription('')
    clearGenerationFeedback()
    setCommitted(null)
    setGenerating(true)
    setProgress(null)
    stoppedRef.current = false
    const startedAt = Date.now()
    try {
      const result = await window.jaris.githubRunAgent(current.fullName, prompt)
      setRepo(result.view)
      addTurn('reply', result.summary)
      if (result.view.changes.length > 0) setCommitMessage(prompt.split('\n')[0].slice(0, 72))
      const count = result.view.changes.length
      setLastOutcome({
        kind: 'done',
        durationMs: Date.now() - startedAt,
        // Le compte vient des changements RÉELLEMENT préparés, jamais de ce que le modèle dit avoir fait : vu avec
        // un vrai modèle, le résumé peut annoncer un changement qui n'a pas eu lieu.
        text:
          count === 0
            ? "aucun fichier n'a été changé."
            : `${count === 1 ? '1 fichier à vérifier' : `${count} fichiers à vérifier`}, puis à enregistrer sur GitHub.`
      })
      void playSoundCueIfEnabled('success')
    } catch (err) {
      if (stoppedRef.current) {
        setLastOutcome({ kind: 'stopped', durationMs: Date.now() - startedAt })
        // Ce qui a été préparé avant l'arrêt reste affiché (et annulable) : rien n'est perdu ni enregistré.
        void window.jaris.githubOpenRepo(current.fullName).then(setRepo).catch(() => {})
      } else {
        setError(ipcErrorMessage(err))
        void playSoundCueIfEnabled('error')
      }
    } finally {
      setGenerating(false)
      setProgress(null)
    }
  }

  const openRepo = async (fullName: string, branch?: string, keepConversation = false): Promise<void> => {
    const view = await window.jaris.githubOpenRepo(fullName, branch)
    setAppResult(null)
    if (keepConversation) clearGenerationFeedback()
    else resetConversation()
    setCommitted(null)
    setAttachment(null)
    setRepo(view)
  }

  const closeRepo = (): void => {
    setRepo(null)
    setCommitted(null)
    resetConversation()
  }

  const commitRepo = async (message: string): Promise<void> => {
    if (!repo) return
    setError(null)
    setCommitting(true)
    try {
      const result = await window.jaris.githubCommit(repo.fullName, message)
      setRepo(result.view)
      setCommitted({ url: result.url, sha: result.sha })
      archiveLastOutcome()
      setLastOutcome(null)
      addTurn('reply', `Enregistré sur GitHub (${result.sha.slice(0, 7)}).`)
      void playSoundCueIfEnabled('success')
    } catch (err) {
      setError(ipcErrorMessage(err))
      void playSoundCueIfEnabled('error')
    } finally {
      setCommitting(false)
    }
  }

  const discardRepo = async (path?: string): Promise<void> => {
    if (!repo) return
    setError(null)
    try {
      setRepo(await window.jaris.githubDiscardChanges(repo.fullName, path))
    } catch (err) {
      setError(ipcErrorMessage(err))
    }
  }

  const changeBranch = async (branch: string): Promise<void> => {
    if (!repo) return
    try {
      // La conversation continue : seule la branche change.
      await openRepo(repo.fullName, branch, true)
      addTurn('reply', `Branche ${branch}.`)
    } catch (err) {
      setError(ipcErrorMessage(err))
    }
  }

  const generate = async (): Promise<void> => {
    const prompt = description.trim()
    if (repo) {
      if (prompt && !generating) await runOnRepo(repo, prompt)
      return
    }
    // Une image seule suffit ("reproduis cette maquette") : le texte n'est plus obligatoire s'il y a une image.
    if ((!prompt && !attachment) || generating) return

    archiveLastOutcome()
    addTurn('user', prompt || 'Reproduis l’image jointe.')
    setDescription('')
    clearGenerationFeedback()
    setGenerating(true)
    setProgress(null)
    stoppedRef.current = false
    const startedAt = Date.now()
    try {
      // appResult présent = demande de modification : le fichier actuel part avec la demande.
      const result = await window.jaris.generateApp(
        prompt || 'Reproduis fidèlement l\'interface de l\'image jointe.',
        appResult?.html,
        attachment?.base64
      )
      setAppResult(result)
      setAttachment(null)
      setView('preview')
      // Fin annoncée de deux façons : le bandeau reste affiché avec la durée, et un bip si les sons sont
      // activés — une génération peut durer plusieurs minutes, pendant lesquelles Léo fait autre chose.
      setLastOutcome({ kind: 'done', durationMs: Date.now() - startedAt })
      void playSoundCueIfEnabled('success')
      void window.jaris.getGeneratedApps().then(setRecentApps)
    } catch (err) {
      // Un arrêt demandé n'est pas une panne : il s'affiche dans le bandeau, au même endroit que
      // l'avancement qu'il interrompt, jamais en rouge.
      if (stoppedRef.current) {
        setLastOutcome({ kind: 'stopped', durationMs: Date.now() - startedAt })
      } else {
        setError(err instanceof Error ? err.message : String(err))
        void playSoundCueIfEnabled('error')
      }
    } finally {
      setGenerating(false)
      setProgress(null)
    }
  }

  /** Arrête la génération en cours (étape 99) : sans ce bouton, une génération partie ne pouvait plus être
   *  interrompue autrement qu'en fermant Jaris. */
  const stop = (): void => {
    stoppedRef.current = true
    window.jaris.cancelCodeGen()
  }

  const openRecent = async (path: string): Promise<void> => {
    closeRepo()
    try {
      const result = await window.jaris.loadGeneratedApp(path)
      setAppResult(result)
      setView('preview')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * Supprime définitivement le dossier de l'application (étape 95). Le chemin est revérifié côté main
   * (deleteGeneratedApp, codeGenerator.ts) : un effacement récursif ne se fait jamais sur la seule parole
   * du renderer.
   */
  const remove = async (path: string): Promise<void> => {
    setError(null)
    try {
      await window.jaris.deleteGeneratedApp(path)
      setRecentApps(await window.jaris.getGeneratedApps())
      // L'application supprimée était justement celle affichée : l'aperçu pointerait sur un dossier qui
      // n'existe plus, donc retour à l'écran de départ.
      if (appResult?.path === path) startOver()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const startOver = (): void => {
    closeRepo()
    setAppResult(null)
    clearGenerationFeedback()
    setDescription('')
    setAttachment(null)
  }

  /** Quelque chose à montrer dans l'aperçu : une application, ou les changements d'un dépôt. */
  const hasPreview = appResult !== null || (repo !== null && (repo.changes.length > 0 || committed !== null))
  /** Le nom affiché dans la barre de la carte : celui de la liste de gauche, pour qu'on reconnaisse l'élément ouvert. */
  const previewTitle = appResult
    ? (recentApps.find((recent) => recent.path === appResult.path)?.label ?? 'Ton application')
    : repo
      ? repo.fullName
      : 'Aperçu'

  // Plus rien à montrer (nouvelle application, application supprimée, dépôt refermé) : l'aperçu agrandi se referme,
  // sinon la conversation resterait repliée devant une carte vide, sans bouton pour la faire revenir.
  useEffect(() => {
    if (!hasPreview) setPreviewExpanded(false)
  }, [hasPreview])

  // Échap ramène l'aperçu à sa taille. Un jeu qui a le clavier garde ses touches : l'iframe ne les transmet pas ici.
  useEffect(() => {
    if (!previewExpanded || !screenActive) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setPreviewExpanded(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [previewExpanded, screenActive])

  /** La largeur que donnerait la poignée à cette position du pointeur, bornée pour ne jamais écraser une colonne. */
  const widthAt = (clientX: number): number | null => {
    const split = splitRef.current?.getBoundingClientRect()
    return split ? clampChatWidth(clientX - split.left, split.width) : null
  }

  const saveChatWidth = (width: number | null): void => {
    setChatWidth(width)
    writeSaved(CHAT_WIDTH_KEY, width === null ? null : String(width))
  }

  const onHandleKey = (event: React.KeyboardEvent): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const current = chatRef.current?.getBoundingClientRect().width ?? CHAT_MIN_WIDTH
    const split = splitRef.current?.getBoundingClientRect().width ?? current
    saveChatWidth(clampChatWidth(current + (event.key === 'ArrowRight' ? CHAT_WIDTH_STEP : -CHAT_WIDTH_STEP), split))
  }

  return (
    <Workspace
      newLabel="Nouvelle application"
      label="Code"
      onNew={startOver}
      items={recentApps.map((recent) => ({
        id: recent.path,
        title: recent.label,
        meta: formatRecentDate(recent.timestamp)
      }))}
      activeId={appResult?.path ?? null}
      onSelect={(path) => void openRecent(path)}
      onDelete={(path) => void remove(path)}
      emptyLabel="Aucune application pour l'instant."
    >
      {/* Étape 282 (Léo, capture de Claude à l'appui : « pour le code fais chat à gauche et aperçu à droite comme
          Claude et ChatGPT ») : la conversation et le champ de saisie à gauche, l'aperçu (ou les changements d'un
          dépôt GitHub) à droite. Fenêtre étroite : l'aperçu passe au-dessus de la conversation (index.css). */}
      <div className="code-panel">
        <div
          ref={splitRef}
          className={`code-split${resizing ? ' code-split--resizing' : ''}${previewExpanded ? ' code-split--expanded' : ''}`}
          style={chatWidth === null ? undefined : ({ '--code-chat-width': `${chatWidth}px` } as CSSProperties)}
        >
          <section ref={chatRef} className="code-chat" aria-label="Conversation">
            <div className="code-chat__thread" ref={threadRef}>
              {turns.length === 0 && !generating && (
                <EmptyState
                  title={
                    repo
                      ? repo.fileCount === 0
                        ? 'Ce dépôt est encore vide'
                        : 'Que doit faire Jaris dans ce dépôt\u00a0?'
                      : appResult
                        ? 'Que veux-tu changer\u00a0?'
                        : 'Quelle application veux-tu créer\u00a0?'
                  }
                  description={
                    repo
                      ? repo.fileCount === 0
                        ? "Décris ce que Jaris doit y créer. Tu verras chaque fichier avant de l'enregistrer sur GitHub — rien n'est envoyé avant."
                        : "Il lit les fichiers dont il a besoin et prépare les changements. Tu les vois ligne par ligne, puis tu choisis de les enregistrer sur GitHub — rien n'est envoyé avant."
                      : appResult
                        ? "Décris une modification : Jaris la fait sur ta machine et l'aperçu se met à jour."
                        : "Décris-la simplement : Jaris l'écrit entièrement sur ta machine, puis la lance dans l'aperçu. Tu peux aussi joindre une capture ou une maquette à reproduire."
                  }
                  suggestions={
                    repo
                      ? repo.fileCount === 0
                        ? ['Crée un petit site web de présentation', 'Crée un fichier qui présente le projet', 'Ajoute un fichier .gitignore adapté']
                        : ['Explique ce que fait ce dépôt', "Corrige les fautes d'orthographe", 'Ajoute un fichier .gitignore adapté']
                      : appResult
                        ? ['Ajoute un mode sombre', 'Rends-la plus jolie', 'Ajoute un bouton pour tout effacer']
                        : ['Un minuteur Pomodoro', 'Une liste de courses', 'Un convertisseur de devises']
                  }
                  onSuggestion={setDescription}
                />
              )}

              {turns.map((turn) =>
                turn.kind === 'user' ? (
                  <div key={turn.id} className="code-chat__user">
                    {turn.text}
                  </div>
                ) : (
                  <p key={turn.id} className="code-chat__reply">
                    {turn.text}
                  </p>
                )
              )}

              {appResult && appResult.issues.length > 0 && (
                <div className="code-panel__issues">
                  <strong>
                    L'application a été générée mais {appResult.issues.length === 1 ? "un problème n'a pas pu être corrigé" : `${appResult.issues.length} problèmes n'ont pas pu être corrigés`} :
                  </strong>
                  <ul>
                    {appResult.issues.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                  Relance la génération, ou reformule ta demande en plus simple.
                </div>
              )}

              {/* Étape 99 : où on en est (étape X), la preuve que ça avance (les caractères écrits), depuis combien
                  de temps, et une sortie de secours — à la suite de la demande, comme une réponse en cours. */}
              {generating && (
                <div className="code-panel__live">
                  <div className="code-panel__live-text">
                    <span className="code-panel__live-title">{formatCodeGenProgress(progress, elapsedMs).title}</span>
                    <span className="code-panel__live-detail">{formatCodeGenProgress(progress, elapsedMs).detail}</span>
                  </div>
                  <button className="code-panel__live-stop" onClick={stop}>
                    Arrêter
                  </button>
                </div>
              )}

              {/* Fin annoncée À L'ENDROIT MÊME où l'avancement était suivi (étape 100). À la demande suivante, ce
                  bandeau rejoint l'historique de la conversation (archiveLastOutcome). */}
              {!generating && lastOutcome !== null && (
                <p className={`code-panel__done${lastOutcome.kind === 'stopped' ? ' code-panel__done--stopped' : ''}`}>
                  {lastOutcome.kind === 'done' && <CheckIcon />}
                  <span>{outcomeText(lastOutcome)}</span>
                </p>
              )}

              {/* Journal réservé à ce que le bandeau ne dit PAS (étape 101). */}
              {statusLines.length > 0 && (
                <pre ref={statusRef} className="code-panel__status">
                  {statusLines.join('\n')}
                </pre>
              )}

              {error && <p className="code-panel__error">{error}</p>}
            </div>

            <Composer
              value={description}
              onChange={setDescription}
              onSubmit={() => void generate()}
              placeholder={
                repo
                  ? `Que veux-tu changer dans ${repo.fullName} ?`
                  : appResult
                    ? 'Que veux-tu changer ? (ex: ajoute un mode sombre…)'
                    : "Décris l'application à créer…"
              }
              submitLabel={repo ? 'Envoyer' : appResult ? 'Modifier' : "Générer l'application"}
              busyLabel={repo ? 'Jaris travaille…' : 'Génération…'}
              busy={generating}
              onStop={stop}
              extraActions={
                <>
                  <GithubPicker repo={repo} onOpenRepo={(fullName) => openRepo(fullName)} onCloseRepo={closeRepo} disabled={generating || committing} />
                  {repo && <BranchPicker repo={repo} onChange={changeBranch} disabled={generating || committing} />}
                  <ModelEffortPicker mode="code" disabled={generating} />
                </>
              }
              imagesAllowed={!repo}
              attachment={attachment}
              onAttachmentChange={setAttachment}
              onError={setError}
              rows={3}
            />
          </section>

          {/* La poignée entre les deux colonnes : glisser pour régler la taille de l'aperçu, double-clic pour revenir à
              la taille d'origine, flèches du clavier une fois sélectionnée. La capture du pointeur garde le glissement
              même quand la souris passe au-dessus de l'aperçu (une iframe avalerait sinon les mouvements). */}
          <div
            className="code-split__handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Taille de l'aperçu"
            aria-valuemin={CHAT_MIN_WIDTH}
            aria-valuenow={chatWidth ?? undefined}
            tabIndex={0}
            title="Glisser pour régler la taille de l'aperçu · double-clic : taille d'origine"
            onPointerDown={(event) => {
              event.preventDefault()
              event.currentTarget.setPointerCapture(event.pointerId)
              setResizing(true)
            }}
            onPointerMove={(event) => {
              if (!resizing) return
              const width = widthAt(event.clientX)
              if (width !== null) setChatWidth(width)
            }}
            onPointerUp={(event) => {
              if (!resizing) return
              setResizing(false)
              event.currentTarget.releasePointerCapture(event.pointerId)
              saveChatWidth(widthAt(event.clientX))
            }}
            onPointerCancel={() => setResizing(false)}
            onDoubleClick={() => saveChatWidth(null)}
            onKeyDown={onHandleKey}
          />

          <section className={`code-preview${hasPreview ? '' : ' code-preview--empty'}`} aria-label="Aperçu">
            {/* Étape 284 (Léo, capture de Claude à l'appui : « fais exactement comme ça avec un contour et pouvoir mettre
                en grand l'aperçu ») : l'aperçu est une CARTE encadrée, avec sa propre barre de titre — le nom de ce qui est
                affiché à gauche, les commandes à droite —, comme les aperçus de Claude. */}
            <div className="code-preview__card">
              <div className="code-preview__head">
                <span className={`code-preview__title${appResult ? ' code-preview__title--app' : ''}`} title={previewTitle}>
                  {previewTitle}
                </span>
                {repo && !appResult && <span className="code-preview__meta">{repo.branch}</span>}
                {/* Aperçu agrandi : la conversation est repliée, donc son bandeau d'avancement aussi. Sans ce rappel,
                    une génération en cours serait invisible jusqu'à la fin. */}
                {generating && previewExpanded && (
                  <span className="code-preview__busy">{formatCodeGenProgress(progress, elapsedMs).title}</span>
                )}
                <div className="code-preview__tools">
                  {appResult && (
                    <div className="code-panel__view-tabs">
                      <button
                        className={`code-panel__view-tab${view === 'preview' ? ' code-panel__view-tab--active' : ''}`}
                        onClick={() => setView('preview')}
                      >
                        Aperçu
                      </button>
                      <button
                        className={`code-panel__view-tab${view === 'code' ? ' code-panel__view-tab--active' : ''}`}
                        onClick={() => setView('code')}
                      >
                        Code
                      </button>
                    </div>
                  )}
                  {appResult && !generating && (
                    <button
                      className="panel__icon-button code-preview__folder"
                      onClick={() => void window.jaris.openGeneratedApp(appResult.path)}
                      title={`Ouvrir le dossier (${appResult.path})`}
                      aria-label="Ouvrir le dossier"
                    >
                      <FolderIcon />
                    </button>
                  )}
                  {hasPreview && (
                    <button
                      className="panel__icon-button code-preview__expand"
                      onClick={() => setPreviewExpanded(!previewExpanded)}
                      title={previewExpanded ? "Réduire l'aperçu (Échap)" : "Agrandir l'aperçu"}
                      aria-label={previewExpanded ? "Réduire l'aperçu" : "Agrandir l'aperçu"}
                      aria-pressed={previewExpanded}
                    >
                      {previewExpanded ? <CollapseIcon /> : <ExpandIcon />}
                    </button>
                  )}
                </div>
              </div>

              <div className="code-preview__body">
                {appResult ? (
                  view === 'preview' ? (
                    // sandbox sans allow-same-origin : le code généré tourne dans une origine opaque, sans accès à Jaris
                    // ni aux fichiers locaux (localStorage y est donc bloqué, d'où le try/catch imposé à la génération).
                    // allow-forms (étape 232) : sans lui, un formulaire généré ne réagit jamais au clic ; l'envoi réel
                    // reste bloqué par la règle form-action 'none' de l'aperçu (generatedAppPreview.ts).
                    <iframe className="code-panel__preview" title="Aperçu de l'application" sandbox="allow-scripts allow-forms" src={appResult.previewUrl} />
                  ) : (
                    <pre className="code-panel__code">{appResult.html}</pre>
                  )
                ) : repo && (repo.changes.length > 0 || committed) ? (
                  <RepoChanges
                    repo={repo}
                    busy={generating || committing}
                    committed={committed}
                    defaultMessage={commitMessage}
                    onCommit={commitRepo}
                    onDiscard={discardRepo}
                  />
                ) : (
                  <div className="code-preview__placeholder">
                    <svg viewBox="0 0 64 48" width="96" height="72" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect x="2" y="2" width="60" height="44" rx="6" />
                      <path d="M2 12h60" />
                      <circle cx="8" cy="7" r="1.2" />
                      <circle cx="13" cy="7" r="1.2" />
                      <path d="M24 24l-6 5 6 5M40 24l6 5-6 5M35 21l-6 16" />
                    </svg>
                    <p>
                      {repo
                        ? "Les changements préparés par Jaris s'afficheront ici, ligne par ligne, avant d'être enregistrés sur GitHub."
                        : "L'aperçu de ton application s'affichera ici."}
                    </p>
                  </div>
                )}
              </div>

              {appResult && view === 'preview' && (
                <p className="code-preview__foot">
                  Aperçu isolé : la sauvegarde de données (localStorage) n'y marche pas, mais fonctionne en ouvrant le fichier
                  depuis le dossier.
                </p>
              )}
            </div>
          </section>
        </div>
      </div>
    </Workspace>
  )
}
