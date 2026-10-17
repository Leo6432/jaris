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
