import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * Étape 234 (bêta de Jaris) : le Chat affichait les blocs de code avec leurs « ``` », alors que les consignes
 * du canal écrit autorisent le modèle à en écrire. Rendu React réel (renderToStaticMarkup).
 */
const require = createRequire(import.meta.url)
const { renderToStaticMarkup } = require('react-dom/server')
const out = ts.transpileModule(readFileSync(new URL('../src/lib/formatReply.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
}).outputText
const exports = {}
vm.runInThisContext(`(function (exports, require, module) {\n${out}\n})`)(exports, require, { exports })
const html = (text) => renderToStaticMarkup(exports.renderFormattedText(text))

test('bloc de code : affiché comme du code, sans ses accents graves', () => {
  const result = html('Voici :\n```js\nconsole.log(1)\n```\nFin.')
  assert.match(result, /<pre class="reply-code-block"><code>console\.log\(1\)<\/code><\/pre>/)
  assert.ok(!result.includes('```'))
  assert.match(result, /Voici :/)
  assert.match(result, /Fin\./)
})

test('bloc pas encore fermé (réponse en cours d’écriture) : déjà montré comme du code', () => {
  assert.match(html('```python\nprint("a")'), /<pre class="reply-code-block"><code>print\(&quot;a&quot;\)<\/code><\/pre>/)
})

test('gras et `code` en ligne ; le HTML du modèle n’est jamais interprété', () => {
  const result = html('**Important** : lance `npm test` puis <script>alert(1)</script>')
  assert.match(result, /<strong>Important<\/strong>/)
  assert.match(result, /<code class="reply-code-inline">npm test<\/code>/)
  assert.ok(!result.includes('<script>'))
})
