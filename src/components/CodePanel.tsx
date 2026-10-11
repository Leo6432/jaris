import { useEffect, useRef, useState, type CSSProperties } from 'react'
import Composer from '@/components/Composer'
import { useContextUsage } from '@/lib/useContextUsage'
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
import ChangesCard from './ChangesCard'
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
  type ChangedFile,
  type ChatTurn,
  type RecentRepo
} from '@/lib/codeConversations'
import type { RepoPreview, RepoView } from '../../shared/ipc'
import { diffLines } from '../../shared/lineDiff'
import { t, tn } from '@/lib/i18n'
import type { MessageKey } from '../../shared/i18n'

type View = 'preview' | 'code'

/** `Omit` appliqué à chaque genre de message séparément (un `Omit` simple fusionnerait les genres). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** Largeur de la conversation choisie à la poignée (étape 283), retenue d'une ouverture à l'autre. */
const CHAT_WIDTH_KEY = 'jaris.codeChatWidth'
/** Pas d'une flèche du clavier sur la poignée. */
const CHAT_WIDTH_STEP = 24

/**
 * Un message de la conversation du mode Code (étape 282) : une demande de Léo, ce que Jaris a répondu, une remarque
 * (téléchargement du modèle, réparation…), ou une action sur un fichier (étape 286 : « Modifié index.html +500 −3 »).
 */

/** Le verbe de chaque action, au passé : ce qui VIENT d'être fait, comme les étapes affichées par Claude. */
const ACTIVITY_VERB: Record<CodeActivity['kind'], MessageKey> = {
  read: 'code.activity.read',
  edit: 'code.activity.edit',
  create: 'code.activity.create',
  rewrite: 'code.activity.rewrite',
  delete: 'code.activity.delete'
}

