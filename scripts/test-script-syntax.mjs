import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Bug vu en vrai : le mode Code a livré une application avec `function toggleAlarm(false) {` — « Unexpected token
 * 'false' ». Tout le script était mort, aucun bouton ne marchait, et Jaris l'a présentée comme terminée. Le contrôle
 * compile désormais chaque script pour de vrai (sans l'exécuter). Il tourne sur CHAQUE génération : ces tests
 * verrouillent autant les vraies erreurs trouvées que l'absence de faux positif sur du JavaScript valide et moderne.
 */
const syntax = loadTsModule('electron/services/scriptSyntax.ts', { vm })

test("le cas réel `function toggleAlarm(false) {` est trouvé, avec sa ligne et la ligne fautive", () => {
  const problem = syntax.checkJavaScriptSyntax("let alarme = false\nfunction toggleAlarm(false) {\n  alarme = !alarme\n}\n", 'classic')
  assert.equal(problem.line, 2)
  assert.equal(problem.message, "Unexpected token 'false'")
  assert.equal(problem.sourceLine, 'function toggleAlarm(false) {')
})

const MODERN = `
class Horloge {
  #alarme = null
  static instances = 0
  constructor(el) { this.el = el; Horloge.instances++ }
  get heure() { return new Date().toLocaleTimeString('fr-FR') }
  async demarrer() {
    for await (const t of this.ticks()) this.el.textContent = \`Il est \${t} — \${this.#alarme ?? "pas d'alarme"}\`
  }
  async *ticks() { while (true) { yield this.heure; await new Promise((r) => setTimeout(r, 1000)) } }
}
const re = /^(\\d{2}):(\\d{2})$/u
const ok = (v) => re.test(v) && v?.length > 0 && !/[<>]/.test(v)
const [h = 0, m = 0] = '12:30'.split(':').map(Number)
let x = null
x ??= 3
x ||= 4
const total = [1, 2, 3].reduce((a, b) => a + b, 0) / 2
const big = 10n ** 3n
const objet = { ...{ a: 1 }, [\`cle\${h}\`]: m, methode() { return this?.a } }
label: for (const i of [1, 2]) { if (i) continue label }
try { JSON.parse('{') } catch { /* rien */ }
document.querySelector('#go')?.addEventListener('click', async () => { await new Horloge(document.body).demarrer() })
`

test('du JavaScript valide et moderne ne déclenche jamais rien (classes, async, gabarits, regex, ?. ??)', () => {
  assert.equal(syntax.checkJavaScriptSyntax(MODERN, 'classic'), null)
  assert.equal(syntax.checkJavaScriptSyntax(MODERN, 'module'), null)
  // Commentaire HTML historique et ligne « #! » : valides pour le navigateur et pour Node.
  assert.equal(syntax.checkJavaScriptSyntax('<!-- ancien navigateur\nvar a = 1\n--> fin', 'classic'), null)
  assert.equal(syntax.checkJavaScriptSyntax('#!/usr/bin/env node\nvar a = 1', 'classic'), null)
})

test('type="module" : import, export, await et import.meta au premier niveau ne sont jamais signalés', () => {
  const module = [
    "import { a, b as c } from './x.js'",
    "import * as ns from 'y'",
    'import d, { e } from "z"',
    "import './effet.js'",
    "import donnees from './d.json' with { type: 'json' }",
    'import {',
    '  f,',
    '  g',
    "} from 'h'",
    'const reponse = await fetch(import.meta.url)',
    'for await (const morceau of []) {}',
    'export const k = 1',
    'export async function charger() { return await reponse.json() }',
    'export class Jeu {}',
    'export default function () {}',
    'export { k as kk }',
    "export * from 'w'",
    "export * as tout from 'w'",
    "const module = await import('./dynamique.js')"
  ].join('\n')
  assert.equal(syntax.checkJavaScriptSyntax(module, 'module'), null)
  assert.equal(syntax.checkJavaScriptSyntax('export default {\n  a: 1\n}\n', 'module'), null)
  // Remplacer un import ne doit jamais coller deux instructions : /re/ redeviendrait une division.
  assert.equal(syntax.checkJavaScriptSyntax("let a = 1\nimport x from 'y'\n/re/.test('s')", 'module'), null)
  assert.equal(syntax.checkJavaScriptSyntax("#!/usr/bin/env node\nimport fs from 'fs'\nconsole.log(fs)", 'module'), null)
})

test('type="module" : une vraie erreur après les imports est trouvée, à la bonne ligne', () => {
  const problem = syntax.checkJavaScriptSyntax("import { a } from './x.js'\n\nfunction toggleAlarm(false) {}\n", 'module')
  assert.equal(problem.line, 3)
  assert.equal(problem.message, "Unexpected token 'false'")
})

test('une accolade jamais fermée dans un module : « fin inattendue » sur la dernière ligne écrite', () => {
  const problem = syntax.checkJavaScriptSyntax('function f() {\n  if (x) {\n', 'module')
  assert.equal(problem.message, 'Unexpected end of input')
  assert.equal(problem.line, 2)
  assert.equal(problem.sourceLine, 'if (x) {')
})

test('dans le doute (import sur la même ligne qu’autre chose), rien n’est signalé', () => {
  assert.equal(syntax.checkJavaScriptSyntax("let a = 1; import x from 'y'", 'module'), null)
})

test('await au premier niveau d’un script CLASSIQUE est une vraie erreur (le navigateur la refuse aussi)', () => {
  assert.match(syntax.checkJavaScriptSyntax('await fetch("/a")', 'classic').message, /await is only valid/)
})

const PAGE = `<!DOCTYPE html>
<html><head>
<script type="application/json" id="donnees">{ "a": 1, ceci n'est pas du JavaScript }</script>
<script type="text/template"><div>{{ nom }}</div></script>
<script type="text/babel">const A = () => <div>JSX</div></script>
<script src="app.js">contenu ignoré par le navigateur ((</script>
<!-- <script>function cassé( {</script> -->
</head><body>
<button onclick="go()">Go</button>
<script>
  const label = "Score"
  function go() { alert(label) }
</script>
<script type="module">
import { x } from './m.js'
await go()
</script>
<script type="text/javascript">
  let a = 1
  function toggleAlarm(false) {
  }
</script>
</body></html>`

test('seuls les scripts que le navigateur exécute sont compilés (pas JSON, gabarit, src, ni commentaire)', () => {
  const scripts = syntax.findInlineScripts(PAGE).map(({ index, kind, startLine }) => ({ index, kind, startLine }))
  assert.deepEqual(JSON.parse(JSON.stringify(scripts)), [
    { index: 1, kind: 'classic', startLine: 10 },
    { index: 2, kind: 'module', startLine: 14 },
    { index: 3, kind: 'classic', startLine: 18 }
  ])
  const errors = syntax.findInlineScriptSyntaxErrors(PAGE)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].script, 3)
  assert.equal(errors[0].fileLine, 20, 'ligne du fichier entier, celle que montre l’onglet Code')
  assert.equal(errors[0].sourceLine, 'function toggleAlarm(false) {')
})

