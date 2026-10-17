import { Script } from 'vm'

/**
 * Contrôle de syntaxe du JavaScript produit par le mode Code (application générée ET fichiers d'un dépôt GitHub).
 *
 * Bug vu en vrai : une application livrée avec `function toggleAlarm(false) {` — « Unexpected token 'false' ». Une
 * seule erreur de syntaxe tue TOUT le script : aucun bouton ne marche. validateGeneratedHtml ne cherchait que des
 * motifs de texte et Jaris a présenté l'application comme terminée. Ici, le code est COMPILÉ pour de vrai par le
 * moteur JavaScript du processus principal (`new Script(code)` compile sans jamais exécuter), le même moteur (V8)
 * que celui de l'aperçu : ce qu'il refuse, le navigateur le refuserait aussi.
 *
 * Règle d'or, puisque ce contrôle tourne sur CHAQUE génération : jamais de faux positif. Dans le doute (syntaxe de
 * module qu'on ne sait pas neutraliser, erreur qui n'est pas une erreur de syntaxe, type de script inconnu), on ne
 * signale rien.
 */

export type ScriptKind = 'classic' | 'module' | 'commonjs'

export interface ScriptSyntaxProblem {
  /** Ligne fautive dans le code vérifié (1 = première ligne), `null` si le moteur ne l'a pas donnée. */
  line: number | null
  /** Le message du moteur, tel quel (en anglais : « Unexpected token 'false' »). */
  message: string
  /** La ligne fautive telle qu'écrite (coupée si très longue), vide si inconnue. */
  sourceLine: string
}

export interface InlineScript {
  /** Numéro du script parmi les scripts JavaScript écrits dans la page (1 = le premier). */
  index: number
  kind: 'classic' | 'module'
  code: string
  /** Ligne du fichier où commence le contenu du script (1 = première ligne du fichier). */
  startLine: number
}

export interface InlineScriptProblem extends ScriptSyntaxProblem {
  /** Numéro du script dans la page (voir InlineScript.index). */
  script: number
  /** Ligne fautive dans le FICHIER entier, `null` si inconnue. */
  fileLine: number | null
}

/** Nom donné au code compilé : le moteur le recopie en tête de sa pile d'erreur, suivi du numéro de ligne. */
const CHECK_FILENAME = 'jaris-syntax-check.js'
const LOCATION = /^jaris-syntax-check\.js:(\d+)/
const MAX_SOURCE_LINE = 160

/**
 * Types de `<script>` que le navigateur exécute comme du JavaScript classique (« JavaScript MIME type essence
 * match » de la norme HTML). Tout autre type (application/json, text/template, text/babel…) est une donnée que le
 * navigateur n'exécute pas : jamais compilé ici.
 */
const CLASSIC_TYPES = new Set([
  '',
  'application/ecmascript',
  'application/javascript',
  'application/x-ecmascript',
  'application/x-javascript',
  'text/ecmascript',
  'text/javascript',
  'text/javascript1.0',
  'text/javascript1.1',
  'text/javascript1.2',
  'text/javascript1.3',
  'text/javascript1.4',
  'text/javascript1.5',
  'text/jscript',
  'text/livescript',
  'text/x-ecmascript',
  'text/x-javascript'
])

/** Découpe comme le moteur : \r\n, \r, \n, et les deux séparateurs Unicode comptent chacun pour une ligne. */
function splitLines(code: string): string[] {
  return code.split(/\r\n|[\n\r\u2028\u2029]/)
}

function countFileLineBreaks(text: string): number {
  return (text.match(/\r\n|\r|\n/g) ?? []).length
}

function excerpt(line: string): string {
  const trimmed = line.trim()
  return trimmed.length > MAX_SOURCE_LINE ? `${trimmed.slice(0, MAX_SOURCE_LINE)}…` : trimmed
}

/**
 * Compile `prefix + code + suffix` sans l'exécuter. `prefix` ne doit contenir qu'UN retour à la ligne (à la fin) :
 * la ligne rapportée par le moteur est ramenée à celle du code d'origine.
 */
