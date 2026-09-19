import { Fragment } from 'react'

/**
 * Le canal "chat" du prompt système (assistant.ts) autorise le modèle à utiliser du markdown léger (listes,
 * blocs de code) et il lui arrive d'utiliser **gras** même si ce n'est pas explicitement demandé — sans ça,
 * les astérisques s'affichent littéralement. Seul le gras est interprété (le reste : listes, retours à la
 * ligne, restent du texte brut géré par `white-space: pre-wrap` en CSS) : pas la peine d'une vraie
 * dépendance markdown pour un seul cas d'usage.
 *
 * Sorti de ChatPanel.tsx quand le widget texte (barre de saisie au repli, mode Chat) a eu besoin d'afficher
 * exactement les mêmes réponses : les deux écrans rendent la même donnée, donc ils doivent la formater avec
 * le même code — une deuxième copie aurait divergé au premier ajustement, comme les deux composeurs avant
 * d'être fusionnés.
 */
export function renderFormattedText(content: string): JSX.Element {
  const parts = content.split(/(\*\*[^*]+\*\*)/g)
  return (
    <>
      {parts.map((part, index) => {
        const match = /^\*\*([^*]+)\*\*$/.exec(part)
        return match ? <strong key={index}>{match[1]}</strong> : <Fragment key={index}>{part}</Fragment>
      })}
    </>
  )
}
