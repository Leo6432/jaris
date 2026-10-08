import logo from '@/assets/jaris-logo-64.png'

/**
 * Écran vide d'un mode (maquette Jaris.dc.html) : le logo, une question, une phrase qui dit ce que le mode
 * sait faire, puis quelques suggestions en pastilles — comme l'accueil de ChatGPT. Un seul composant pour
 * Chat, Code, Image et Vidéo, pour que les quatre accueils se ressemblent par construction.
 */
export default function EmptyState({
  title,
  description,
  suggestions = [],
  onSuggestion,
  children
}: {
  title: string
  description: string
  suggestions?: string[]
  onSuggestion?: (text: string) => void
  /** Contenu en plus sous les suggestions (vignettes des dernières images/vidéos). */
  children?: React.ReactNode
}): JSX.Element {
  return (
    <div className="empty-state">
      <img className="empty-state__logo" src={logo} alt="" />
      <h1 className="empty-state__title">{title}</h1>
      <p className="empty-state__description">{description}</p>
      {suggestions.length > 0 && onSuggestion && (
        <div className="empty-state__suggestions">
          {suggestions.map((text) => (
            <button key={text} type="button" className="empty-state__suggestion" onClick={() => onSuggestion(text)}>
              {text}
            </button>
          ))}
        </div>
      )}
      {children}
    </div>
  )
}