test('fichier .js d’un dépôt : script, Node ou module, il n’est fautif que s’il ne compile dans aucun cas', () => {
  assert.equal(syntax.fileSyntaxProblems('a.js', "import x from 'y'\nexport const z = 1\n").length, 0)
  assert.equal(syntax.fileSyntaxProblems('outil.js', "if (!process.argv[2]) return\nmodule.exports = 1\n").length, 0)
  assert.equal(syntax.fileSyntaxProblems('outil.mjs', "#!/usr/bin/env node\nimport fs from 'fs'\n").length, 0)
  assert.equal(syntax.fileSyntaxProblems('style.css', 'a { color: red }').length, 0)
  // Un module cassé : l'erreur rapportée est la vraie, pas « Cannot use import statement » sur la ligne 1.
  const [problem] = syntax.fileSyntaxProblems('jeu.js', "import x from 'y'\nfunction f(false) {}\n")
  assert.equal(problem.line, 2)
  assert.equal(problem.message, "Unexpected token 'false'")
})

test('dépôt : seule une erreur INTRODUITE par le changement est reprochée (JSX, déjà cassé : rien)', () => {
  // Nouveau fichier JSX / annotation de type / décorateur : une syntaxe passée par un outil de compilation.
  assert.equal(syntax.brokenScriptAfterChange('App.js', 'const A = () => <div>hi</div>\n', undefined), null)
  assert.equal(syntax.brokenScriptAfterChange('util.js', 'function f(x: number) {}\n', undefined), null)
  assert.equal(syntax.brokenScriptAfterChange('jeu.js', '@decorer\nclass A {}\n', undefined), null)
  // La version de GitHub ne compilait déjà pas : on ne sait pas l'attribuer à l'agent.
  assert.equal(syntax.brokenScriptAfterChange('App.js', 'const A = () => <div>hi</div>\nconst b = 1\n', 'const A = () => <div>hi</div>\n'), null)
  // Un fichier qui compilait et ne compile plus : reproché.
  const broken = syntax.brokenScriptAfterChange('jeu.js', 'function toggleAlarm(false) {}\n', 'function toggleAlarm(on) {}\n')
  assert.equal(broken.message, "Unexpected token 'false'")
  // Un nouveau fichier simplement cassé : reproché aussi.
  assert.ok(syntax.brokenScriptAfterChange('jeu.js', 'function f( {\n', undefined))
  assert.ok(syntax.brokenScriptAfterChange('index.html', '<script>function toggleAlarm(false) {}</script>', undefined))
})

