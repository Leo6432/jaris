import { useEffect, useRef, useState } from 'react'
import Composer from '@/components/Composer'
import { formatRecentDate } from '@/lib/formatRecentDate'
import type { ImageAttachment } from '@/lib/imageAttachment'
import type { GeneratedApp, GeneratedAppSummary } from '../../shared/ipc'

type View = 'preview' | 'code'

/** Chevron de fin de ligne : dit qu'une ligne de la liste s'ouvre, là où un simple cadre ne disait rien. */
function OpenIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M9 6l6 6-6 6" />
    </svg>
  )
}

/** Corbeille (étape 95) : même parti pris que l'icône de pièce jointe du composeur — un SVG inline qui
 *  hérite de `currentColor`, aucune dépendance, aucun emoji. */
function DeleteIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M4 7h16M10 4h4M9 7v12M15 7v12M6 7l1 13h10l1-13" />
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
  /** Chemin de l'application dont la ligne demande confirmation avant suppression (une seule à la fois). */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const statusRef = useRef<HTMLPreElement>(null)

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
    statusRef.current?.scrollTo({ top: statusRef.current.scrollHeight })
  }, [statusLines])

  const generate = async (): Promise<void> => {
    const prompt = description.trim()
    // Une image seule suffit ("reproduis cette maquette") : le texte n'est plus obligatoire s'il y a une image.
    if ((!prompt && !attachment) || generating) return

    setError(null)
    setGenerating(true)
    setStatusLines([])
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
      void window.jaris.getGeneratedApps().then(setRecentApps)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setGenerating(false)
    }
  }

  const openRecent = async (path: string): Promise<void> => {
    setError(null)
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
    setPendingDelete(null)
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
    setAppResult(null)
    setStatusLines([])
    setError(null)
    setDescription('')
    setAttachment(null)
  }

  return (
    <div className="code-panel">
      <Composer
        value={description}
        onChange={setDescription}
        onSubmit={() => void generate()}
        placeholder={
          appResult
            ? 'Que veux-tu changer ? (ex: ajoute un mode sombre, trie les tâches par date…)'
            : "Décris l'application à créer, ou joins une maquette à reproduire…"
        }
        submitLabel={appResult ? 'Modifier' : "Générer l'application"}
        busyLabel="Génération…"
        busy={generating}
        attachment={attachment}
        onAttachmentChange={setAttachment}
        onError={setError}
        rows={3}
        hint="Ctrl+V pour coller une capture, ou glisse une image ici"
      />

      {error && <p className="code-panel__error">{error}</p>}

      {(generating || statusLines.length > 0) && (
        <pre ref={statusRef} className="code-panel__status">
          {statusLines.join('\n')}
        </pre>
      )}

      {/* Écran de départ (étape 94) : avant, la liste des applications déjà créées était posée telle quelle
          sous le champ, sous une micro-étiquette "Récents", au-dessus d'un grand vide — "on comprend pas
          trop les truc recent en bas" (Léo). Elle devient un vrai panneau titré qui occupe la place
          disponible, avec une phrase qui dit ce que fait ce mode : sans app chargée, c'est le seul contenu
          de l'écran, il ne peut pas rester muet. */}
      {!appResult && !generating && (
        <div className="code-panel__start">
          <p className="code-panel__intro">
            Décris une application en français : Jaris l'écrit entièrement sur ta machine, puis la lance
            juste ici. Tu peux aussi joindre une capture ou une maquette à reproduire.
          </p>

          {recentApps.length > 0 && (
            <div className="code-panel__recents">
              <div className="code-panel__recents-header">
                <span className="code-panel__section-title">Tes applications</span>
                <span className="code-panel__recents-tip">Clique pour rouvrir</span>
              </div>
              <ul>
                {recentApps.map((recent) => (
                  <li key={recent.path}>
                    {/* Confirmation DANS la ligne, pas un dialogue natif : supprimer efface un dossier pour
                        de bon, donc ça se confirme — mais un dialogue natif ferait perdre le focus à la
                        fenêtre, et Jaris se replierait en widget en plein milieu (piège de l'étape 93). */}
                    {pendingDelete === recent.path ? (
                      <div className="code-panel__recent-confirm">
                        <span>Supprimer « {recent.label} » définitivement ?</span>
                        <button className="code-panel__recent-confirm-yes" onClick={() => void remove(recent.path)}>
                          Supprimer
                        </button>
                        <button className="code-panel__recent-confirm-no" onClick={() => setPendingDelete(null)}>
                          Annuler
                        </button>
                      </div>
                    ) : (
                      <>
                        <button
                          className="code-panel__recent-open"
                          onClick={() => void openRecent(recent.path)}
                          title={recent.path}
                        >
                          <span className="code-panel__recent-label">{recent.label}</span>
                          <span className="code-panel__recent-date">{formatRecentDate(recent.timestamp)}</span>
                          <OpenIcon />
                        </button>
                        <button
                          className="code-panel__recent-delete"
                          onClick={() => setPendingDelete(recent.path)}
                          title={`Supprimer ${recent.label}`}
                          aria-label={`Supprimer ${recent.label}`}
                        >
                          <DeleteIcon />
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
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
          {/* Une SEULE barre (étape 94) : les onglets Aperçu/Code et les deux actions secondaires étaient
              deux rangées séparées, empilées avec le composeur au-dessus de l'aperçu — quatre bandes avant
              d'atteindre l'application elle-même, "après il y a des boutons" (Léo). Les actions rejoignent
              la ligne des onglets, à droite et en plus petit : elles restent de la même famille de boutons
              que le reste de l'app, sans concurrencer l'aperçu. */}
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
                <button onClick={startOver}>Nouvelle application</button>
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
            <iframe className="code-panel__preview" title="Aperçu de l'application" sandbox="allow-scripts" src={appResult.previewUrl} />
          ) : (
            <pre className="code-panel__code">{appResult.html}</pre>
          )}

          {/* Le chemin complet du dossier vivait ici en toutes lettres, sur deux lignes serrées en bas de
              l'écran — il est maintenant dans l'infobulle du bouton "Ouvrir le dossier", qui fait mieux le
              travail. Ne reste que ce qui est vraiment utile à savoir en regardant l'aperçu. */}
          <p className="code-panel__hint">
            Aperçu isolé : la sauvegarde de données (localStorage) n'y marche pas, mais fonctionne en
            ouvrant le fichier depuis le dossier.
          </p>
        </div>
      )}
    </div>
  )
}