function compile(code: string, original: string, prefix = '', suffix = ''): ScriptSyntaxProblem | null {
  try {
    new Script(prefix + code + suffix, { filename: CHECK_FILENAME })
    return null
  } catch (err) {
    // Seule une vraie erreur de syntaxe compte : un débordement de pile du compilateur sur un code très imbriqué,
    // par exemple, ne dit rien de la validité du code.
    if ((err as { name?: string } | null)?.name !== 'SyntaxError') return null
    let message = String((err as { message?: unknown }).message ?? '').trim()
    const located = LOCATION.exec(String((err as { stack?: unknown }).stack ?? ''))
    const lines = splitLines(original)
    let line: number | null = null
    if (located) {
      const reported = Number(located[1]) - (prefix ? countFileLineBreaks(prefix) : 0)
      if (reported > lines.length) {
        // L'erreur tombe sur la fin ajoutée autour du code (« }) ») : le code s'arrête avant d'être complet (accolade,
        // parenthèse ou chaîne jamais fermée). Le moteur se plaint alors de cette fin ajoutée, ce qui ne voudrait rien
        // dire pour le modèle : c'est ce que dirait le navigateur qui est rapporté, sur la dernière ligne écrite.
        message = 'Unexpected end of input'
        const lastWritten = lines.findLastIndex((text) => text.trim() !== '')
        line = lastWritten === -1 ? lines.length : lastWritten + 1
      } else {
        line = Math.max(reported, 1)
      }
    }
    return { line, message, sourceLine: line === null ? '' : excerpt(lines[line - 1] ?? '') }
  }
}

/** Remplace un passage en gardant ses retours à la ligne (les numéros de ligne restent ceux du code d'origine). */
function keepLines(text: string, replacement: string): string {
  return replacement + (text.match(/\r\n|\r|\n/g) ?? []).join('')
}

/**
 * Rend un module ES compilable comme le corps d'une fonction asynchrone (approche retenue pour type="module",
 * le moteur ne sachant pas compiler un module sans l'option expérimentale de Node) :
 *  - les déclarations `import … from '…'` / `import '…'` et `export { … }` / `export * from '…'` deviennent `;`
 *    (une instruction vide : ne colle jamais deux instructions qui doivent rester séparées) ;
 *  - `export default …` devient `void …`, et `export const/let/var/function/class/async` perd son `export` ;
 *  - `import.meta` devient un simple identifiant.
 * Le corps est ensuite compilé en mode strict (un module l'est toujours) dans une fonction asynchrone, ce qui rend
 * `await` valide au premier niveau. Chaque ligne retouchée est notée : une erreur qui y tombe n'est jamais signalée.
 */
