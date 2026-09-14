import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * src/lib/formatRecentDate.ts (étape 94) : la date d'une application déjà générée, telle qu'affichée dans
 * "Tes applications" (mode Code). Fonction pure — l'instant courant est un paramètre — donc testable
 * directement ici, sans navigateur.
 */
const source = ts.transpileModule(readFileSync(new URL('../src/lib/formatRecentDate.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

const exports = {}
vm.runInThisContext(`(function (exports, module, require) { ${source} })`)(exports, { exports }, () => ({}))
const { formatRecentDate } = exports

const NOW = new Date(2026, 8, 14, 15, 30) // 14 septembre 2026, 15h30 (mois 0-indexé)

test("une génération du jour est datée en clair, pas en 14/09/2026 15:11:52", () => {
  const date = new Date(2026, 8, 14, 9, 5)
  assert.match(formatRecentDate(date.getTime(), NOW), /^Aujourd'hui, 09[:h]05$/)
})

test('une génération de la veille est datée "Hier"', () => {
  assert.match(formatRecentDate(new Date(2026, 8, 13, 22, 40).getTime(), NOW), /^Hier, 22[:h]40$/)
})

test('hier 23h50 reste HIER, même s\'il s\'est écoulé moins de 24 heures', () => {
  // Le piège du calcul en millisecondes : (maintenant - date) / 86400000 vaudrait 0 juste après minuit,
  // et afficherait "Aujourd'hui" pour quelque chose fait la veille. Le calcul se fait donc en jours de
  // CALENDRIER.
  const justAfterMidnight = new Date(2026, 8, 14, 0, 10)
  assert.match(formatRecentDate(new Date(2026, 8, 13, 23, 50).getTime(), justAfterMidnight), /^Hier, /)
})

test("au-delà d'hier, la date remplace l'heure (inutile de connaître la minute)", () => {
  const older = formatRecentDate(new Date(2026, 8, 2, 8, 38).getTime(), NOW)
  assert.doesNotMatch(older, /Aujourd'hui|Hier/)
  assert.match(older, /^2 /)
  // Pas d'heure : elle n'apporte rien pour retrouver une application faite il y a deux semaines.
  assert.doesNotMatch(older, /\d{1,2}[:h]\d{2}/)
})

test("l'année n'apparaît que si elle est différente de l'année en cours", () => {
  assert.doesNotMatch(formatRecentDate(new Date(2026, 0, 3).getTime(), NOW), /2026/)
  assert.match(formatRecentDate(new Date(2025, 11, 30).getTime(), NOW), /2025/)
})

test('une date invalide ne casse pas la liste', () => {
  // listGeneratedApps lit un horodatage depuis le nom du dossier : un dossier renommé à la main peut en
  // donner un qui ne se parse pas. Mieux vaut une cellule vide qu'un "Invalid Date" affiché à Léo.
  assert.equal(formatRecentDate(Number.NaN, NOW), '')
})
