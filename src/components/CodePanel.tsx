import { useEffect, useRef, useState, type CSSProperties } from 'react'
import Composer from '@/components/Composer'
import EmptyState from '@/components/EmptyState'
import Workspace from '@/components/Workspace'
import { formatCodeLive, formatDuration } from '@/lib/formatCodeGenProgress'
import { formatRecentDate } from '@/lib/formatRecentDate'
import { playSoundCueIfEnabled } from '@/lib/soundDesign'
import type { ImageAttachment } from '@/lib/imageAttachment'
import type { CodeActivity, CodeGenProgress, CodeLiveWrite, CodeNarration, GeneratedApp, GeneratedAppSummary } from '../../shared/ipc'
import ModelEffortPicker from './ModelEffortPicker'
import GithubPicker from './GithubPicker'
import BranchPicker from './BranchPicker'
import RepoChanges from './RepoChanges'
import { ipcErrorMessage } from '@/lib/ipcError'
import { readSaved, writeSaved } from '@/lib/savedSetting'
import { CHAT_MIN_WIDTH, clampChatWidth } from '@/lib/splitWidth'
import { useScreenActive } from '@/lib/shellContext'
import {
  appConversationKey,
  forgetConversation,
  forgetRepo,
  loadConversation,
  loadRecentRepos,
  rememberRepo,
  repoConversationKey,
  saveConversation,
  type ChatTurn,
  type RecentRepo
} from '@/lib/codeConversations'
import type { RepoPreview, RepoView } from '../../shared/ipc'

type View = 'preview' | 'code'

/** Largeur de la conversation choisie à la poignée (étape 283), retenue d'une ouverture à l'autre. */
const CHAT_WIDTH_KEY = 'jaris.codeChatWidth'
/** Pas d'une flèche du clavier sur la poignée. */
const CHAT_WIDTH_STEP = 24

/**
 * Un message de la conversation du mode Code (étape 282) : une demande de Léo, ce que Jaris a répondu, une remarque
 * (téléchargement du modèle, réparation…), ou une action sur un fichier (étape 286 : « Modifié index.html +500 −3 »).
 */

/** Le verbe de chaque action, au passé : ce qui VIENT d'être fait, comme les étapes affichées par Claude. */
const ACTIVITY_VERB: Record<CodeActivity['kind'], string> = {
  read: 'Lu',
  edit: 'Modifié',
  create: 'Créé',
  rewrite: 'Réécrit',
  delete: 'Supprimé'
}

/** « 500 lignes ajoutées, 3 retirées » : l'explication en toutes lettres, au survol de « +500 −3 ». */
function statsLabel(added: number, removed: number): string {
  const lines = (count: number): string => (count === 1 ? '1 ligne' : `${count} lignes`)
  if (removed === 0) return `${lines(added)} ${added === 1 ? 'ajoutée' : 'ajoutées'}`
  if (added === 0) return `${lines(removed)} ${removed === 1 ? 'retirée' : 'retirées'}`
  return `${lines(added)} ${added === 1 ? 'ajoutée' : 'ajoutées'}, ${removed} ${removed === 1 ? 'retirée' : 'retirées'}`
}

/**
 * Une action de Jaris sur un fichier, en une ligne discrète de la conversation (étape 286). Des lectures qui se
 * suivent tiennent sur UNE ligne — « Lu 3 fichiers » —, comme les étapes que Claude regroupe entre deux phrases.
 */
