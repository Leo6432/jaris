import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { i18nModules, loadTsModule } from './load-ts-module.mjs'

/**
 * Étape 234 (bêta de Jaris) : le Chat affichait les blocs de code avec leurs « ``` », alors que les consignes
 * du canal écrit autorisent le modèle à en écrire. Rendu React réel (renderToStaticMarkup).
 */
const require = createRequire(import.meta.url)
const { renderToStaticMarkup } = require('react-dom/server')
const i18n = i18nModules()['../../shared/i18n']

/** Charge un fichier .ts/.tsx du dépôt, ses imports du dépôt compris (blocs interactifs, étape 380). */
function loadRepoModule(relativePath) {
  const out = ts.transpileModule(readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
  }).outputText
  const local = (name) => {
    if (name.endsWith('shared/i18n')) return i18n
    if (name === '@/components/ReplyBlock') return loadRepoModule('src/components/ReplyBlock.tsx')
    if (name.endsWith('shared/uiBlocks')) return uiBlocks
    return require(name)
  }
  const module = { exports: {} }
  vm.runInThisContext(`(function (exports, require, module) {\n${out}\n})`)(module.exports, local, module)
  return module.exports
}
const uiBlocks = loadTsModule('shared/uiBlocks.ts')
const exports = loadRepoModule('src/lib/formatReply.tsx')
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

/**
 * Étape 380 (Léo : « sur ChatGPT ils ont ajouté l'UI, on peut faire pareil », choix « blocs tout prêts ») : un bloc
 * ```jaris-ui devient un vrai composant de Jaris, jamais du JSON affiché ni du HTML du modèle interprété.
 */
const ui = (json) => html('Voici :\n```jaris-ui\n' + json + '\n```\nFin.')

test('bloc tableau : un vrai tableau, sans JSON ni accents graves', () => {
  const result = ui('{"type":"table","title":"Prix","columns":["Modèle","Prix"],"rows":[["A","12 €"],["B","15 €"]]}')
  assert.match(result, /<figure class="reply-ui reply-ui--table">/)
  assert.match(result, /<th scope="col">Modèle<\/th>/)
  assert.match(result, /<td class="reply-ui__num">12 €<\/td>/)
  assert.ok(!result.includes('"type"'))
  assert.ok(!result.includes('```'))
  assert.match(result, /Voici :/)
  assert.match(result, /Fin\./)
})

test('bloc graphique : une barre par valeur, et les valeurs lisibles par un lecteur d’écran', () => {
  const result = ui('{"type":"chart","kind":"bar","title":"Températures","unit":"°C","labels":["Lun","Mar","Mer"],"values":[12,"15,5",9]}')
  assert.equal(result.match(/class="reply-ui__bar"/g)?.length, 3)
  assert.match(result, /<th scope="row">Mar<\/th><td>15,5 °C<\/td>/)
  assert.match(result, /role="img"/)
})

test('bloc étapes, liste à cocher, choix et calculateur : chacun son composant', () => {
  assert.equal(ui('{"type":"steps","items":["Préchauffer","Mélanger"]}').match(/type="checkbox"/g)?.length, 2)
  assert.match(ui('{"type":"checklist","items":["Pain","Lait","Œufs"]}'), /0\/3/)
  // Sans fonction de clic (ancienne réponse, widget), les choix sont montrés mais pas cliquables.
  assert.equal(ui('{"type":"choices","title":"Lequel ?","options":["A","B"]}').match(/disabled=""/g)?.length, 2)
  const calc = ui(
    '{"type":"calculator","inputs":[{"name":"prix","label":"Prix","value":100,"unit":"€"},{"name":"remise","label":"Remise","value":20}],"outputs":[{"label":"Prix final","formula":"prix*(1-remise/100)","unit":"€"}]}'
  )
  assert.match(calc, /<dd>80 €<\/dd>/)
})

test('bloc illisible : son contenu reste visible comme du code (rien n’est perdu)', () => {
  const result = ui('{"type":"table", oups')
  assert.match(result, /<pre class="reply-code-block">/)
  assert.ok(!result.includes('reply-ui reply-ui--'))
})

test('bloc pas encore fermé : une ligne d’attente, jamais le JSON qui défile', () => {
  const result = html('Voici :\n```jaris-ui\n{"type":"table","colu')
  assert.match(result, /reply-ui__pending/)
  assert.ok(!result.includes('colu'))
})

