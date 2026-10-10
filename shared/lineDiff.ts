/**
 * Différence ligne à ligne entre deux versions d'un fichier (mode Code → dépôt GitHub, étape 277).
 *
 * Jaris ne doit JAMAIS enregistrer sur GitHub un changement que Léo n'a pas vu : ce calcul est ce qu'il lit
 * avant de cliquer sur « Enregistrer ». Partagé entre le main (le journal dit « +3 −1 ») et l'écran (les lignes
 * en vert et en rouge), donc une fonction pure, sans dépendance, testée à part.
 *
 * Algorithme : on retire d'abord le début et la fin communs (le cas courant : quelques lignes changées au
 * milieu d'un long fichier), puis plus longue sous-suite commune sur ce qui reste. Si ce reste est énorme,
 * on renonce au calcul fin : tout le milieu est montré comme retiré puis ajouté — un affichage moins joli,
 * jamais faux, et sans geler l'écran sur un fichier réécrit de bout en bout.
 */

export interface DiffLine {
  kind: 'same' | 'add' | 'del'
  text: string
  /** Numéro dans l'ancienne version (lignes « same » et « del »). */
  oldNo?: number
  /** Numéro dans la nouvelle version (lignes « same » et « add »). */
  newNo?: number
}

export interface DiffHunk {
  lines: DiffLine[]
}

export interface LineDiff {
  hunks: DiffHunk[]
  added: number
  removed: number
}

/** Au-delà de ce produit (lignes anciennes × nouvelles du milieu), plus de calcul fin. */
const MAX_LCS_CELLS = 4_000_000

/** Lignes d'un texte, sans les retours chariot Windows (un fichier CRLF ne doit pas sembler changé partout). */
export function splitLines(text: string | null): string[] {
  if (text === null || text === '') return []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  // Le saut de ligne final ne crée pas une ligne vide de plus.
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

type Op = { kind: 'same' | 'add' | 'del'; text: string }

function middleOps(a: string[], b: string[]): Op[] {
  if (a.length === 0) return b.map((text) => ({ kind: 'add', text }))
  if (b.length === 0) return a.map((text) => ({ kind: 'del', text }))
  if (a.length * b.length > MAX_LCS_CELLS) {
    return [...a.map((text): Op => ({ kind: 'del', text })), ...b.map((text): Op => ({ kind: 'add', text }))]
  }
  const n = a.length
  const m = b.length
  // lcs[i][j] = longueur de la plus longue sous-suite commune de a[i..] et b[j..], à plat.
  const width = m + 1
  const lcs = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i * width + j] = a[i] === b[j] ? lcs[(i + 1) * width + j + 1] + 1 : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1])
    }
  }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'same', text: a[i] })
      i += 1
      j += 1
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
      ops.push({ kind: 'del', text: a[i] })
      i += 1
    } else {
      ops.push({ kind: 'add', text: b[j] })
      j += 1
    }
  }
  while (i < n) ops.push({ kind: 'del', text: a[i++] })
  while (j < m) ops.push({ kind: 'add', text: b[j++] })
  return ops
}

/**
 * `before` à `null` : fichier créé. `after` à `null` : fichier supprimé. `context` : lignes inchangées gardées
 * autour de chaque changement (3, comme `git diff`).
 */
export function diffLines(before: string | null, after: string | null, context = 3): LineDiff {
  const a = splitLines(before)
  const b = splitLines(after)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1
    endB -= 1
  }

  const ops: Op[] = [
    ...a.slice(0, start).map((text): Op => ({ kind: 'same', text })),
    ...middleOps(a.slice(start, endA), b.slice(start, endB)),
    ...a.slice(endA).map((text): Op => ({ kind: 'same', text }))
  ]

  // Numérotation, puis découpage en blocs autour des changements.
  const lines: DiffLine[] = []
  let oldNo = 0
  let newNo = 0
  let added = 0
  let removed = 0
  for (const op of ops) {
    if (op.kind === 'same') lines.push({ kind: 'same', text: op.text, oldNo: ++oldNo, newNo: ++newNo })
    else if (op.kind === 'del') {
      removed += 1
      lines.push({ kind: 'del', text: op.text, oldNo: ++oldNo })
    } else {
      added += 1
      lines.push({ kind: 'add', text: op.text, newNo: ++newNo })
    }
  }

  const keep = new Array<boolean>(lines.length).fill(false)
  lines.forEach((line, index) => {
    if (line.kind === 'same') return
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k += 1) keep[k] = true
  })

  const hunks: DiffHunk[] = []
  let current: DiffLine[] | null = null
  lines.forEach((line, index) => {
    if (!keep[index]) {
      current = null
      return
    }
    if (!current) {
      current = []
      hunks.push({ lines: current })
    }
    current.push(line)
  })

  return { hunks, added, removed }
}
