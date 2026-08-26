import { useEffect, useRef, useState } from 'react'
import type { GeneratedApp } from '../../shared/ipc'

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
  const statusRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    return window.jaris.onCodeGenStatus((message) => setStatusLines((prev) => [...prev, message]))
  }, [])

  useEffect(() => {
    statusRef.current?.scrollTo({ top: statusRef.current.scrollHeight })
  }, [statusLines])

  const generate = async (): Promise<void> => {
    const prompt = description.trim()
    if (!prompt || generating) return

    setError(null)
    setGenerating(true)
    setStatusLines([])
    try {
      // appResult présent = demande de modification : le fichier actuel part avec la demande.
      const result = await window.jaris.generateApp(prompt, appResult?.html)
      setAppResult(result)
      setDescription('')
      setView('preview')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setGenerating(false)
    }
  }

  const startOver = (): void => {
    setAppResult(null)
    setStatusLines([])
    setError(null)
    setDescription('')
  }

  return (
    <div className="code-panel">
      <div className="code-panel__composer">
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder={
            appResult
              ? 'Que veux-tu changer ? (ex: ajoute un mode sombre, trie les tâches par date…)'
              : "Décris l'application à créer… (ex: une todo list avec des catégories et une barre de progression)"
          }
          rows={3}
          disabled={generating}
        />
        <div className="code-panel__actions">
          <button className="code-panel__generate" onClick={() => void generate()} disabled={generating || !description.trim()}>
            {generating ? 'Génération…' : appResult ? 'Modifier' : "Générer l'application"}
          </button>
          {appResult && !generating && (
            <>
              <button onClick={startOver}>Nouvelle application</button>
              <button onClick={() => void window.jaris.openGeneratedApp(appResult.path)}>Ouvrir le dossier</button>
            </>
          )}
        </div>
      </div>

      {error && <p className="code-panel__error">{error}</p>}

      {(generating || statusLines.length > 0) && (
        <pre ref={statusRef} className="code-panel__status">
          {statusLines.join('\n')}
        </pre>
      )}

      {appResult && appResult.issues.length > 0 && (
        <div className="code-panel__issues">
          <strong>
            L'application a été générée mais {appResult.issues.length === 1 ? 'un problème n\'a pas pu être corrigé' : `${appResult.issues.length} problèmes n'ont pas pu être corrigés`}
            {' '}(modèle local trop limité pour cette demande) :
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

          {view === 'preview' ? (
            // sandbox sans allow-same-origin : le code généré par le modèle tourne dans une origine opaque,
            // sans accès à Jaris ni aux fichiers locaux. Conséquence assumée : localStorage y est bloqué
            // (d'où le try/catch imposé dans les consignes de génération), mais il refonctionne dès que le
            // fichier est ouvert normalement dans un navigateur depuis le dossier du projet.
            <iframe className="code-panel__preview" title="Aperçu de l'application" sandbox="allow-scripts" srcDoc={appResult.html} />
          ) : (
            <pre className="code-panel__code">{appResult.html}</pre>
          )}

          <p className="code-panel__hint">
            Enregistré dans <code>{appResult.path}</code>. L'aperçu tourne isolé, sans accès au reste de la
            machine : la sauvegarde de données (localStorage) n'y fonctionne pas, mais marche en ouvrant le
            fichier depuis le dossier.
          </p>
        </div>
      )}
    </div>
  )
}
