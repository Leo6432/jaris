import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * Étape 32 (uiAutomation.ts) : la recherche de l'élément visé par son nom et la mise en forme de la liste, en
 * TypeScript pur. Étape 256 : la lecture de l'écran (script PowerShell) a déménagé dans screenMarks.ts, testé à
 * part (scripts/test-screen-marks.mjs, dont le piège « un seul élément = un objet » de ConvertTo-Json).
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
load(loaded.exports, () => ({}), loaded)
const { findElementByName, describeElements, keySymbol } = loaded.exports

const element = (name, extra = {}) => ({ name, type: 'Button', x: 10, y: 20, ...extra })

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

test('étape 256 : un élément numéroté sur la capture porte son numéro en tête de ligne', () => {
  const described = describeElements([element('Rechercher', { id: 1, type: 'Edit' }), element('Se connecter', { id: 12 })])
  assert.equal(described, '1. [Edit] Rechercher\n12. [Button] Se connecter')
})

test('étape 256 : plus aucune lecture de « la fenêtre active » (c’était Jaris lui-même quand Léo lui parlait)', () => {
  const real = readFileSync(new URL('../electron/services/uiAutomation.ts', import.meta.url), 'utf8')
  assert.ok(!/GetForegroundWindow\(|listClickableElements/.test(real))
})

test('étape 259 : les touches de la Calculatrice (noms Windows en toutes lettres) portent leur symbole', () => {
  // Noms RÉELS de la Calculatrice française (microsoft/calculator, Resources.resw fr-FR) et anglaise.
  const described = describeElements([
    element('Sept', { id: 21 }), element('Plus', { id: 32 }), element('Cinq', { id: 26 }), element('Est égal à', { id: 36 }),
    element('Multiplier par', { id: 24 }), element('Zéro', { id: 34 }), element('Seven', { id: 40 }), element('Equals', { id: 41 })
  ])
  assert.equal(
    described,
    '21. [Button] Sept « 7 »\n32. [Button] Plus « + »\n26. [Button] Cinq « 5 »\n36. [Button] Est égal à « = »\n' +
      '24. [Button] Multiplier par « × »\n34. [Button] Zéro « 0 »\n40. [Button] Seven « 7 »\n41. [Button] Equals « = »'
  )
  // Seul un nom ENTIER est reconnu : un lien « Un article » ou « Plus de vidéos » reste tel quel.
  for (const name of ['Un article', 'Plus de vidéos', 'Rechercher', 'Effacer']) assert.equal(keySymbol(name), null, name)
  assert.equal(keySymbol('  un '), '1')
})