/**
 * Relecture adverse du premier correctif : quatre trous, chacun verrouillé ici.
 */
test('module : une ligne dont on a seulement retiré `export` / `export default` reste contrôlée (cas réel avec export)', () => {
  // Avant : la ligne était marquée « retouchée », donc jamais signalée — le cas réel passait dès qu'il y avait `export`.
  for (const code of [
    'export function toggleAlarm(false) {}',
    'export default function toggleAlarm(false) {}',
    'export default function (false) {}',
    "import { a } from './a.js'\nexport async function charger(false) {}"
  ]) {
    const problem = syntax.checkJavaScriptSyntax(code, 'module')
    assert.ok(problem, `non signalé : ${code}`)
    assert.equal(problem.message, "Unexpected token 'false'")
  }
  assert.equal(syntax.findInlineScriptSyntaxErrors('<script type="module">export function toggleAlarm(false) {}</script>').length, 1)
})

test('module : export default sous toutes ses formes valides ne déclenche jamais rien (fonctions fléchées comprises)', () => {
  for (const code of [
    'export default (a, b) => a + b',
    'export default async () => { await 1 }',
    'export default x => x * 2',
    'export default function () {}',
    'export default function* () { yield 1 }',
    'export default async function () {}\nawait 2',
    'export default class {}',
    'export default class extends Array {}',
    'export default class Jeu extends Base { #x = 1 }',
    'export default [1, 2, 3]',
    'export default `gabarit ${1}`',
    // Une déclaration reste une déclaration : la ligne suivante n'est pas recollée à la fonction (le module l'accepte).
    "export default function f() {}\n/re/.test('s')",
    "export default class A {}\n[1, 2].forEach(() => {})",
    'export\n  default\n  function\n  ()\n  {}'
  ]) {
    assert.equal(syntax.checkJavaScriptSyntax(code, 'module'), null, `faux positif : ${code}`)
  }
})

test('script qui s’arrête trop tôt et finit par un retour à la ligne : la ligne rapportée est la dernière ÉCRITE', () => {
  // Presque tous les <script> générés finissent par un retour à la ligne : le moteur désignait la ligne vide d'après.
  const problem = syntax.checkJavaScriptSyntax('function f() {\n  x(\n', 'classic')
  assert.equal(problem.message, 'Unexpected end of input')
  assert.equal(problem.line, 2)
  assert.equal(problem.sourceLine, 'x(')
  const [inPage] = syntax.findInlineScriptSyntaxErrors('<body>\n<script>\nfunction f() {\n  x(\n</script>\n</body>')
  assert.equal(inPage.fileLine, 4, 'la ligne montrée à l’utilisateur doit être celle du code, pas celle de </script>')
})

