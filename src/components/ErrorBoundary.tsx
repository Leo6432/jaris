import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  /** Nom de l'écran, tel que Léo le voit dans le menu (« Le Chat », « Le Cerveau de Jaris »...). */
  label: string
  /** Écran plein (Cerveau) : sans bouton pour le fermer, le message d'erreur couvrirait tout Jaris. */
  onClose?: () => void
  overlay?: boolean
  children: ReactNode
}

interface ErrorBoundaryState {
  message: string | null
}

/**
 * Étape 234 (bêta) : sans ce garde, une exception dans UN écran démonte tout l'arbre React — menu de gauche
 * compris — et il ne reste qu'une fenêtre vide, sans autre issue que de redémarrer Jaris (constaté avec le
 * Cerveau sur une machine sans WebGL). L'erreur reste confinée à l'écran qui l'a levée.
 */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { message: null }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { message: error instanceof Error ? error.message : String(error) }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`[ErrorBoundary] ${this.props.label} :`, error, info.componentStack)
  }

  render(): ReactNode {
    const { message } = this.state
    if (message === null) return this.props.children
    const { label, onClose, overlay } = this.props
    return (
      <div className={`error-panel${overlay ? ' error-panel--overlay' : ''}`} role="alert">
        <div className="error-panel__card">
          <h3 className="error-panel__title">{label} a rencontré un problème</h3>
          <p className="error-panel__text">
            Le reste de Jaris fonctionne toujours. Réessaie ; si ça recommence, redémarre Jaris.
          </p>
          <p className="error-panel__detail">Détail : {message}</p>
          <div className="error-panel__actions">
            <button onClick={() => this.setState({ message: null })}>Réessayer</button>
            {onClose && <button onClick={onClose}>Fermer</button>}
          </div>
        </div>
      </div>
    )
  }
}
