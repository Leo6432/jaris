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
        // Un script classique qui s'arrête trop tôt (accolade jamais fermée) et finit par un retour à la ligne — presque
        // tous les <script> générés : le moteur désigne la dernière ligne, VIDE. Même règle que pour la fin ajoutée :
        // la dernière ligne écrite, pour que le modèle reçoive la ligne fautive et l'utilisateur la bonne ligne.
        if (message === 'Unexpected end of input' && !(lines[line - 1] ?? '').trim()) {
          const lastWritten = lines.slice(0, line).findLastIndex((text) => text.trim() !== '')
          if (lastWritten !== -1) line = lastWritten + 1
        }
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
 *  - `import.meta` devient un simple identifiant ;
 *  - `export const/let/var/function/class/async` perd son `export` ;
 *  - `export default function f`/`class A` perd son `export default` (la déclaration RESTE une déclaration, comme
 *    dans le module), une fonction ou une classe anonyme y reçoit un nom (`_jarisDefault`), et toute autre valeur
 *    devient `const _jarisDefault = …` (jamais `void …`, qui refuserait une fonction fléchée : faux positif).
 * Le corps est ensuite compilé en mode strict (un module l'est toujours) dans une fonction asynchrone, ce qui rend
 * `await` valide au premier niveau.
 *
 * Seules les lignes RÉÉCRITES (imports, `export {…}`/`export *`, `import.meta`) sont notées : une erreur qui y tombe
 * n'est jamais signalée. Celles dont on a seulement retiré `export`/`export default` gardent le reste de leur
 * syntaxe intact et restent contrôlées — sinon `export function toggleAlarm(false) {}`, le cas réel avec un
 * `export` devant, passerait sans rien dire.
 */
function neutralizeModuleSyntax(code: string): { code: string; touchedLines: Set<number> } {
  const touched = new Set<number>()
  const mark = (offset: number, text: string): void => {
    const first = countFileLineBreaks(code.slice(0, offset)) + 1
    const last = first + countFileLineBreaks(text)
    for (let line = first; line <= last; line += 1) touched.add(line)
  }
  const rewrite = (pattern: RegExp, replace: (match: string, ...groups: (string | undefined)[]) => string, rewritten = true) => {
    code = code.replace(pattern, (match: string, ...rest: unknown[]) => {
      const at = rest.findIndex((value) => typeof value === 'number')
      if (rewritten) mark(rest[at] as number, match)
      return replace(match, ...(rest.slice(0, at) as (string | undefined)[]))
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
  // export default function () / function* () / async function () / class {…} / class extends : déclaration
  // anonyme, qui n'a de sens que dans un module — un nom la rend valide ailleurs, sans rien changer d'autre.
  rewrite(
    /^([ \t]*)export\s+default\s+((?:async\s+)?function\b\s*\*?)(?=\s*\()/gm,
    (match, indent, keyword) => keepLines(match, `${indent}${(keyword ?? '').replace(/\s+/g, ' ')} _jarisDefault`),
    false
  )
  rewrite(/^([ \t]*)export\s+default\s+class\b(?=\s*(?:\{|extends\b))/gm, (match, indent) => keepLines(match, `${indent}class _jarisDefault`), false)
  // export default function f / class A : la déclaration reste une déclaration (même lecture qu'en module).
  rewrite(/^([ \t]*)export\s+default\s+(?=(?:async\s+)?function\b|class\b)/gm, (match, indent) => keepLines(match, indent ?? ''), false)
  // export default <valeur> : la même expression, derrière une déclaration de constante.
  rewrite(/^([ \t]*)export\s+default\b/gm, (match, indent) => keepLines(match, `${indent}const _jarisDefault =`), false)
  rewrite(/^([ \t]*)export\s+(?=(?:const|let|var|function|class|async)\b)/gm, (match, indent) => keepLines(match, indent ?? ''), false)
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
  // Un message qui parle des noms ajoutés ici (`_jarisDefault`…) ne concerne pas le code écrit : jamais signalé non plus.
  if (/\b(?:import|export)\b|outside a module|_jaris/i.test(problem.message)) return null
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
 * Zones de la page dont le contenu n'est JAMAIS exécuté comme un script, même s'il contient `<script>` :
 *  - texte brut pour le navigateur (textarea, title, style, xmp, iframe, noembed, noframes, et noscript puisque les
 *    scripts sont actifs dans l'aperçu) : il s'arrête au premier `</nom`, comme dans le navigateur ;
 *  - `<template>` : contenu inerte tant que la page ne le recopie pas elle-même ;
 *  - `<svg>`/`<math>` : un script SVG est lu comme du XML (`<![CDATA[`, entités `&lt;`…) — compiler son texte brut
 *    donnerait de fausses erreurs, il n'est donc pas vérifié.
 * Compiler ces contenus déclencherait pour rien une réparation (le modèle risquant de « corriger » du code juste),
 * puis un faux avertissement à l'utilisateur, à chaque génération et à chaque réouverture.
 */
const RAW_TEXT_ELEMENTS = new Set(['textarea', 'title', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript'])
const NESTED_INERT_ELEMENTS = new Set(['template', 'svg', 'math'])
const TAG_ATTRIBUTES = `(?:[^>"']|"[^"]*"|'[^']*')*`

/** Fin d'une zone inerte ouverte juste avant `from` (index après sa balise fermante), `-1` si elle ne se ferme jamais. */
function inertZoneEnd(html: string, name: string, from: number): number {
  if (RAW_TEXT_ELEMENTS.has(name)) {
    const close = new RegExp(`</${name}(?=[\\s/>])${TAG_ATTRIBUTES}>`, 'gi')
    close.lastIndex = from
    const found = close.exec(html)
    return found ? found.index + found[0].length : -1
  }
  // template, svg, math : peuvent s'imbriquer (un <svg> dans un <svg>) ; un <svg …/> se ferme tout seul.
  const tag = new RegExp(`<(/?)${name}(?=[\\s/>])${TAG_ATTRIBUTES}>`, 'gi')
  tag.lastIndex = from
  let depth = 1
  for (let found = tag.exec(html); found; found = tag.exec(html)) {
    if (found[1]) depth -= 1
    else if (!(name !== 'template' && found[0].endsWith('/>'))) depth += 1
    if (depth === 0) return found.index + found[0].length
  }
  return -1
}

/**
 * Les scripts JavaScript écrits DANS la page, que le navigateur exécuterait : ni `<script src>` (son contenu est
 * ignoré), ni un type de données (application/json, text/template…), ni un script mis en commentaire HTML ou placé
 * dans une zone inerte (voir RAW_TEXT_ELEMENTS). Le contenu d'un script s'arrête au premier `</script`, exactement
 * comme dans le navigateur.
 */
export function findInlineScripts(html: string): InlineScript[] {
  const scripts: InlineScript[] = []
  // Toute autre balise est lue d'un bloc, attributs compris : un `<script>` écrit DANS la valeur d'un attribut
  // (`<input value="<script>…">`, `<iframe srcdoc="…">`) n'est jamais pris pour un vrai script.
  const scanner = new RegExp(
    `<!--|<(script|${[...RAW_TEXT_ELEMENTS, ...NESTED_INERT_ELEMENTS].join('|')})(?=[\\s/>])(${TAG_ATTRIBUTES})>|<[a-z][^\\s/>]*${TAG_ATTRIBUTES}>`,
    'gi'
  )
  const closer = /<\/script[\s/>]/gi
  let index = 0
  for (let match = scanner.exec(html); match; match = scanner.exec(html)) {
    if (match[0] === '<!--') {
      const end = html.indexOf('-->', match.index + 4)
      if (end === -1) break
      scanner.lastIndex = end + 3
      continue
    }
    if (!match[1]) continue
    const name = match[1].toLowerCase()
    const contentStart = match.index + match[0].length
    if (name !== 'script') {
      // <svg …/> ou <math …/> : élément vide, rien à sauter.
      if ((name === 'svg' || name === 'math') && match[0].endsWith('/>')) continue
      const end = inertZoneEnd(html, name, contentStart)
      // Jamais refermée : pour le navigateur, tout le reste de la page en fait partie.
      if (end === -1) break
      scanner.lastIndex = end
      continue
    }
    closer.lastIndex = contentStart
    const close = closer.exec(html)
    // Script jamais fermé : déjà signalé par le contrôle des balises <script> appariées.
    if (!close) break
    scanner.lastIndex = close.index + 8
    const attributes = parseAttributes(match[2])
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

function inlineScriptProblems(html: string, skip?: (script: InlineScript) => boolean): InlineScriptProblem[] {
  const problems: InlineScriptProblem[] = []
  for (const script of findInlineScripts(html)) {
    if (!script.code.trim() || skip?.(script)) continue
    const problem = checkJavaScriptSyntax(script.code, script.kind)
    if (!problem) continue
    problems.push({ ...problem, script: script.index, fileLine: problem.line === null ? null : script.startLine + problem.line - 1 })
  }
  return problems
}

/** Les erreurs de syntaxe des scripts écrits dans la page, une par script fautif. */
export function findInlineScriptSyntaxErrors(html: string): InlineScriptProblem[] {
  return inlineScriptProblems(html)
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
 * Marques d'un moteur de gabarits côté serveur, qui remplit la page AVANT que le navigateur la lise (Jinja, Django,
 * Liquid, Go, Handlebars : `{{ }}`, `{% %}`, `{# #}` ; EJS, ERB : `<% %>` ; PHP : `<?` ; Razor : `@{` ; Thymeleaf :
 * `[[${…}]]`, `[(${…})]`). Un script qui en contient n'est pas du JavaScript tel quel : jamais compilé dans un dépôt.
 * (Le simple `[[` n'en fait pas partie : c'est aussi un tableau de tableaux, très courant en JavaScript.)
 */
const TEMPLATE_MARKERS = /\{\{|\{%|\{#|<%|%>|<\?|@\{|\[[[(]\s*[$*#@~]\{/
/** Ligne typique d'une syntaxe passée par un outil de compilation : décorateur, déclaration de type Flow. */
const TOOL_SYNTAX_LINE = /^(?:@|(?:export\s+)?(?:type|interface|opaque\s+type|declare)\b|import\s+type\b)/

/**
 * Un .js de dépôt peut contenir une syntaxe qu'un navigateur ne lit pas tel quel, mais qu'un outil transforme avant
 * (JSX, Flow, décorateurs, gabarits Jekyll) : une erreur typique de ces syntaxes n'est jamais reprochée, que le
 * fichier soit nouveau ou non (ajouter du JSX à un .js qui n'en avait pas reste valide dans un projet React).
 */
function looksCompiledByATool(problem: ScriptSyntaxProblem, content: string): boolean {
  return (
    /Unexpected token '[<:?]'/.test(problem.message) ||
    TOOL_SYNTAX_LINE.test(problem.sourceLine) ||
    TEMPLATE_MARKERS.test(problem.sourceLine) ||
    /@flow\b/.test(content) ||
    // En-tête Jekyll (« --- » en première ligne) : le fichier est un gabarit, rempli avant d'être servi.
    /^---[ \t]*(?:\r?\n|$)/.test(content)
  )
}

/** L'erreur à reprocher dans un fichier de dépôt, en écartant gabarits et syntaxes d'outils (voir ci-dessus). */
function repoFileProblem(path: string, content: string): InlineScriptProblem | null {
  if (/\.html?$/i.test(path)) return inlineScriptProblems(content, (script) => TEMPLATE_MARKERS.test(script.code))[0] ?? null
  const [problem] = fileSyntaxProblems(path, content)
  return problem && !looksCompiledByATool(problem, content) ? problem : null
}

/**
 * Le changement préparé par l'agent de dépôt a-t-il CASSÉ ce fichier ? Prudent par construction, parce qu'un dépôt
 * peut utiliser une syntaxe qu'un navigateur ne lit pas tel quel :
 *  - un script de page qui contient des marques de gabarit serveur (`{{ }}`, `{% %}`, `<% %>`…) n'est pas compilé ;
 *  - une erreur typique de JSX, Flow, décorateurs ou gabarit Jekyll n'est jamais reprochée (voir looksCompiledByATool) ;
 *  - si la version de GitHub ne compilait déjà pas, rien n'est signalé (on ne sait pas l'attribuer à l'agent).
 * Dans le doute, rien : un faux reproche ferait « corriger » au modèle du code juste (retirer la syntaxe du gabarit),
 * puis arrêter le travail avec un faux message d'échec.
 */
export function brokenScriptAfterChange(path: string, content: string, original: string | null | undefined): InlineScriptProblem | null {
  const problem = repoFileProblem(path, content)
  if (!problem) return null
  if (typeof original === 'string' && fileSyntaxProblems(path, original).length > 0) return null
  return problem
}