function ActivityRow({ activity, readPaths }: { activity: CodeActivity; readPaths?: string[] }): JSX.Element {
  const added = activity.added ?? 0
  const removed = activity.removed ?? 0
  if (readPaths && readPaths.length > 1) {
    return (
      <div className="code-chat__activity code-chat__activity--read">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Zm0 0v5h5M9 13h6M9 17h4" />
        </svg>
        <span className="code-chat__activity-verb">Lu {readPaths.length} fichiers</span>
        <span className="code-chat__activity-path" title={readPaths.join('\n')}>
          {readPaths.join(', ')}
        </span>
      </div>
    )
  }
  return (
    <div className={`code-chat__activity code-chat__activity--${activity.kind}`}>
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {activity.kind === 'read' ? (
          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Zm0 0v5h5M9 13h6M9 17h4" />
        ) : activity.kind === 'delete' ? (
          <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
        ) : (
          <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
        )}
      </svg>
      <span className="code-chat__activity-verb">{ACTIVITY_VERB[activity.kind]}</span>
      <span className="code-chat__activity-path" title={activity.path}>
        {activity.path}
      </span>
      {(added > 0 || removed > 0) && (
        <span className="code-chat__activity-stats" title={statsLabel(added, removed)}>
          {added > 0 && <span className="repo-change__added">+{added}</span>}
          {removed > 0 && <span className="repo-change__removed">−{removed}</span>}
        </span>
      )}
    </div>
  )
}

/** La ligne « en direct » (étape 288) : même allure qu'une action terminée, avec un point qui pulse. */
function LiveLine({ text }: { text: ReturnType<typeof formatCodeLive> }): JSX.Element {
  return (
    <div className="code-chat__live code-chat__activity" role="status" aria-live="polite">
      <span className="code-chat__live-dot" aria-hidden="true" />
      <span className="code-chat__activity-verb">{text.action}</span>
      {text.path && (
        <span className="code-chat__activity-path" title={text.path}>
          {text.path}
        </span>
      )}
      {text.lines && <span className="code-chat__activity-stats repo-change__added">{text.lines}</span>}
      {text.stall && <span className="code-chat__live-stall">· {text.stall}</span>}
    </div>
  )
}

/** La même chose en une phrase, pour la barre de l'aperçu agrandi (la conversation est alors repliée). */
const liveSummary = (text: ReturnType<typeof formatCodeLive>): string => [text.action, text.path, text.lines].filter(Boolean).join(' ')

/**
 * Ce qui s'affiche dans la conversation : les tours tels quels, sauf les lectures consécutives, réunies en une ligne
 * (le même fichier relu n'y figure qu'une fois).
 */
type ThreadItem = { turn: ChatTurn; readPaths?: string[] }

function threadItems(turns: ChatTurn[]): ThreadItem[] {
  const items: ThreadItem[] = []
  for (const turn of turns) {
    const previous = items[items.length - 1]
    if (turn.kind === 'activity' && turn.activity.kind === 'read' && previous?.readPaths) {
      if (!previous.readPaths.includes(turn.activity.path)) previous.readPaths.push(turn.activity.path)
      continue
    }
    items.push(turn.kind === 'activity' && turn.activity.kind === 'read' ? { turn, readPaths: [turn.activity.path] } : { turn })
  }
  return items
}

