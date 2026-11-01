import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Étape 380 : lecture des blocs interactifs du Chat (shared/uiBlocks.ts). Tout vient du modèle : chaque bloc est
 * vérifié, borné, et le calculateur n'exécute jamais de code (lecteur de formules maison, pas d'eval).
 */
const { parseUiBlock, parseLenientJson, evaluateFormula, uiBlocksToText, toNumber } = loadTsModule('shared/uiBlocks.ts')

test('JSON écrit par un petit modèle : virgule en trop et retour à la ligne brut tolérés', () => {
  assert.deepEqual(parseLenientJson('{"a":[1,2,],}'), { a: [1, 2] })
  assert.deepEqual(parseLenientJson('{"a":"ligne 1\nligne 2"}'), { a: 'ligne 1\nligne 2' })
  // Une virgule DANS une chaîne n'est jamais retirée.
  assert.deepEqual(parseLenientJson('{"a":"x,]"}'), { a: 'x,]' })
  assert.equal(parseLenientJson('{"a": oups}'), undefined)
})

test('nombres écrits en texte : « 12,5 », « 1 200 », « 30 % » ; un mot n’est pas un nombre', () => {
  assert.equal(toNumber('12,5'), 12.5)
  assert.equal(toNumber('1 200'), 1200)
  assert.equal(toNumber('30 %'), 30)
  assert.equal(toNumber('beaucoup'), null)
  assert.equal(toNumber(Infinity), null)
})

test('tableau : lignes complétées ou coupées à la largeur des colonnes, lignes vides retirées', () => {
  const block = parseUiBlock('{"type":"table","columns":["A","B"],"rows":[["1"],["2","3","4"],[]]}')
  assert.deepEqual(block.rows, [
    ['1', ''],
    ['2', '3']
  ])
  assert.equal(parseUiBlock('{"type":"table","columns":[],"rows":[["1"]]}'), null)
})

test('graphique : valeurs non numériques écartées avec leur libellé, au moins 2 points', () => {
  const block = parseUiBlock('{"type":"chart","labels":["a","b","c"],"values":[1,"x",3]}')
  assert.deepEqual(block.labels, ['a', 'c'])
  assert.deepEqual(block.values, [1, 3])
  assert.equal(block.kind, 'bar')
  assert.equal(parseUiBlock('{"type":"chart","labels":["a"],"values":[1]}'), null)
})

test('tailles bornées : 6 choix au plus, sans doublon ; un seul choix ne sert à rien', () => {
  const block = parseUiBlock('{"type":"choices","options":["a","a","b","c","d","e","f","g"]}')
  assert.deepEqual(block.options, ['a', 'b', 'c', 'd', 'e'])
  assert.equal(parseUiBlock('{"type":"choices","options":["a"]}'), null)
})

test('type inconnu ou pas un objet : rien n’est dessiné', () => {
  assert.equal(parseUiBlock('{"type":"html","content":"<b>x</b>"}'), null)
  assert.equal(parseUiBlock('[1,2]'), null)
  assert.equal(parseUiBlock('"texte"'), null)
})

test('formules : opérations, priorités, fonctions permises', () => {
  assert.equal(evaluateFormula('prix*(1-remise/100)', { prix: 100, remise: 20 }), 80)
  assert.equal(evaluateFormula('2+3*4^2', {}), 50)
  assert.equal(evaluateFormula('-2^2', {}), -4)
  assert.equal(evaluateFormula('round(10/3, 2)', {}), 3.33)
  assert.equal(evaluateFormula('max(a, b, 7)', { a: 1, b: 9 }), 9)
})

test('formules : jamais de code exécuté — tout ce qui n’est pas une formule est refusé', () => {
  for (const formula of [
    'constructor',
    'alert(1)',
    'process.exit()',
    'a; b',
    'this',
    'prix.toString',
    '__proto__',
    "'x'",
    'globalThis'
  ]) {
    assert.equal(evaluateFormula(formula, { prix: 1, a: 1, b: 2 }), null, formula)
  }
  // Un nom qui n'est pas un champ du calculateur, même présent dans l'objet (héritage), est refusé.
  assert.equal(evaluateFormula('toString', {}), null)
  assert.equal(evaluateFormula('constructor + 1', { a: 1 }), null)
  assert.equal(evaluateFormula('valueOf', {}), null)
  assert.equal(evaluateFormula('1/0', {}), null)
  assert.equal(evaluateFormula('(1+2', {}), null)
})

test('calculateur : une sortie dont la formule ne marche pas n’est pas affichée', () => {
  const block = parseUiBlock(
    '{"type":"calculator","inputs":[{"name":"a","label":"A","value":2}],"outputs":[{"label":"Bon","formula":"a*2"},{"label":"Faux","formula":"b*2"}]}'
  )
  assert.deepEqual(
    block.outputs.map((output) => output.label),
    ['Bon']
  )
  assert.equal(parseUiBlock('{"type":"calculator","inputs":[{"name":"a","value":2}],"outputs":[{"formula":"zz"}]}'), null)
})

test('version texte (page du téléphone) : lignes ordinaires, jamais de JSON', () => {
  const text = uiBlocksToText(
    'Voici :\n```jaris-ui\n{"type":"steps","title":"Pâte","items":["Mélanger","Cuire"]}\n```\nBon appétit.'
  )
  assert.match(text, /\*\*Pâte\*\*/)
  assert.match(text, /1\. Mélanger\n2\. Cuire/)
  assert.ok(!text.includes('jaris-ui') && !text.includes('"type"'))
  assert.equal(uiBlocksToText('A\n```jaris-ui\n{oups}\n```\nB').includes('oups'), false)
  // Un bloc de code ordinaire n'est pas touché.
  assert.equal(uiBlocksToText('```js\nx\n```'), '```js\nx\n```')
})
