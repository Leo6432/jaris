import { Fragment } from 'react'

/**
 * Le canal "chat" du prompt système (assistant.ts) autorise le modèle à utiliser du markdown léger (listes,
 * blocs de code) et il lui arrive d'utiliser **gras** même si ce n'est pas explicitement demandé — sans ça,
 * les astérisques s'affichent littéralement. Seul le gras est interprété (le reste : listes, retours à la
 * ligne, restent du texte brut géré par `white-space: pre-wrap` en CSS) : pas la peine d'une vraie
 * dépendance markdown pour un seul cas d'usage. Depuis l'étape 234 : aussi les blocs et bouts de `code`.
 *
 * Sorti de ChatPanel.tsx quand le widget texte (barre de saisie au repli, mode Chat) a eu besoin d'afficher
 * exactement les mêmes réponses : les deux écrans rendent la même donnée, donc ils doivent la formater avec
 * le même code — une deuxième copie aurait divergé au premier ajustement, comme les deux composeurs avant
 * d'être fusionnés.
 */
/** Gras et `code` dans un morceau de texte ordinaire. */
function renderInline(text: string, keyPrefix: string): JSX.Element[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`\n]+`)/g).map((part, index) => {
    const key = `${keyPrefix}-${index}`
    const bold = /^\*\*([^*]+)\*\*$/.exec(part)
    if (bold) return <strong key={key}>{bold[1]}</strong>
    const code = /^`([^`\n]+)`$/.exec(part)
    if (code) return <code key={key} className="reply-code-inline">{code[1]}</code>
    return <Fragment key={key}>{part}</Fragment>
  })
}

/**
 * Étape 234 (bêta) : les blocs de code (```…```) s'affichaient avec leurs accents graves, alors que le Chat
 * dit justement au modèle qu'il peut en écrire. Un bloc pas encore fermé (réponse en cours d'écriture) est déjà
 * montré comme du code. Le texte reste échappé par React : rien de ce que renvoie le modèle n'est interprété en HTML.
 */
export function renderFormattedText(content: string): JSX.Element {
  const pieces: JSX.Element[] = []
  const fence = /```[\w+#.-]*[ \t]*\n?([\s\S]*?)(?:```|$)/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = fence.exec(content))) {
    if (match.index > last) pieces.push(...renderInline(content.slice(last, match.index), `t${last}`))
    pieces.push(
      <pre key={`c${match.index}`} className="reply-code-block">
        <code>{match[1].replace(/\n$/, '')}</code>
      </pre>
    )
    last = fence.lastIndex
    if (match[0].length === 0) break
  }
  if (last < content.length) pieces.push(...renderInline(content.slice(last), `t${last}`))
  return <>{pieces}</>
}