/** « 500 lignes ajoutées, 3 retirées » : l'explication en toutes lettres, au survol de « +500 −3 ». */
function statsLabel(added: number, removed: number): string {
  if (removed === 0) return tn('code.stats.added', added)
  if (added === 0) return tn('code.stats.removed', removed)
  return `${tn('code.stats.added', added)}, ${tn('code.stats.removed', removed)}`
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
        <span className="code-chat__activity-verb">{tn('code.activity.readFiles', readPaths.length)}</span>
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
      <span className="code-chat__activity-verb">{t(ACTIVITY_VERB[activity.kind])}</span>
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
      {text.elapsed && <span className="code-chat__live-elapsed">· {text.elapsed}</span>}
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

/**
 * La carte de fin (étape 290) : chaque fichier changé et ses lignes, calculées comme dans l'onglet « Changements »
 * (même fonction), pour que les deux ne se contredisent jamais.
 */
function changedFiles(changes: RepoView['changes']): ChangedFile[] {
  return changes.map((change) => {
    const diff = diffLines(change.before, change.after)
    return { path: change.path, kind: change.kind, added: diff.added, removed: diff.removed }
  })
}

/** « Travaillé pendant 2 min 10 », comme ChatGPT, ou « Arrêté après 12 s » : une ligne discrète, plus un bandeau. */
function WorkedLine({ durationMs, stopped }: { durationMs: number; stopped?: boolean }): JSX.Element {
  return (
    <p className={`code-chat__worked${stopped ? ' code-chat__worked--stopped' : ''}`}>
      <span>{stopped ? t('code.stoppedAfter', { duration: formatDuration(durationMs) }) : t('code.workedFor', { duration: formatDuration(durationMs) })}</span>
    </p>
  )
}

/** Icônes de la barre de l'aperçu (étape 284), propres à cet endroit. */
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
  }, [turns, generating, error])

  function addTurn(kind: 'user' | 'reply' | 'note', text: string): void {
    pushTurn({ kind, text })
  }

  /** Ajoute un message de n'importe quel genre (étape 290 : la durée du travail, la carte des fichiers changés). */
  function pushTurn(turn: DistributiveOmit<ChatTurn, 'id'>): void {
    turnIdRef.current += 1
    const id = turnIdRef.current
    setTurns((prev) => [...prev, { ...turn, id } as ChatTurn])
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
  const runOnRepo = async (current: RepoView, prompt: string, image: ImageAttachment | null): Promise<void> => {
    addTurn('user', prompt || t('code.reproduceImage.short'))
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
      // Étape 298 : une capture jointe part avec la demande, comme pour une nouvelle application.
      const result = await window.jaris.githubRunAgent(current.fullName, prompt || t('code.reproduceImage'), image?.base64)
      setAttachment(null)
      setRepo(result.view)
      // Étape 290 (Léo : « à la fin ça doit faire comme ChatGPT ») : la durée, la réponse, puis la carte des fichiers.
      pushTurn({ kind: 'worked', durationMs: Date.now() - startedAt })
      addTurn('reply', result.summary)
      // Les fichiers viennent des changements RÉELLEMENT préparés, jamais de ce que le modèle dit avoir fait : vu
      // avec un vrai modèle, le résumé peut annoncer un changement qui n'a pas eu lieu.
      if (result.view.changes.length > 0) {
        setCommitMessage((prompt || t('code.reproduceImage.short')).split('\n')[0].slice(0, 72))
        pushTurn({ kind: 'changes', files: changedFiles(result.view.changes) })
      } else {
        addTurn('note', t('code.noFileChanged'))
      }
      void playSoundCueIfEnabled('success')
    } catch (err) {
      if (stoppedRef.current) {
        pushTurn({ kind: 'worked', durationMs: Date.now() - startedAt, stopped: true })
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
      addTurn('reply', t('code.savedOnGithub', { sha: result.sha.slice(0, 7) }))
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

  /** « Annuler » de la carte de fin (étape 290) : tout ce qui est préparé repart, rien n'a été envoyé sur GitHub. */
  const undoRepoChanges = async (): Promise<void> => {
    if (!repo || repo.changes.length === 0) return
    const count = repo.changes.length
    await discardRepo()
    addTurn('note', tn('code.changesUndone', count))
  }

  const changeBranch = async (branch: string): Promise<void> => {
    if (!repo) return
    try {
      // La conversation continue : seule la branche change.
      await openRepo(repo.fullName, branch, true)
      addTurn('reply', t('code.branch', { branch }))
    } catch (err) {
      setError(ipcErrorMessage(err))
    }
  }

  const generate = async (): Promise<void> => {
    const prompt = description.trim()
    if (repo) {
      if ((prompt || attachment) && !generating) await runOnRepo(repo, prompt, attachment)
      return
    }
    // Une image seule suffit ("reproduis cette maquette") : le texte n'est plus obligatoire s'il y a une image.
    if ((!prompt && !attachment) || generating) return

    addTurn('user', prompt || t('code.reproduceImage.short'))
    setDescription('')
    clearGenerationFeedback()
    setGenerating(true)
    setProgress(null)
    stoppedRef.current = false
    const startedAt = Date.now()
    const previousHtml = appResult?.html ?? null
    try {
      // appResult présent = demande de modification : le fichier actuel part avec la demande.
      const result = await window.jaris.generateApp(
        prompt || t('code.reproduceImage'),
        appResult?.html,
        attachment?.base64
      )
      // La conversation suit l'application jusqu'à sa nouvelle version (chaque génération crée son propre dossier).
      conversationOwnerRef.current = appConversationKey(result.path)
      setAppResult(result)
      setAttachment(null)
      setView('preview')
      // Fin annoncée comme sur ChatGPT (étape 290) : la durée, puis la carte du fichier écrit — et un bip si les sons
      // sont activés : une génération peut durer plusieurs minutes, pendant lesquelles Léo fait autre chose.
      pushTurn({ kind: 'worked', durationMs: Date.now() - startedAt })
      const diff = diffLines(previousHtml, result.html)
      pushTurn({ kind: 'changes', files: [{ path: 'index.html', kind: previousHtml === null ? 'added' : 'modified', added: diff.added, removed: diff.removed }] })
      void playSoundCueIfEnabled('success')
      void window.jaris.getGeneratedApps().then(setRecentApps)
    } catch (err) {
      // Un arrêt demandé n'est pas une panne : il s'affiche dans le bandeau, au même endroit que
      // l'avancement qu'il interrompt, jamais en rouge.
      if (stoppedRef.current) {
        pushTurn({ kind: 'worked', durationMs: Date.now() - startedAt, stopped: true })
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
        removeLabel: { action: t('code.repo.remove'), question: t('code.repo.removeQuestion', { name: recent.fullName }) }
      }
    }))
  ]
    .sort((a, b) => b.at - a.at)
    .map(({ item }) => item)

  // La conversation affichée est enregistrée sous le nom de son élément, une fois le travail fini (jamais pendant :
  // la phrase de Jaris change à chaque fragment reçu). La fin du dernier travail (durée, fichiers) en fait partie.
  const activeConversation = appResult ? appConversationKey(appResult.path) : repo ? repoConversationKey(repo.fullName) : null
  // Étape 299 : « utilisé / maximum » de la mémoire du modèle, d'après Ollama, pour la conversation affichée.
  const contextUsage = useContextUsage('code', activeConversation)
  useEffect(() => {
    const owner = conversationOwnerRef.current
    if (generating || !owner || owner !== activeConversation) return
    saveConversation(owner, turns)
  }, [turns, generating, activeConversation])

  /** Quelque chose à montrer dans l'aperçu : une application, ou un dépôt (son site, ou ses changements). */
  const hasPreview = appResult !== null || repo !== null
  /** Étape 287 : l'onglet « Changements » n'existe que s'il y a quelque chose à vérifier ou qui vient d'être enregistré. */
  const repoHasChanges = repo !== null && (repo.changes.length > 0 || committed !== null)
  const showRepoChanges = repoHasChanges && repoTab === 'changes'

  // Étape 290 : seule la carte du DERNIER travail a ses boutons — une carte plus ancienne n'est plus qu'une trace.
  let liveChangesId: number | null = null
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]
    if (turn.kind === 'changes') liveChangesId = turn.id
    if (turn.kind === 'changes' || turn.kind === 'user') break
  }
  const changesActions = generating
    ? undefined
    : repo
      ? repoHasChanges
        ? {
            // Plus rien à annuler une fois annulé ou enregistré sur GitHub : le bouton disparaît.
            onUndo: repo.changes.length > 0 ? () => void undoRepoChanges() : undefined,
            onShow: () => setRepoTab('changes'),
            showLabel: t('code.showChanges'),
            busy: committing
          }
        : undefined
      : appResult
        ? { onShow: () => setView('code'), showLabel: t('code.showCode') }
        : undefined

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
    ? (recentApps.find((recent) => recent.path === appResult.path)?.label ?? t('code.yourApp'))
    : repo
      ? repo.fullName
      : t('code.preview')

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
      newLabel={t('code.new')}
      label={t('app.mode.code')}
      onNew={startOver}
      items={listItems}
      activeId={appResult?.path ?? (repo ? repoConversationKey(repo.fullName) : null)}
      onSelect={(id) => void (id.startsWith('repo:') ? openRepoFromList(id.slice('repo:'.length)) : openRecent(id))}
      onDelete={(id) => void (id.startsWith('repo:') ? removeRepoFromList(id.slice('repo:'.length)) : remove(id))}
      emptyLabel={t('code.listEmpty')}
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
          <section ref={chatRef} className="code-chat" aria-label={t('code.conversation')}>
            <div className="code-chat__thread" ref={threadRef}>
              {turns.length === 0 && !generating && (
                <EmptyState
                  title={
                    repo
                      ? repo.fileCount === 0
                        ? t('code.empty.repoEmpty')
                        : t('code.empty.repo')
                      : appResult
                        ? t('code.empty.app')
                        : t('code.empty.new')
                  }
                  description={
                    repo
                      ? repo.fileCount === 0
                        ? t('code.empty.repoEmpty.hint')
                        : t('code.empty.repo.hint')
                      : appResult
                        ? t('code.empty.app.hint')
                        : t('code.empty.new.hint')
                  }
                  suggestions={
                    repo
                      ? repo.fileCount === 0
                        ? [t('code.suggest.repoEmpty.1'), t('code.suggest.repoEmpty.2'), t('code.suggest.gitignore')]
                        : [t('code.suggest.repo.1'), t('code.suggest.repo.2'), t('code.suggest.gitignore')]
                      : appResult
                        ? [t('code.suggest.app.1'), t('code.suggest.app.2'), t('code.suggest.app.3')]
                        : [t('code.suggest.new.1'), t('code.suggest.new.2'), t('code.suggest.new.3')]
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
                ) : turn.kind === 'worked' ? (
                  <WorkedLine key={turn.id} durationMs={turn.durationMs} stopped={turn.stopped} />
                ) : turn.kind === 'changes' ? (
                  <ChangesCard key={turn.id} files={turn.files} actions={turn.id === liveChangesId ? changesActions : undefined} />
                ) : (
                  <p key={turn.id} className="code-chat__reply">
                    {turn.text}
                  </p>
                )
              )}

              {appResult && appResult.issues.length > 0 && (
                <div className="code-panel__issues">
                  <strong>
                    {tn('code.issues', appResult.issues.length)}
                  </strong>
                  <ul>
                    {appResult.issues.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                  {t('code.issues.hint')}
                </div>
              )}

              {/* Étape 288 (Léo : « enlève ça [le bandeau Étape · caractères · Arrêter], on peut arrêter comme dans le
                  Chat, mais mets ce qu'il fait en direct, par exemple code index.html plus 20 lignes ») : une seule ligne,
                  à la suite de la conversation, qui dit ce que Jaris fait. L'arrêt passe par le bouton du champ. */}
              {generating && <LiveLine text={formatCodeLive(live, progress)} />}

              {error && <p className="code-panel__error">{error}</p>}
            </div>

            <Composer
              value={description}
              onChange={setDescription}
              onSubmit={() => void generate()}
              placeholder={
                repo
                  ? t('code.placeholder.repo', { name: repo.fullName })
                  : appResult
                    ? t('code.placeholder.app')
                    : t('code.placeholder.new')
              }
              submitLabel={repo ? t('common.send') : appResult ? t('code.submit.modify') : t('code.submit.generate')}
              busyLabel={repo ? t('code.busy.repo') : t('code.busy.app')}
              busy={generating}
              onStop={stop}
              extraActions={
                <>
                  <GithubPicker repo={repo} onOpenRepo={(fullName) => openRepo(fullName)} onCloseRepo={closeRepo} disabled={generating || committing} />
                  {repo && <BranchPicker repo={repo} onChange={changeBranch} disabled={generating || committing} />}
                  <ModelEffortPicker mode="code" disabled={generating} />
                </>
              }
              attachment={attachment}
              onAttachmentChange={setAttachment}
              contextUsage={contextUsage}
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
            aria-label={t('code.handle.label')}
            aria-valuemin={CHAT_MIN_WIDTH}
            aria-valuenow={chatWidth ?? undefined}
            tabIndex={0}
            title={t('code.handle.title')}
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

          <section className={`code-preview${hasPreview ? '' : ' code-preview--empty'}`} aria-label={t('code.preview')}>
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
                        {t('code.preview')}
                      </button>
                      <button
                        className={`code-panel__view-tab code-preview__changes-tab${repoTab === 'changes' ? ' code-panel__view-tab--active' : ''}`}
                        onClick={() => setRepoTab('changes')}
                      >
                        {t('code.tab.changes')}
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
                        {t('code.preview')}
                      </button>
                      <button
                        className={`code-panel__view-tab${view === 'code' ? ' code-panel__view-tab--active' : ''}`}
                        onClick={() => setView('code')}
                      >
                        {t('app.mode.code')}
                      </button>
                    </div>
                  )}
                  {appResult && !generating && (
                    <button
                      className="panel__icon-button code-preview__folder"
                      onClick={() => void window.jaris.openGeneratedApp(appResult.path)}
                      title={t('code.openFolderPath', { path: appResult.path })}
                      aria-label={t('common.openFolder')}
                    >
                      <FolderIcon />
                    </button>
                  )}
                  {hasPreview && (
                    <button
                      className="panel__icon-button code-preview__expand"
                      onClick={() => setPreviewExpanded(!previewExpanded)}
                      title={previewExpanded ? t('code.preview.collapseEsc') : t('code.preview.expand')}
                      aria-label={previewExpanded ? t('code.preview.collapse') : t('code.preview.expand')}
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
                    <iframe className="code-panel__preview" title={t('code.preview.appTitle')} sandbox="allow-scripts allow-forms" src={appResult.previewUrl} />
                  ) : (
                    <pre className="code-panel__code">{appResult.html}</pre>
                  )
                ) : repo && !showRepoChanges && repoPreview?.url ? (
                  // Le site du dépôt, avec les mêmes protections qu'une application générée (page isolée, sans accès à
                  // Jaris ni au disque). La clé recharge la page à chaque nouvel état des fichiers.
                  <iframe
                    key={repoPreview.url}
                    className="code-panel__preview"
                    title={t('code.preview.of', { name: repo.fullName })}
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
                        ? t('code.placeholderPreview.app')
                        : repoPreview === null
                          ? t('code.placeholderPreview.loading')
                          : repo.fileCount === 0
                            ? t('code.placeholderPreview.repoEmpty')
                            : t('code.placeholderPreview.noPage')}
                    </p>
                  </div>
                )}
              </div>

              {appResult && view === 'preview' && (
                <p className="code-preview__foot">
                  {t('code.preview.isolated')}
                </p>
              )}
              {!appResult && repo && !showRepoChanges && repoPreview?.url && repo.changes.length > 0 && (
                <p className="code-preview__foot">
                  {t('code.preview.withChanges')}
                </p>
              )}
            </div>
          </section>
        </div>
      </div>
    </Workspace>
  )
}