test('le texte d’un bloc n’est jamais interprété en HTML', () => {
  const result = ui('{"type":"checklist","items":["<img src=x onerror=alert(1)>"]}')
  assert.ok(!result.includes('<img src=x'))
  assert.match(result, /&lt;img src=x/)
})

/**
 * Étape 403 (Léo, capture d'une « liste de courses pour des crêpes » en simples puces) : quand la demande est une
 * liste de courses ou de choses à faire, les listes de la réponse deviennent cochables, même sans bloc checklist.
 */
const CREPES =
  'Pour faire des crêpes :\n\n**Ingrédients de base :**\n- Farine (250 g)\n- **Œufs** (3 ou 4)\n- Lait (50 cl)\n\n' +
  '**Pour servir :**\n1. Caramel\n2. Miel\n   - ou sirop d’érable\n\nBon appétit.'

test('liste de courses demandée : chaque élément de premier niveau devient une case, la mise en forme reste', () => {
  const result = renderToStaticMarkup(exports.renderFormattedText(CREPES, { checkableLists: true }))
  assert.equal(result.match(/type="checkbox"/g)?.length, 5)
  assert.equal(result.match(/reply-ui__ticks--inline/g)?.length, 2)
  assert.match(result, /<strong>Œufs<\/strong> \(3 ou 4\)/)
  // La sous-liste reste une liste ordinaire sous son élément, et le texte autour reste du texte.
  assert.match(result, /<ul class="reply-list reply-list--nested">/)
  assert.match(result, /<strong>Pour servir :<\/strong>/)
  assert.match(result, /Bon appétit\./)
})

test('sans liste de courses demandée : les listes restent de simples listes', () => {
  const result = html(CREPES)
  assert.ok(!result.includes('type="checkbox"'))
  assert.match(result, /<ul class="reply-list">/)
})

test('demande de liste de courses ou de choses à faire reconnue, et seulement celle-là', () => {
  for (const request of [
    'fais-moi une liste de courses pour des crêpes',
    'Fais une LISTE DE COURSES',
    'tu peux me faire la liste des courses pour la semaine ?',
    'une liste de choses à faire avant de partir',
    'liste des tâches pour le déménagement',
    'fais une checklist pour ma valise',
    'make me a shopping list',
    'my to-do list for today'
  ]) {
    assert.equal(uiBlocks.wantsChecklist(request), true, request)
  }
  for (const request of [
    'quels sont les avantages des crêpes ?',
    'liste les capitales d’Europe',
    'comment faire des courses moins chères ?',
    'explique-moi la liste des présidents'
  ]) {
    assert.equal(uiBlocks.wantsChecklist(request), false, request)
  }
})

// Léo (captures « Compare 3 forfaits mobiles dans un tableau ») : un tableau Markdown restait affiché avec ses barres,
// et un bloc écrit en ```json au lieu de ```jaris-ui restait en JSON brut.
test('tableau Markdown du modèle : dessiné comme un vrai tableau, sans barres ni étoiles', () => {
  const result = html(
    'Top 3 :\n\n| Opérateur | Prix |\n|---|---|\n| **YouPrice** (Orange) | 7,99 € |\n| RED by SFR | 11,99 € |\n\nVoilà.'
  )
  assert.match(result, /<table class="reply-ui__table">/)
  assert.match(result, /YouPrice \(Orange\)/)
  assert.ok(!result.includes('|---'), result)
  assert.ok(!result.includes('**'), result)
  assert.match(result, /Top 3 :/)
  assert.match(result, /Voilà\./)
})

test('un tableau Markdown dans un bloc de code reste du code', () => {
  const result = html('```\n| a | b |\n|---|---|\n| 1 | 2 |\n```')
  assert.ok(!result.includes('reply-ui__table'))
  assert.match(result, /<code>\| a \| b \|/)
})

test('bloc écrit en ```json : dessiné s’il est un vrai bloc, du code sinon', () => {
  const block = html('Voici :\n```json\n{"type":"table","columns":["Offre","Prix"],"rows":[["RED","11 €"]]}\n```')
  assert.match(block, /<table class="reply-ui__table">/)
  assert.ok(!block.includes('&quot;type&quot;'))
  const plain = html('```json\n{"nom":"Léo"}\n```')
  assert.match(plain, /<pre class="reply-code-block">/)
})
