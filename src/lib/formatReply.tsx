import { Fragment } from 'react'

/**
 * Le canal "chat" du prompt système (assistant.ts) autorise le modèle à utiliser du markdown léger (listes,
 * blocs de code) et il lui arrive d'utiliser **gras** même si ce n'est pas explicitement demandé — sans ça,
 * les astérisques s'affichent littéralement. Gras, italique, titres, `code` et listes sont interprétés ; les
 * retours à la ligne restent du texte brut géré par `white-space: pre-wrap` en CSS : pas la peine d'une vraie
 * dépendance markdown pour si peu.
 *
 * Sorti de ChatPanel.tsx quand le widget texte (barre de saisie au repli, mode Chat) a eu besoin d'afficher
 * exactement les mêmes réponses : les deux écrans rendent la même donnée, donc ils doivent la formater avec
 * le même code — une deuxième copie aurait divergé au premier ajustement, comme les deux composeurs avant
 * d'être fusionnés.
 */
/**
 * Étape 339 (Léo : « dans le chat il y a encore les ** ») : l'ancien motif du gras (`\*\*[^*]+\*\*`) refusait
 * tout astérisque à l'intérieur, donc un gras qui contient de l'italique (« **les sites (c'est-à-dire *avec
 * autorisation*) sont :** ») restait affiché avec ses étoiles, et l'italique (`*…*`) ne l'était jamais. Le gras
 * accepte maintenant un astérisque seul à l'intérieur, l'italique est rendu (étoile collée au mot des deux côtés,
 * pour ne pas prendre « 3 * 4 * 5 » pour de l'italique), un titre « ### … » devient une ligne en gras, et un
 * « ** » resté sans partenaire (le modèle oublie parfois de fermer) est retiré au lieu d'être affiché.
 */
