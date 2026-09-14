import { useEffect, useRef, useState } from 'react'
import Composer from '@/components/Composer'
import Workspace from '@/components/Workspace'
import { formatRecentDate } from '@/lib/formatRecentDate'
import type { ImageAttachment } from '@/lib/imageAttachment'
import type { GeneratedApp, GeneratedAppSummary } from '../../shared/ipc'

type View = 'preview' | 'code'

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
    <Workspace
      newLabel="Nouvelle application"
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
        {!appResult && !generating && (
          <p className="code-panel__intro">
            Décris une application en français : Jaris l'écrit entièrement sur ta machine, puis la lance
            juste ici. Tu peux aussi joindre une capture ou une maquette à reproduire.
          </p>
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
              <iframe className="code-panel__preview" title="Aperçu de l'application" sandbox="allow-scripts" src={appResult.previewUrl} />
            ) : (
              <pre className="code-panel__code">{appResult.html}</pre>
            )}

            <p className="code-panel__hint">
              Aperçu isolé : la sauvegarde de données (localStorage) n'y marche pas, mais fonctionne en
              ouvrant le fichier depuis le dossier.
            </p>
          </div>
        )}

        {(generating || statusLines.length > 0) && (
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
      </div>
    </Workspace>
  )
}
