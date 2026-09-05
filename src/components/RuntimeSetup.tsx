import { useEffect, useRef, useState } from 'react'
import type { RuntimeSetupProgress } from '../../shared/ipc'

/**
 * Écran d'installation du premier lancement (étape 16 du roadmap) : Jaris installe lui-même Python, ses
 * dépendances et Ollama, sans que l'utilisateur ouvre le moindre terminal.
 *
 * Démarre tout seul dès l'affichage plutôt que derrière un bouton "Installer" : à ce stade l'utilisateur
 * vient de double-cliquer sur un installeur et de donner son prénom, il n'y a rien à choisir ici — un
 * bouton de plus ne serait qu'une étape de plus à franchir pour un résultat identique.
 */
export default function RuntimeSetup({ onDone }: { onDone: () => void }): JSX.Element {
  const [progress, setProgress] = useState<RuntimeSetupProgress | null>(null)
  const [failures, setFailures] = useState<string[]>([])
  const [finished, setFinished] = useState(false)
  const [attempt, setAttempt] = useState(0)
  // React monte deux fois chaque composant en développement (StrictMode) : sans ce garde, une même
  // tentative partirait deux fois en parallèle sur le même dossier, les deux se marchant dessus.
  const startedAttempt = useRef(-1)

  useEffect(() => {
    const unsubscribe = window.jaris.onRuntimeSetupProgress((update) => {
      setProgress(update)
      if (update.failed) setFailures((prev) => [...prev, update.message])
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    if (startedAttempt.current === attempt) return
    startedAttempt.current = attempt
    setProgress(null)
    setFailures([])
    setFinished(false)

    window.jaris
      .runRuntimeSetup()
      .then((status) => {
        if (status.ready) {
          onDone()
          return
        }
        // Installation incomplète : on ne bloque pas l'utilisateur dans cet écran, il peut réessayer ou
        // continuer — les messages d'échec déjà collectés lui disent ce qui manque.
        setFinished(true)
      })
      .catch((err: unknown) => {
        setFailures((prev) => [...prev, err instanceof Error ? err.message : String(err)])
        setFinished(true)
      })
  }, [attempt, onDone])

  return (
    <div className="app">
      <div className="runtime-setup">
        <h1>Installation de Jaris</h1>
        <p className="runtime-setup__intro">
          Jaris télécharge ce dont il a besoin pour fonctionner entièrement sur ton ordinateur : le moteur
          de conversation et la reconnaissance vocale. Ça prend quelques minutes la première fois, et tu
          n'as rien à faire.
        </p>

        <div className="runtime-setup__status">{progress?.message ?? 'Préparation…'}</div>

        {/* Barre remplie seulement quand un pourcentage a un sens (un téléchargement) : pendant une étape
            dont la durée est inconnue, elle reste en animation indéterminée plutôt que d'afficher un
            chiffre inventé qui n'avancerait pas. */}
        <div className="runtime-setup__bar">
          <div
            className={`runtime-setup__bar-fill${progress?.percent === undefined ? ' runtime-setup__bar-fill--pulse' : ''}`}
            style={progress?.percent === undefined ? undefined : { width: `${Math.round(progress.percent)}%` }}
          />
        </div>

        {failures.length > 0 && (
          <ul className="runtime-setup__failures">
            {failures.map((failure, i) => (
              <li key={i}>{failure}</li>
            ))}
          </ul>
        )}

        {finished && (
          <div className="runtime-setup__actions">
            <button onClick={() => setAttempt((n) => n + 1)}>Réessayer</button>
            <button className="runtime-setup__skip" onClick={onDone}>
              Continuer quand même
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