/** « Téléchargement de … 42 % » sans son pourcentage : deux avancements du même téléchargement se remplacent. */
const progressKey = (text: string): string => text.replace(/\s*\d+\s*%\s*$/, '')

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
  const [appResult, setAppResult] = useState<GeneratedApp | null>(null)
  const [view, setView] = useState<View>('preview')
  const [error, setError] = useState<string | null>(null)
  const [recentApps, setRecentApps] = useState<GeneratedAppSummary[]>([])
  const [attachment, setAttachment] = useState<ImageAttachment | null>(null)
  /** Avancement en direct de l'étape en cours (étape 99) — `null` avant le premier appel au modèle. */
  const [progress, setProgress] = useState<CodeGenProgress | null>(null)
  /** Étape 288 : le fichier que Jaris écrit en ce moment, ligne par ligne (`null` : il n'écrit pas de fichier). */
  const [live, setLive] = useState<CodeLiveWrite | null>(null)
  /** Issue de la DERNIÈRE génération, affichée à la place du bandeau d'avancement une fois celui-ci fini :
   *  terminée normalement, ou arrêtée à la demande. `null` tant qu'il n'y a rien à annoncer. */
  const [lastOutcome, setLastOutcome] = useState<Outcome | null>(null)
  /** Étape 277 : dépôt GitHub ouvert (choisi dans le bouton GitHub du champ). Remplace l'application générée. */
  const [repo, setRepo] = useState<RepoView | null>(null)
  /**
   * Étape 287 (Léo : « à droite faut pas que c'est le menu pour enregistrer sur GitHub, mais pouvoir jouer directement
   * et tester un vrai aperçu ») : le site du dépôt, jouable, changements préparés compris. Les changements et
   * « Enregistrer sur GitHub » passent dans un onglet à côté.
   */
  const [repoPreview, setRepoPreview] = useState<RepoPreview | null>(null)
  const [repoTab, setRepoTab] = useState<'preview' | 'changes'>('preview')
  const repoPreviewRequest = useRef(0)
  /**
   * Étape 282 (Léo : « pour le code fais chat à gauche et aperçu à droite comme Claude et ChatGPT ») : la
   * conversation de l'élément ouvert — ses demandes, et ce que Jaris a fait. Gardée en mémoire seulement : elle
   * repart de zéro quand on ouvre un autre élément, comme le bandeau de fin (étape 102).
   */
  const [turns, setTurns] = useState<ChatTurn[]>([])
  /**
   * Étape 288 : l'élément à qui appartient la conversation affichée (`app:…`, `repo:…`, ou `null` pour une
   * nouvelle application pas encore créée). Elle n'est enregistrée que sous CE nom : pendant un changement
   * d'élément, une conversation vide ne doit jamais écraser celle de l'élément qu'on quitte.
   */
  const conversationOwnerRef = useRef<string | null>(null)
  const [recentRepos, setRecentRepos] = useState<RecentRepo[]>(() => loadRecentRepos())
  const turnIdRef = useRef(0)
  /** Étape 286 : tour de l'agent -> message de la conversation qui porte sa phrase (mise à jour en direct). */
  const narrationTurnsRef = useRef(new Map<number, number>())
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
  /** Mis à true par le bouton "Arrêter" : l'échec qui suit est alors un arrêt voulu, pas une panne. */
  const stoppedRef = useRef(false)

  // Repéré par Léo en usage réel ("si on relance jarvis, on a plus rien dans le code") : chaque génération
  // est bien enregistrée sur le disque (generated-apps/<horodatage>-<slug>/), mais rien ne remontrait cette
  // liste après un redémarrage — l'écran de départ repartait toujours à zéro même si le fichier existait
  // toujours. Chargée une fois au montage ; regénérée après chaque génération réussie (voir refreshRecentApps).
  useEffect(() => {
    void window.jaris.getGeneratedApps().then(setRecentApps)
  }, [])

  // Étape 286 (Léo : « enlève l'autre carré […] mets les trucs qu'il est en train de faire ») : plus de journal
  // dans un cadre à part. Ce que Jaris fait s'inscrit dans la conversation, à sa place dans le temps : une action
  // sur un fichier par ligne, et les rares remarques utiles (téléchargement du modèle, réparation) en texte discret.
  useEffect(() => {
    const offStatus = window.jaris.onCodeGenStatus(addNote)
    const offActivity = window.jaris.onCodeGenActivity((activity) => {
      turnIdRef.current += 1
      const id = turnIdRef.current
      setTurns((prev) => [...prev, { id, kind: 'activity', activity }])
    })
    const offNarration = window.jaris.onCodeGenNarration(showNarration)
    return () => {
      offStatus()
      offActivity()
      offNarration()
    }
  }, [])

  useEffect(() => {
    const offProgress = window.jaris.onCodeGenProgress(setProgress)
    const offLive = window.jaris.onCodeGenLive(setLive)
    return () => {
      offProgress()
      offLive()
    }
  }, [])

  // Rien ne s'écrit plus une fois le travail fini (ou arrêté) : la ligne en direct ne doit pas rester figée.
  useEffect(() => {
    if (!generating) setLive(null)
  }, [generating])

  // Le dernier message reste visible, comme dans le Chat.
  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight })
  }, [turns, generating, lastOutcome, error])

  function addTurn(kind: 'user' | 'reply' | 'note', text: string): void {
    turnIdRef.current += 1
    const id = turnIdRef.current
    setTurns((prev) => [...prev, { id, kind, text }])
  }

  /**
   * Étape 286 (Léo : « il peut pas parler comme toi, il dit ce qu'il fait ») : la phrase de l'agent s'écrit dans la
   * conversation pendant qu'il la tape, comme une réponse de Claude ; un texte vide la retire (sa réponse finale
   * arrive à part, comme résumé).
   */
  function showNarration({ id, text }: CodeNarration): void {
    const existing = narrationTurnsRef.current.get(id)
    if (!text) {
      if (existing === undefined) return
      narrationTurnsRef.current.delete(id)
      setTurns((prev) => prev.filter((turn) => turn.id !== existing))
      return
    }
    if (existing !== undefined) {
      setTurns((prev) => prev.map((turn) => (turn.id === existing && turn.kind === 'reply' ? { ...turn, text } : turn)))
      return
    }
    turnIdRef.current += 1
    const turnId = turnIdRef.current
    narrationTurnsRef.current.set(id, turnId)
    setTurns((prev) => [...prev, { id: turnId, kind: 'reply', text }])
  }

  /** Une remarque : l'avancement d'un même téléchargement remplace le précédent au lieu d'empiler 100 lignes. */
  function addNote(text: string): void {
    turnIdRef.current += 1
    const id = turnIdRef.current
    setTurns((prev) => {
      const last = prev[prev.length - 1]
      if (last?.kind === 'note' && last.text !== text && progressKey(last.text) === progressKey(text) && /%\s*$/.test(text)) {
        return [...prev.slice(0, -1), { ...last, text }]
      }
      return [...prev, { id, kind: 'note', text }]
    })
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
    setLastOutcome(null)
    setError(null)
  }

  /**
   * Changer d'élément affiché (application, dépôt, nouvelle application) : sa conversation revient telle qu'on l'a
   * laissée (étape 288) ; une nouvelle application repart de zéro.
   */
  const switchConversation = (key: string | null): void => {
    const loaded = key ? loadConversation(key) : []
    turnIdRef.current = Math.max(turnIdRef.current, ...loaded.map((turn) => turn.id))
    conversationOwnerRef.current = key
    narrationTurnsRef.current = new Map()
    setTurns(loaded)
    clearGenerationFeedback()
  }

  /** Étape 277 : la demande part à l'agent qui travaille sur le dépôt ouvert, pas au générateur d'application. */
  const runOnRepo = async (current: RepoView, prompt: string): Promise<void> => {
    archiveLastOutcome()
    addTurn('user', prompt)
    // Vidé dès l'envoi, comme ChatGPT : la demande est désormais dans la conversation, pas en double dans le champ.
    setDescription('')
    clearGenerationFeedback()
    // Les tours de l'agent repartent de 1 à chaque demande : leurs phrases sont de NOUVEAUX messages.
    narrationTurnsRef.current = new Map()
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
            : `${count === 1 ? '1 fichier changé' : `${count} fichiers changés`} : essaie dans l'aperçu, puis enregistre depuis « Changements ».`
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
      setRecentRepos(rememberRepo(current.fullName))
    }
  }

  const openRepo = async (fullName: string, branch?: string, keepConversation = false): Promise<void> => {
    const view = await window.jaris.githubOpenRepo(fullName, branch)
    setAppResult(null)
    if (keepConversation) clearGenerationFeedback()
    else switchConversation(repoConversationKey(view.fullName))
    setRecentRepos(rememberRepo(view.fullName))
    setCommitted(null)
    setAttachment(null)
    setRepoTab('preview')
    setRepo(view)
  }

  const closeRepo = (): void => {
    setRepo(null)
    setCommitted(null)
    switchConversation(null)
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
      // La conversation suit l'application jusqu'à sa nouvelle version (chaque génération crée son propre dossier).
      conversationOwnerRef.current = appConversationKey(result.path)
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
    // Pendant un travail, ses actions s'écrivent dans la conversation affichée : en changer maintenant les mettrait
    // dans celle d'un autre élément (étape 288). Même règle pour un dépôt et pour « Nouvelle application ».
    if (generating) return
    setRepo(null)
    setCommitted(null)
    try {
      const result = await window.jaris.loadGeneratedApp(path)
      switchConversation(appConversationKey(result.path))
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
      forgetConversation(appConversationKey(path))
      setRecentApps(await window.jaris.getGeneratedApps())
      // L'application supprimée était justement celle affichée : l'aperçu pointerait sur un dossier qui
      // n'existe plus, donc retour à l'écran de départ.
      if (appResult?.path === path) startOver()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const startOver = (): void => {
    if (generating) return
    closeRepo()
    setAppResult(null)
    setDescription('')
    setAttachment(null)
  }

  /** Étape 288 : un dépôt de la liste de gauche se rouvre avec sa conversation. */
  const openRepoFromList = async (fullName: string): Promise<void> => {
    if (generating) return
    try {
      await openRepo(fullName)
    } catch (err) {
      setError(ipcErrorMessage(err))
    }
  }

  /** Retiré de la liste seulement (et sa conversation oubliée) : le dépôt reste sur GitHub. */
  const removeRepoFromList = (fullName: string): void => {
    setRecentRepos(forgetRepo(fullName))
    if (repo && repo.fullName.toLowerCase() === fullName.toLowerCase()) closeRepo()
  }

  // Applications ET dépôts, du plus récent au plus ancien, comme les conversations du Chat.
  const listItems = [
    ...recentApps.map((recent) => ({ at: recent.timestamp, item: { id: recent.path, title: recent.label, meta: formatRecentDate(recent.timestamp) } })),
    ...recentRepos.map((recent) => ({
      at: recent.at,
      item: {
        id: repoConversationKey(recent.fullName),
        title: recent.fullName,
        exactTitle: true,
        meta: `GitHub · ${formatRecentDate(recent.at)}`,
        removeLabel: { action: 'Retirer', question: `Retirer « ${recent.fullName} » de la liste ? Le dépôt reste sur GitHub.` }
      }
    }))
  ]
    .sort((a, b) => b.at - a.at)
    .map(({ item }) => item)

  // La conversation affichée est enregistrée sous le nom de son élément, une fois le travail fini (jamais pendant :
  // la phrase de Jaris change à chaque fragment reçu). Le bandeau de fin y est compris, comme le message qu'il
  // deviendra à la demande suivante : rouvrir l'élément doit dire comment le dernier travail s'est terminé.
  const activeConversation = appResult ? appConversationKey(appResult.path) : repo ? repoConversationKey(repo.fullName) : null
  useEffect(() => {
    const owner = conversationOwnerRef.current
    if (generating || !owner || owner !== activeConversation) return
    saveConversation(owner, lastOutcome ? [...turns, { id: turnIdRef.current + 1, kind: 'reply', text: outcomeText(lastOutcome) }] : turns)
  }, [turns, generating, activeConversation, lastOutcome])

  /** Quelque chose à montrer dans l'aperçu : une application, ou un dépôt (son site, ou ses changements). */
  const hasPreview = appResult !== null || repo !== null
  /** Étape 287 : l'onglet « Changements » n'existe que s'il y a quelque chose à vérifier ou qui vient d'être enregistré. */
  const repoHasChanges = repo !== null && (repo.changes.length > 0 || committed !== null)
  const showRepoChanges = repoHasChanges && repoTab === 'changes'

  // Le site du dépôt est redemandé à chaque nouvel état (ouverture, travail de Jaris, annulation, enregistrement) :
  // l'aperçu montre toujours les fichiers tels qu'ils seraient enregistrés. Une réponse en retard sur une plus récente
  // est ignorée.
  useEffect(() => {
    const request = ++repoPreviewRequest.current
    if (!repo) {
      setRepoPreview(null)
      return
    }
    void window.jaris
      .githubPreview(repo.fullName)
      .then((preview) => {
        if (repoPreviewRequest.current === request) setRepoPreview(preview)
      })
      .catch(() => {
        if (repoPreviewRequest.current === request) setRepoPreview({ entry: null, url: null })
      })
  }, [repo])

  // Plus rien à vérifier (tout annulé) : retour à l'aperçu, l'onglet « Changements » ayant disparu.
  useEffect(() => {
    if (!repoHasChanges) setRepoTab('preview')
  }, [repoHasChanges])
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
      items={listItems}
      activeId={appResult?.path ?? (repo ? repoConversationKey(repo.fullName) : null)}
      onSelect={(id) => void (id.startsWith('repo:') ? openRepoFromList(id.slice('repo:'.length)) : openRecent(id))}
      onDelete={(id) => void (id.startsWith('repo:') ? removeRepoFromList(id.slice('repo:'.length)) : remove(id))}
      emptyLabel="Aucune conversation pour l'instant."
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

              {threadItems(turns).map(({ turn, readPaths }) =>
                turn.kind === 'activity' ? (
                  <ActivityRow key={turn.id} activity={turn.activity} readPaths={readPaths} />
                ) : turn.kind === 'user' ? (
                  <div key={turn.id} className="code-chat__user">
                    {turn.text}
                  </div>
                ) : turn.kind === 'note' ? (
                  <p key={turn.id} className="code-chat__note">
                    {turn.text}
                  </p>
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

              {/* Étape 288 (Léo : « enlève ça [le bandeau Étape · caractères · Arrêter], on peut arrêter comme dans le
                  Chat, mais mets ce qu'il fait en direct, par exemple code index.html plus 20 lignes ») : une seule ligne,
                  à la suite de la conversation, qui dit ce que Jaris fait. L'arrêt passe par le bouton du champ. */}
              {generating && <LiveLine text={formatCodeLive(live, progress)} />}

              {/* Fin annoncée À L'ENDROIT MÊME où l'avancement était suivi (étape 100). À la demande suivante, ce
                  bandeau rejoint l'historique de la conversation (archiveLastOutcome). */}
              {!generating && lastOutcome !== null && (
                <p className={`code-panel__done${lastOutcome.kind === 'stopped' ? ' code-panel__done--stopped' : ''}`}>
                  {lastOutcome.kind === 'done' && <CheckIcon />}
                  <span>{outcomeText(lastOutcome)}</span>
                </p>
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
                  <span className="code-preview__busy">
                    {liveSummary(formatCodeLive(live, progress))}
                  </span>
                )}
                <div className="code-preview__tools">
                  {!appResult && repoHasChanges && (
                    <div className="code-panel__view-tabs">
                      <button
                        className={`code-panel__view-tab${repoTab === 'preview' ? ' code-panel__view-tab--active' : ''}`}
                        onClick={() => setRepoTab('preview')}
                      >
                        Aperçu
                      </button>
                      <button
                        className={`code-panel__view-tab code-preview__changes-tab${repoTab === 'changes' ? ' code-panel__view-tab--active' : ''}`}
                        onClick={() => setRepoTab('changes')}
                      >
                        Changements
                        {repo && repo.changes.length > 0 && <span className="code-preview__count">{repo.changes.length}</span>}
                      </button>
                    </div>
                  )}
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
                ) : repo && !showRepoChanges && repoPreview?.url ? (
                  // Le site du dépôt, avec les mêmes protections qu'une application générée (page isolée, sans accès à
                  // Jaris ni au disque). La clé recharge la page à chaque nouvel état des fichiers.
                  <iframe
                    key={repoPreview.url}
                    className="code-panel__preview"
                    title={`Aperçu de ${repo.fullName}`}
                    sandbox="allow-scripts allow-forms"
                    src={repoPreview.url}
                  />
                ) : repo && showRepoChanges ? (
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
                      {!repo
                        ? "L'aperçu de ton application s'affichera ici."
                        : repoPreview === null
                          ? 'Chargement du site…'
                          : repo.fileCount === 0
                            ? "Le dépôt est vide : le site s'affichera ici dès que Jaris aura créé sa page (index.html)."
                            : "Ce dépôt n'a pas de page web (index.html) à afficher. Demande à Jaris d'en créer une pour la voir ici."}
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
              {!appResult && repo && !showRepoChanges && repoPreview?.url && repo.changes.length > 0 && (
                <p className="code-preview__foot">
                  Avec les changements de Jaris, pas encore enregistrés sur GitHub — onglet « Changements » pour les enregistrer.
                </p>
              )}
            </div>
          </section>
        </div>
      </div>
    </Workspace>
  )
}
