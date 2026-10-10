import { useEffect, useRef, useState } from 'react'
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
import type { RepoView } from '../../shared/ipc'

type View = 'preview' | 'code'

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
  const [lastOutcome, setLastOutcome] = useState<{ kind: 'done' | 'stopped'; durationMs: number; text?: string } | null>(null)
  /** Étape 277 : dépôt GitHub ouvert (choisi dans le bouton GitHub du champ). Remplace l'application générée. */
  const [repo, setRepo] = useState<RepoView | null>(null)
  /** Dernière réponse de Jaris sur ce dépôt (ce qu'il a changé, ou la réponse à une question). */
  const [repoSummary, setRepoSummary] = useState<string | null>(null)
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

  /** Étape 277 : la demande part à l'agent qui travaille sur le dépôt ouvert, pas au générateur d'application. */
  const runOnRepo = async (current: RepoView, prompt: string): Promise<void> => {
    clearGenerationFeedback()
    setCommitted(null)
    setGenerating(true)
    setProgress(null)
    stoppedRef.current = false
    const startedAt = Date.now()
    try {
      const result = await window.jaris.githubRunAgent(current.fullName, prompt)
      setRepo(result.view)
      setRepoSummary(result.summary)
      setDescription('')
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

  const openRepo = async (fullName: string, branch?: string): Promise<void> => {
    const view = await window.jaris.githubOpenRepo(fullName, branch)
    setAppResult(null)
    clearGenerationFeedback()
    setRepoSummary(null)
    setCommitted(null)
    setAttachment(null)
    setRepo(view)
  }

  const closeRepo = (): void => {
    setRepo(null)
    setRepoSummary(null)
    setCommitted(null)
    clearGenerationFeedback()
  }

  const commitRepo = async (message: string): Promise<void> => {
    if (!repo) return
    setError(null)
    setCommitting(true)
    try {
      const result = await window.jaris.githubCommit(repo.fullName, message)
      setRepo(result.view)
      setCommitted({ url: result.url, sha: result.sha })
      setRepoSummary(null)
      setLastOutcome(null)
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
      await openRepo(repo.fullName, branch)
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
      setDescription('')
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
      <div className="code-panel">
        {/* Écran de départ : la liste des applications déjà créées vit maintenant dans la colonne de gauche
            (étape 97), il ne reste donc ici que la phrase qui dit à quoi sert ce mode — sans elle, l'écran
            serait entièrement vide avant la première génération. */}
        {/* Étape 277 : un dépôt GitHub ouvert prend la place de l'application générée. */}
        {/* Étape 280 : rien en haut tant qu'il n'y a rien à montrer — le dépôt et sa branche sont dans le champ. */}
        {repo && (repo.changes.length > 0 || repoSummary || committed) && (
          <RepoChanges
            repo={repo}
            summary={repoSummary}
            busy={generating || committing}
            committed={committed}
            defaultMessage={commitMessage}
            onCommit={commitRepo}
            onDiscard={discardRepo}
          />
        )}

        {repo && !generating && repo.changes.length === 0 && !repoSummary && !committed && (
          // Étape 279 : un dépôt tout neuf s'ouvre aussi ; on y propose de CRÉER, pas d'expliquer ce qui n'existe pas.
          <EmptyState
            title={repo.fileCount === 0 ? 'Ce dépôt est encore vide' : 'Que doit faire Jaris dans ce dépôt ?'}
            description={
              repo.fileCount === 0
                ? "Décris ce que Jaris doit y créer. Tu verras chaque fichier avant de l'enregistrer sur GitHub — rien n'est envoyé avant."
                : "Il lit les fichiers dont il a besoin et prépare les changements. Tu les vois ligne par ligne, puis tu choisis de les enregistrer sur GitHub — rien n'est envoyé avant."
            }
            suggestions={
              repo.fileCount === 0
                ? ['Crée un petit site web de présentation', 'Crée un fichier qui présente le projet', 'Ajoute un fichier .gitignore adapté']
                : ['Explique ce que fait ce dépôt', "Corrige les fautes d'orthographe", 'Ajoute un fichier .gitignore adapté']
            }
            onSuggestion={setDescription}
          />
        )}

        {!repo && !appResult && !generating && (
          <EmptyState
            title="Quelle application veux-tu créer ?"
            description="Décris-la simplement : Jaris l'écrit entièrement sur ta machine, puis la lance juste ici. Tu peux aussi joindre une capture ou une maquette à reproduire."
            suggestions={['Un minuteur Pomodoro', 'Une liste de courses', 'Un convertisseur de devises']}
            onSuggestion={setDescription}
          />
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

        {appResult && (
          <div className="code-panel__result">
            {/* Une SEULE barre (étape 94) : les onglets Aperçu/Code et les actions secondaires étaient deux
                rangées séparées, empilées au-dessus de l'aperçu — "après il y a des boutons" (Léo). */}
            <div className="code-panel__result-bar">
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

              {!generating && (
                <div className="code-panel__result-actions">
                  <button onClick={() => void window.jaris.openGeneratedApp(appResult.path)} title={appResult.path}>
                    Ouvrir le dossier
                  </button>
                </div>
              )}
            </div>

            {view === 'preview' ? (
              // sandbox sans allow-same-origin : le code généré par le modèle tourne dans une origine opaque,
              // sans accès à Jaris ni aux fichiers locaux. Conséquence assumée : localStorage y est bloqué
              // (d'où le try/catch imposé dans les consignes de génération), mais il refonctionne dès que le
              // fichier est ouvert normalement dans un navigateur depuis le dossier du projet.
              // allow-forms (étape 232) : sans lui, un formulaire généré ne réagit jamais au clic (vérifié dans un
              // vrai navigateur : l'évènement « submit » n'est même pas déclenché). L'envoi réel reste bloqué par
              // la règle form-action 'none' de l'aperçu (generatedAppPreview.ts).
              <iframe className="code-panel__preview" title="Aperçu de l'application" sandbox="allow-scripts allow-forms" src={appResult.previewUrl} />
            ) : (
              <pre className="code-panel__code">{appResult.html}</pre>
            )}

            <p className="code-panel__hint">
              Aperçu isolé : la sauvegarde de données (localStorage) n'y marche pas, mais fonctionne en
              ouvrant le fichier depuis le dossier.
            </p>
          </div>
        )}

        {/* Étape 99 : le bandeau qui manquait. Une génération enchaîne 2 à 4 appels au modèle local, chacun
            pouvant durer plusieurs minutes — "on ne sait pas quand c'est terminé et des fois c'est bloqué et
            ça fait rien" (Léo). On montre donc où on en est (étape X sur Y), la preuve que ça avance (les
            caractères écrits, qui montent), depuis combien de temps, et une sortie de secours. */}
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

        {/* Fin de génération annoncée À L'ENDROIT MÊME où l'avancement était suivi (étape 100) : Léo
            regardait le bandeau, c'est donc là que doit s'afficher "c'est fini", pas dans une petite ligne
            grise ailleurs. Une modification d'application donne souvent un aperçu presque identique à
            l'œil — sans cette phrase, rien ne dit que le travail est terminé. */}
        {!generating && lastOutcome !== null && (
          <p className={`code-panel__done${lastOutcome.kind === 'stopped' ? ' code-panel__done--stopped' : ''}`}>
            {lastOutcome.kind === 'done' && <CheckIcon />}
            {/* Pas de "ci-dessus"/"ci-dessous" : l'aperçu est au-dessus de ce bandeau, mais une phrase qui
                désigne une position devient fausse au premier changement de mise en page. */}
            <span>
              {lastOutcome.kind === 'done'
                ? repo
                  ? `Terminé en ${formatDuration(lastOutcome.durationMs)} — ${lastOutcome.text}`
                  : `Terminé en ${formatDuration(lastOutcome.durationMs)} — ton application est à jour.`
                : `Génération arrêtée après ${formatDuration(lastOutcome.durationMs)}.`}
            </span>
          </p>
        )}

        {/* Journal réservé à ce que le bandeau ne dit PAS (modèle à télécharger, problèmes réparés, relance
            après une réponse inexploitable). Il répétait les étapes une par une, ce qui donnait deux cadres
            côte à côte disant la même chose — et il s'affichait même vide pendant toute la génération
            (étape 101, Léo : "il y a étape 2 etc. plus un autre rectangle"). */}
        {statusLines.length > 0 && (
          <pre ref={statusRef} className="code-panel__status">
            {statusLines.join('\n')}
          </pre>
        )}

        {error && <p className="code-panel__error">{error}</p>}

        {/* Composeur EN BAS, comme dans le Chat (étape 97) : les deux écrans ont maintenant exactement la
            même présentation — liste à gauche, contenu au centre, champ de saisie en bas. */}
        <Composer
          value={description}
          onChange={setDescription}
          onSubmit={() => void generate()}
          placeholder={
            repo
              ? `Que veux-tu changer dans ${repo.fullName} ?`
              : appResult
              ? 'Que veux-tu changer ? (ex: ajoute un mode sombre, trie les tâches par date…)'
              : "Décris l'application à créer, ou joins une maquette à reproduire…"
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
      </div>
    </Workspace>
  )
}