function neutralizeModuleSyntax(code: string): { code: string; touchedLines: Set<number> } {
  const touched = new Set<number>()
  const mark = (offset: number, text: string): void => {
    const first = countFileLineBreaks(code.slice(0, offset)) + 1
    const last = first + countFileLineBreaks(text)
    for (let line = first; line <= last; line += 1) touched.add(line)
  }
  const rewrite = (pattern: RegExp, replace: (match: string, ...groups: string[]) => string) => {
    code = code.replace(pattern, (match: string, ...rest: unknown[]) => {
      const offset = rest.find((value) => typeof value === 'number') as number
      mark(offset, match)
      return replace(match, ...(rest.filter((value) => typeof value === 'string') as string[]))
    })
  }

  // import.meta n'existe que dans un module : un identifiant le remplace sans rien changer à la syntaxe autour.
  rewrite(/\bimport\s*\.\s*meta\b/g, (match) => keepLines(match, '_jarisImportMeta'))
  // Déclarations d'import statiques (jamais l'import dynamique `import(…)`, valide partout).
  rewrite(
    /^[ \t]*import(?=[\s{*'"])\s*(?:[\w$]+\s*,?\s*)?(?:\*\s*as\s+[\w$]+\s*|\{[^{}]*\}\s*)?(?:from\s*)?(["'])[^"'\r\n]*\1[ \t]*(?:(?:with|assert)\s*\{[^{}]*\}[ \t]*)?;?/gm,
    (match) => keepLines(match, ';')
  )
  // export { a, b as c } [from '…'] ; export * [as ns] from '…'
  rewrite(
    /^[ \t]*export\s*(?:\*\s*(?:as\s+[\w$]+\s*)?|\{[^{}]*\}\s*)(?:from\s*(["'])[^"'\r\n]*\1[ \t]*(?:(?:with|assert)\s*\{[^{}]*\}[ \t]*)?)?;?/gm,
    (match) => keepLines(match, ';')
  )
  rewrite(/^([ \t]*)export\s+default\b/gm, (match, indent) => keepLines(match, `${indent}void`))
  rewrite(/^([ \t]*)export\s+(?=(?:const|let|var|function|class|async)\b)/gm, (match, indent) => keepLines(match, indent))
  return { code, touchedLines: touched }
}

/**
 * Compile un code JavaScript sans l'exécuter. `null` = pas d'erreur de syntaxe certaine.
 *  - classic : script de page ordinaire ;
 *  - module : `<script type="module">` ou fichier .mjs (voir neutralizeModuleSyntax) ;
 *  - commonjs : fichier .cjs (Node l'enveloppe dans une fonction : `return` au premier niveau y est valide).
 */
export function checkJavaScriptSyntax(code: string, kind: ScriptKind): ScriptSyntaxProblem | null {
  // Une ligne « #! » en tête (script Node) est valide : remplacée par un commentaire de même longueur.
  const source = code.startsWith('#!') ? `//${code.slice(2)}` : code
  if (kind === 'classic') return compile(source, code)
  if (kind === 'commonjs') return compile(source, code, '(function (exports, require, module, __filename, __dirname) {\n', '\n})')

  const neutral = neutralizeModuleSyntax(source)
  const problem = compile(neutral.code, code, "'use strict';(async function () {\n", '\n})')
  if (!problem) return null
  // Une syntaxe de module restée hors de portée du remplacement (import/export écrit sur la même ligne qu'autre
  // chose…) : le moteur s'en plaint, mais le navigateur, lui, l'accepterait. Jamais signalé.
  if (/\b(?:import|export)\b|outside a module/i.test(problem.message)) return null
  if (problem.line !== null && neutral.touchedLines.has(problem.line)) return null
  return problem
}

/** Attributs d'une balise ouvrante ; le premier exemplaire d'un attribut l'emporte, comme dans le navigateur. */
function parseAttributes(raw: string): Map<string, string> {
  const attributes = new Map<string, string>()
  for (const match of raw.matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const name = match[1].toLowerCase()
    if (!attributes.has(name)) attributes.set(name, match[2] ?? match[3] ?? match[4] ?? '')
  }
  return attributes
}

/**
 * Les scripts JavaScript écrits DANS la page, que le navigateur exécuterait : ni `<script src>` (son contenu est
 * ignoré), ni un type de données (application/json, text/template…), ni un script mis en commentaire HTML. Le
 * contenu d'un script s'arrête au premier `</script`, exactement comme dans le navigateur.
 */
export function findInlineScripts(html: string): InlineScript[] {
  const scripts: InlineScript[] = []
  const scanner = /<!--|<script(?=[\s/>])((?:[^>"']|"[^"]*"|'[^']*')*)>/gi
  const closer = /<\/script[\s/>]/gi
  let index = 0
  for (let match = scanner.exec(html); match; match = scanner.exec(html)) {
    if (match[0] === '<!--') {
      const end = html.indexOf('-->', match.index + 4)
      if (end === -1) break
      scanner.lastIndex = end + 3
      continue
    }
    const contentStart = match.index + match[0].length
    closer.lastIndex = contentStart
    const close = closer.exec(html)
    // Script jamais fermé : déjà signalé par le contrôle des balises <script> appariées.
    if (!close) break
    scanner.lastIndex = close.index + 8
    const attributes = parseAttributes(match[1])
    if (attributes.has('src')) continue
    const language = attributes.get('language')
    const type = (attributes.get('type') ?? (language ? `text/${language}` : '')).trim().toLowerCase()
    const kind = type === 'module' ? 'module' : CLASSIC_TYPES.has(type) ? 'classic' : null
    if (!kind) continue
    index += 1
    scripts.push({
      index,
      kind,
      code: html.slice(contentStart, close.index),
      startLine: countFileLineBreaks(html.slice(0, contentStart)) + 1
    })
  }
  return scripts
}

/** Les erreurs de syntaxe des scripts écrits dans la page, une par script fautif. */
export function findInlineScriptSyntaxErrors(html: string): InlineScriptProblem[] {
  const problems: InlineScriptProblem[] = []
  for (const script of findInlineScripts(html)) {
    if (!script.code.trim()) continue
    const problem = checkJavaScriptSyntax(script.code, script.kind)
    if (!problem) continue
    problems.push({ ...problem, script: script.index, fileLine: problem.line === null ? null : script.startLine + problem.line - 1 })
  }
  return problems
}

/** Un fichier vérifiable : JavaScript (.js, .mjs, .cjs) ou page web (.html, .htm, scripts écrits dedans). */
export function isSyntaxCheckedFile(path: string): boolean {
  return /\.(?:m?js|cjs|html?)$/i.test(path)
}

/**
 * Erreurs de syntaxe d'un fichier de dépôt. Un .js peut être un script de page, un fichier Node (CommonJS) ou un
 * module : il n'est fautif que s'il ne compile dans AUCUN des trois cas.
 */
export function fileSyntaxProblems(path: string, content: string): InlineScriptProblem[] {
  if (/\.html?$/i.test(path)) return findInlineScriptSyntaxErrors(content)
  if (!/\.(?:m?js|cjs)$/i.test(path) || !content.trim()) return []
  let problem: ScriptSyntaxProblem | null
  if (/\.mjs$/i.test(path)) problem = checkJavaScriptSyntax(content, 'module')
  else if (/\.cjs$/i.test(path)) problem = checkJavaScriptSyntax(content, 'commonjs')
  else {
    const classic = checkJavaScriptSyntax(content, 'classic')
    const commonjs = classic && checkJavaScriptSyntax(content, 'commonjs')
    const module = commonjs && checkJavaScriptSyntax(content, 'module')
    // Un module avec une vraie erreur : le script classique, lui, bute d'abord sur le premier import. C'est l'erreur
    // du module qui dit où est le vrai problème.
    problem = classic && module ? (/\b(?:import|export|await)\b|outside a module/i.test(classic.message) ? module : classic) : null
  }
  return problem ? [{ ...problem, script: 1, fileLine: problem.line }] : []
}

/**
 * Le changement préparé par l'agent de dépôt a-t-il CASSÉ ce fichier ? Prudent par construction, parce qu'un dépôt
 * peut utiliser une syntaxe qu'un navigateur ne lit pas tel quel (JSX, Flow, décorateurs, passés par un outil de
 * compilation) :
 *  - si la version de GitHub ne compilait déjà pas, rien n'est signalé (on ne sait pas l'attribuer à l'agent) ;
 *  - un NOUVEAU fichier .js n'est pas signalé pour une erreur typique de ces syntaxes (`<` de JSX, `:` d'annotation
 *    de type, ligne qui commence par `@`).
 */
export function brokenScriptAfterChange(path: string, content: string, original: string | null | undefined): InlineScriptProblem | null {
  const problems = fileSyntaxProblems(path, content)
  if (problems.length === 0) return null
  if (typeof original === 'string') return fileSyntaxProblems(path, original).length > 0 ? null : problems[0]
  if (/\.html?$/i.test(path)) return problems[0]
  const problem = problems[0]
  if (/Unexpected token '[<:]'/.test(problem.message) || problem.sourceLine.startsWith('@')) return null
  return problem
}