const BOLD = /(\*\*(?:[^*]|\*(?!\*))+?\*\*)/g
const CODE = /(`[^`\n]+`)/g
const ITALIC = /((?<![*\w])\*(?=[^\s*])[^*\n]*?[^\s*]\*(?![*\w])|(?<![*\w])\*[^\s*]\*(?![*\w]))/g
const HEADING = /^(#{1,6}[ \t]+.*)$/gm

/** Italique et étoiles orphelines, dans un texte sans code. */
function renderEmphasis(text: string, keyPrefix: string): JSX.Element[] {
  return text.split(ITALIC).map((part, index) => {
    const key = `${keyPrefix}-i${index}`
    if (index % 2 === 1) return <em key={key}>{part.slice(1, -1)}</em>
    return <Fragment key={key}>{part.replace(/\*\*/g, '')}</Fragment>
  })
}

/** `code` puis italique, dans un texte sans gras. */
function renderSpans(text: string, keyPrefix: string): JSX.Element[] {
  return text.split(CODE).flatMap((part, index) => {
    const key = `${keyPrefix}-c${index}`
    if (index % 2 === 1) return [<code key={key} className="reply-code-inline">{part.slice(1, -1)}</code>]
    return renderEmphasis(part, key)
  })
}

/** Gras, italique et `code` dans un morceau de texte ordinaire. */
function renderParagraph(text: string, keyPrefix: string): JSX.Element[] {
  return text.split(BOLD).flatMap((part, index) => {
    const key = `${keyPrefix}-b${index}`
    if (index % 2 === 1) return [<strong key={key}>{renderSpans(part.slice(2, -2), key)}</strong>]
    return renderSpans(part, key)
  })
}

/** Un morceau hors bloc de code : les lignes « ### Titre » deviennent une ligne en gras. */
function renderInline(text: string, keyPrefix: string): JSX.Element[] {
  return text.split(HEADING).flatMap((part, index) => {
    const key = `${keyPrefix}-h${index}`
    if (index % 2 === 1) {
      const title = part.replace(/^#{1,6}[ \t]+/, '').replace(/[ \t]+#+[ \t]*$/, '')
      return [<strong key={key}>{renderParagraph(title.replace(/^\*\*(.*)\*\*$/, '$1'), key)}</strong>]
    }
    return renderParagraph(part, key)
  })
}

/**
 * Étape 354 (design) : les listes du modèle (« - farine », « 1. Verse… ») s'affichaient avec leurs tirets et leurs
 * numéros tapés à la main, collés au texte. Elles deviennent de vraies listes (puces et numéros alignés, retrait
 * propre), comme dans ChatGPT. Une ligne vide entre deux éléments ne coupe pas la liste. Si un gras s'étale sur
 * plusieurs lignes dont une ressemble à un élément de liste (vu en vrai, étape 339), on garde l'ancien rendu plutôt
 * que de casser le gras en deux.
 */
const LIST_ITEM = /^([ \t]*)([-*•+]|\d{1,3}[.)])[ \t]+(.*)$/

interface ListItem {
  text: string
  nested: boolean
}
type Block = { kind: 'text'; lines: string[] } | { kind: 'ul' | 'ol'; start: number; items: ListItem[] }

function toBlocks(text: string): Block[] {
  const lines = text.split('\n')
  const blocks: Block[] = []
  lines.forEach((line, index) => {
    const match = LIST_ITEM.exec(line)
    const last = blocks[blocks.length - 1]
    if (match) {
      const kind = /\d/.test(match[2]) ? 'ol' : 'ul'
      const item = { text: match[3], nested: match[1].replace(/\t/g, '  ').length >= 2 }
      if (last && last.kind !== 'text' && (last.kind === kind || item.nested)) last.items.push(item)
      else blocks.push({ kind, start: kind === 'ol' ? Number.parseInt(match[2], 10) || 1 : 1, items: [item] })
      return
    }
    // Une ligne vide entre deux éléments de la même liste : la liste continue.
    if (line.trim() === '' && last && last.kind !== 'text') {
      const next = lines.slice(index + 1).find((candidate) => candidate.trim() !== '')
      const nextMatch = next === undefined ? null : LIST_ITEM.exec(next)
      if (nextMatch && (/\d/.test(nextMatch[2]) ? 'ol' : 'ul') === last.kind) return
    }
    if (last && last.kind === 'text') last.lines.push(line)
    else blocks.push({ kind: 'text', lines: [line] })
  })
  return blocks
}

/** Hors bloc de code : titres, gras, italique, `code` — et les listes. */
function renderText(text: string, keyPrefix: string): JSX.Element[] {
  const blocks = toBlocks(text)
  const balanced = blocks.every((block) => {
    const body = block.kind === 'text' ? block.lines.join('\n') : block.items.map((item) => item.text).join('\n')
    return (body.match(/\*\*/g)?.length ?? 0) % 2 === 0
  })
  if (!balanced || blocks.every((block) => block.kind === 'text')) return renderInline(text, keyPrefix)
  return blocks.flatMap((block, index) => {
    const key = `${keyPrefix}-l${index}`
    if (block.kind === 'text') {
      // La liste est un bloc : les lignes vides qui la touchent feraient un trou en plus de sa propre marge.
      const lines = [...block.lines]
      if (index > 0) while (lines.length && lines[0].trim() === '') lines.shift()
      if (index < blocks.length - 1) while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
      return lines.length ? renderInline(lines.join('\n'), key) : []
    }
    const items = block.items.map((item, itemIndex) => (
      <li key={`${key}-${itemIndex}`} className={item.nested ? 'reply-list__nested' : undefined}>
        {renderInline(item.text, `${key}-${itemIndex}`)}
      </li>
    ))
    return block.kind === 'ol'
      ? [<ol key={key} className="reply-list" start={block.start === 1 ? undefined : block.start}>{items}</ol>]
      : [<ul key={key} className="reply-list">{items}</ul>]
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
    if (match.index > last) pieces.push(...renderText(content.slice(last, match.index), `t${last}`))
    pieces.push(
      <pre key={`c${match.index}`} className="reply-code-block">
        <code>{match[1].replace(/\n$/, '')}</code>
      </pre>
    )
    last = fence.lastIndex
    if (match[0].length === 0) break
  }
  if (last < content.length) pieces.push(...renderText(content.slice(last), `t${last}`))
  return <>{pieces}</>
}