test('un <script> que le navigateur n’exécute jamais (textarea, title, style, noscript, template, svg) n’est pas compilé', () => {
  for (const html of [
    '<textarea><script>alert(</script></textarea>',
    '<title>Mon <script>alert(</script> éditeur</title>',
    '<style>/* <script>alert(</script> */ body { color: red }</style>',
    '<noscript><script>alert(</script></noscript>',
    '<template id="ligne"><li><script>alert(</script></li></template>',
    '<template><template><script>a(</script></template><script>b(</script></template>',
    '<svg viewBox="0 0 10 10"><script><![CDATA[ if (a < b && c) go() ]]></script></svg>',
    '<svg><svg><script>if (a &lt; b) go()</script></svg><script>x(</script></svg>'
  ]) {
    assert.deepEqual(JSON.parse(JSON.stringify(syntax.findInlineScriptSyntaxErrors(html))), [], `faux positif : ${html}`)
  }
  // Après la zone inerte, un vrai script cassé est toujours trouvé (le scanner reprend bien après sa fermeture).
  for (const before of ['<textarea>x</textarea>', '<svg/>', '<svg><circle r="1"/></svg>', '<template><p>a</p></template>']) {
    const [problem] = syntax.findInlineScriptSyntaxErrors(`${before}<script>function toggleAlarm(false) {}</script>`)
    assert.equal(problem?.message, "Unexpected token 'false'", `vrai défaut manqué après ${before}`)
  }
})

test('dépôt : gabarits serveur et syntaxes d’outils ne sont jamais reprochés, nouveau fichier ou non', () => {
  // Nouvelle page de gabarit créée par l'agent (Flask/Jinja, EJS, Liquid, PHP, Thymeleaf).
  assert.equal(syntax.brokenScriptAfterChange('templates/index.html', '<script>const user = {{ user|tojson }}</script>', undefined), null)
  assert.equal(syntax.brokenScriptAfterChange('views/liste.html', '<script>const items = <%- JSON.stringify(items) %></script>', undefined), null)
  assert.equal(syntax.brokenScriptAfterChange('_layouts/a.html', '<script>{% if site.analytics %}ga()\n{% endif %}</script>', undefined), null)
  assert.equal(syntax.brokenScriptAfterChange('page.html', '<script>var user = [[${user}]];</script>', undefined), null)
  // Jinja AJOUTÉ à une page dont le script compilait : toujours un gabarit, jamais reproché.
  assert.equal(
    syntax.brokenScriptAfterChange('templates/produits.html', '<script>const items = {{ items|tojson }};\nafficher(items)</script>', '<script>afficher([])</script>'),
    null
  )
  // JSX ajouté à un .js qui compilait (projet React en .js), Flow, décorateur, en-tête Jekyll.
  assert.equal(syntax.brokenScriptAfterChange('src/App.js', 'function App() {\n  return <h1>Bonjour</h1>\n}\n', 'function App() {\n  return null\n}\n'), null)
  assert.equal(syntax.brokenScriptAfterChange('src/types.js', 'type Props = { titre: string }\nexport const x = 1\n', undefined), null)
  assert.equal(syntax.brokenScriptAfterChange('src/a.js', '// @flow\nconst f = (x?: number) => x\n', 'const f = (x) => x\n'), null)
  assert.equal(syntax.brokenScriptAfterChange('src/b.js', 'interface Jeu { score: number }\n', undefined), null)
  assert.equal(syntax.brokenScriptAfterChange('src/c.js', 'class A {\n  @observable score = 0\n}\n', 'class A {\n  score = 0\n}\n'), null)
  assert.equal(syntax.brokenScriptAfterChange('assets/site.js', '---\n---\nconst base = "{{ site.baseurl }}"\n', undefined), null)
  // Une vraie erreur dans une page ou un .js reste reprochée, même à côté d'un script de gabarit.
  const page = '<script>const user = {{ user }}</script>\n<script>function toggleAlarm(false) {}</script>'
  assert.equal(syntax.brokenScriptAfterChange('templates/reveil.html', page, undefined)?.message, "Unexpected token 'false'")
  assert.equal(syntax.brokenScriptAfterChange('src/App.js', 'function toggleAlarm(false) {}\n', 'function toggleAlarm() {}\n')?.message, "Unexpected token 'false'")
})

test('un `<script>` écrit dans la valeur d’un attribut n’est jamais pris pour un vrai script', () => {
  for (const html of [
    '<input value="<script>alert(</script>">',
    '<iframe srcdoc="<script>alert(</script>"></iframe>',
    "<div data-exemple='<script>if (</script>'>texte</div>"
  ]) {
    assert.deepEqual(JSON.parse(JSON.stringify(syntax.findInlineScriptSyntaxErrors(html))), [], `faux positif : ${html}`)
  }
  const [problem] = syntax.findInlineScriptSyntaxErrors('<input value="<script>"><p>a</p><script>function toggleAlarm(false) {}</script>')
  assert.equal(problem?.message, "Unexpected token 'false'")
})
