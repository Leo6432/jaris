import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * Étape 32 (uiAutomation.ts) : le script PowerShell lui-même n'est PAS testable ici (aucun Windows ni
 * PowerShell dans l'environnement de développement) — d'où le choix d'implémentation de garder hors de
 * PowerShell tout ce qui manipule une donnée venant du modèle. Ce fichier teste donc exactement ces
 * parties-là : la lecture de ce que le script renvoie, et la recherche de l'élément visé par son nom.
 */
const source = ts.transpileModule(readFileSync(new URL('../electron/services/uiAutomation.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

// Exécuté dans le realm courant (et non `runInNewContext` comme les autres tests du dépôt) : un contexte vm
// séparé a ses propres prototypes Array/Object, donc `assert.deepEqual` y échoue sur des objets pourtant
// identiques ("same structure but not reference-equal"). Les autres tests ne comparent que des primitives et
// ne rencontrent donc jamais ce piège.
const load = vm.runInThisContext(`(function (exports, require, module) {\n${source}\n})`)
const loaded = { exports: {} }
load(loaded.exports, () => ({ spawn: () => {} }), loaded)
const { parseElements, findElementByName, describeElements } = loaded.exports

const element = (name, extra = {}) => ({ name, type: 'Button', x: 10, y: 20, ...extra })

test('un seul élément ressort en objet (ConvertTo-Json 5.1 sans -AsArray) et doit quand même être lu', () => {
  const parsed = parseElements('{"name":"Rechercher","type":"Button","x":40,"y":12}')
  assert.deepEqual(parsed, [{ name: 'Rechercher', type: 'Button', x: 40, y: 12 }])
})

test('une vraie liste est lue telle quelle', () => {
  const parsed = parseElements('[{"name":"A","type":"Button","x":1,"y":2},{"name":"B","type":"Hyperlink","x":3,"y":4}]')
  assert.equal(parsed.length, 2)
  assert.equal(parsed[1].type, 'Hyperlink')
})

for (const [label, stdout] of [
  ['sortie vide (fenêtre sans élément)', '   '],
  ['sortie non JSON (erreur PowerShell)', 'Add-Type : impossible de charger'],
  ['tableau vide', '[]']
]) {
  test(`repli sur une liste vide : ${label}`, () => {
    assert.deepEqual(parseElements(stdout), [])
  })
}

test('les entrées incomplètes sont écartées, pas la liste entière', () => {
  const parsed = parseElements(JSON.stringify([
    { name: 'Bon', type: 'Button', x: 5, y: 6 },
    { name: '', type: 'Button', x: 1, y: 2 },
    { name: 'Sans position', type: 'Button' },
    { name: 'X non fini', type: 'Button', x: null, y: 2 }
  ]))
  assert.deepEqual(parsed.map((item) => item.name), ['Bon'])
})

test('une correspondance EXACTE gagne sur un simple préfixe placé plus haut', () => {
  const elements = [element("Fermer l'onglet"), element('Fermer')]
  assert.equal(findElementByName(elements, 'Fermer').name, 'Fermer')
})

test('un préfixe gagne sur un nom seulement contenu', () => {
  const elements = [element('Ouvrir le menu Paramètres'), element('Paramètres du compte')]
  assert.equal(findElementByName(elements, 'Paramètres').name, 'Paramètres du compte')
})

for (const [label, wanted] of [
  ['casse différente', 'rechercher'],
  ['accents manquants', 'parametres'],
  ['espaces en trop', '  Paramètres  ']
]) {
  test(`le nom repris approximativement par le modèle est retrouvé : ${label}`, () => {
    const elements = [element('Rechercher'), element('Paramètres')]
    assert.ok(findElementByName(elements, wanted))
  })
}

test('aucun élément correspondant renvoie null (repli clic en pixels)', () => {
  assert.equal(findElementByName([element('Rechercher')], 'Envoyer'), null)
  assert.equal(findElementByName([element('Rechercher')], '   '), null)
  assert.equal(findElementByName([], 'Rechercher'), null)
})

test('la description envoyée au modèle reste courte et typée', () => {
  const long = 'x'.repeat(200)
  const described = describeElements([element('Rechercher'), element(long, { type: 'Edit' })])
  assert.match(described, /^- \[Button\] Rechercher$/m)
  assert.match(described, /^- \[Edit\] x{80}$/m)
})
