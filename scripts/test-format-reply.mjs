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

/**
 * Étape 339 (Léo : « dans le chat il y a encore les ** »), sur la vraie réponse qu'il a montrée : un gras qui
 * contient de l'italique restait affiché avec ses étoiles, et l'italique ne l'était jamais.
 */
test('gras qui contient de l’italique et passe à la ligne : aucune étoile affichée', () => {
  const result = html('**Les sites web légaux (c’est-à-dire *avec autorisation écrite*) sont :\n- TryHackMe** → plateforme. *Vous travaillez sur des machines dédiées.*')
  assert.ok(!result.includes('*'), result)
  assert.match(result, /<strong>Les sites web légaux \(c’est-à-dire <em>avec autorisation écrite<\/em>\) sont :\n- TryHackMe<\/strong>/)
  assert.match(result, /<em>Vous travaillez sur des machines dédiées\.<\/em>/)
})

test('italique entre guillemets, et une multiplication jamais prise pour de l’italique', () => {
  assert.match(html('Vous dites *"j\'ai l\'accord"* pour.'), /<em>&quot;j&#x27;ai l&#x27;accord&quot;<\/em>/)
  assert.equal(html('3 * 4 * 5 = 60'), '3 * 4 * 5 = 60')
  assert.equal(html('x*y*z'), 'x*y*z')
})

test('un « ** » sans partenaire est retiré, un titre « ### » devient une ligne en gras', () => {
  assert.equal(html('**oublié de fermer'), 'oublié de fermer')
  assert.equal(html('### Titre\nTexte'), '<strong>Titre</strong>\nTexte')
  assert.equal(html('## **Gras**'), '<strong>Gras</strong>')
})

test('les étoiles d’un bloc de code restent telles quelles', () => {
  assert.match(html('```\n**pas du gras** et 3 * 4\n```'), /<code>\*\*pas du gras\*\* et 3 \* 4<\/code>/)
})

/**
 * Étape 354 (design) : les listes du modèle s'affichaient avec leurs tirets et numéros tapés à la main. Elles
 * deviennent de vraies listes ; le texte autour reste du texte, et un gras étalé sur une ligne de liste garde
 * l'ancien rendu (test juste au-dessus, étape 339).
 */
test('listes : vraies puces et vrais numéros, texte autour intact', () => {
  const result = html('### Ingrédients\n- 250 g de farine\n- 4 **œufs**\n\n### Étapes\n1. Verse la farine.\n2. Ajoute le lait.\n\nBon appétit !')
  assert.equal(
    result,
    '<strong>Ingrédients</strong><ul class="reply-list"><li>250 g de farine</li><li>4 <strong>œufs</strong></li></ul>' +
      '<strong>Étapes</strong><ol class="reply-list"><li>Verse la farine.</li><li>Ajoute le lait.</li></ol>Bon appétit !'
  )
})

test('listes : une ligne vide entre deux éléments ne coupe pas la liste, la numérotation reprise est gardée', () => {
  assert.equal(html('1. Un\n\n2. Deux'), '<ol class="reply-list"><li>Un</li><li>Deux</li></ol>')
  assert.equal(html('3. Trois\n4. Quatre'), '<ol class="reply-list" start="3"><li>Trois</li><li>Quatre</li></ol>')
  assert.equal(html('- A\n  - sous-point'), '<ul class="reply-list"><li>A<ul class="reply-list reply-list--nested"><li>sous-point</li></ul></li></ul>')
})

test('listes : jamais dans un bloc de code, et un calcul « - 5 » ou un tiret collé ne deviennent pas des listes', () => {
  assert.match(html('```\n- pas une liste\n```'), /<code>- pas une liste<\/code>/)
  assert.equal(html('-5 °C ce matin'), '-5 °C ce matin')
  assert.equal(html('Total : 12\n*important*'), 'Total : 12\n<em>important</em>')
})

/**
 * Étape 366 (capture de Léo, réponse d'un duel) : deux sous-puces sous « 2. Contrôles » comptaient dans la
 * numérotation — la suite s'affichait « 5. Croissance, 6. Perdre, 7. Victoire ». Même forme que sa réponse.
 */
const LEO_REPLY = [
  'Règles du jeu',
  '',
  '1. **Objectif** : faire le plus long serpent possible.',
  '2. **Contrôles** :',
  '   - Utilisez les flèches haut, bas, gauche, droite.',
  '   - Vous n’aurez pas besoin de taper ces touches ici.',
  '3. **Croissance** : chaque nourriture le fait grandir.',
  '4. **Perdre** : toucher un mur termine la partie.',
  '5. **Victoire** : atteindre 100 unités.',
  '',
  '---',
  '',
  'Veuillez indiquer votre première direction.'
].join('\n')

test('sous-puces : une vraie sous-liste dans l’élément du dessus, la numérotation reste 1 à 5', () => {
  const result = html(LEO_REPLY)
  const ol = result.match(/<ol class="reply-list">([\s\S]*)<\/ol>/)
  assert.ok(ol, result)
  // Cinq éléments de premier niveau, aucun attribut start : le navigateur numérote 1, 2, 3, 4, 5.
  const topLevel = ol[1].replace(/<ul class="reply-list reply-list--nested">[\s\S]*?<\/ul>/g, '').match(/<li>/g) ?? []
  assert.equal(topLevel.length, 5, result)
  assert.match(result, /<li><strong>Contrôles<\/strong> :<ul class="reply-list reply-list--nested"><li>Utilisez[^<]*<\/li><li>Vous[^<]*<\/li><\/ul><\/li><li><strong>Croissance<\/strong>/)
  // Le séparateur devient un trait, le texte autour reste intact.
  assert.match(result, /<\/ol><hr class="reply-rule"\/>Veuillez indiquer votre première direction\.$/)
  assert.ok(!result.includes('---'), result)
})

test('sous-puces : une ligne vide avant la sous-puce ne coupe pas la liste ; une sous-puce sans parent reste un élément', () => {
  assert.equal(
    html('1. Un\n\n   - détail\n2. Deux'),
    '<ol class="reply-list"><li>Un<ul class="reply-list reply-list--nested"><li>détail</li></ul></li><li>Deux</li></ol>'
  )
  assert.equal(html('  - seul'), '<ul class="reply-list"><li>seul</li></ul>')
  assert.equal(
    html('- A\n  1. un\n  2. deux'),
    '<ul class="reply-list"><li>A<ol class="reply-list reply-list--nested"><li>un</li><li>deux</li></ol></li></ul>'
  )
})

test('séparateur : seulement une ligne de « --- », « *** » ou « ___ », jamais dans le code ni dans un calcul', () => {
  assert.equal(html('Avant\n\n***\n\nAprès'), 'Avant<hr class="reply-rule"/>Après')
  assert.equal(html('Avant\n___\nAprès'), 'Avant<hr class="reply-rule"/>Après')
  assert.match(html('```\n---\n```'), /<code>---<\/code>/)
  assert.equal(html('a --- b'), 'a --- b')
  assert.equal(html('-5 °C ce matin'), '-5 °C ce matin')
  assert.ok(!html('- - -').includes('<hr'), html('- - -'))
})

/** Relecture de l'étape 366 : le retrait est RELATIF — liste entièrement en retrait, et troisième niveau. */
test('sous-puces : une liste entièrement en retrait reste à un niveau ; un 3e niveau ne compte pas dans le 2e', () => {
  assert.equal(
    html('**Contrôles** :\n   - Flèches\n   - Espace\n   - Échap'),
    '<strong>Contrôles</strong> :<ul class="reply-list"><li>Flèches</li><li>Espace</li><li>Échap</li></ul>'
  )
  assert.equal(
    html('Voici :\n   1. Un\n   2. Deux'),
    'Voici :<ol class="reply-list"><li>Un</li><li>Deux</li></ol>'
  )
  assert.equal(
    html('1. Installer\n   1. Télécharger\n      1. Ouvrir le site\n      2. Cliquer\n   2. Lancer\n2. Configurer'),
    '<ol class="reply-list"><li>Installer<ol class="reply-list reply-list--nested"><li>Télécharger' +
      '<ol class="reply-list reply-list--nested"><li>Ouvrir le site</li><li>Cliquer</li></ol></li><li>Lancer</li></ol></li><li>Configurer</li></ol>'
  )
})
