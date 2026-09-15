import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * src/lib/formatCodeGenProgress.ts (étape 99) : la ligne que Léo lit pendant qu'une génération tourne —
 * souvent la SEULE chose visible pendant plusieurs minutes. Fonction pure (le temps écoulé est un
 * paramètre), donc testable directement, comme formatRecentDate et formatUpdateProgress.
 */
const source = ts.transpileModule(readFileSync(new URL('../src/lib/formatCodeGenProgress.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

const exports = {}
vm.runInThisContext(`(function (exports, module, require) { ${source} })`)(exports, { exports }, () => ({}))
const { formatCodeGenProgress, formatDuration, STALL_HINT_MS } = exports

function progress(extra) {
  return { label: "Écriture de l'application", stepIndex: 1, stepCount: 2, charsWritten: 0, thinking: true, idleMs: 0, ...extra }
}

test('les durées sont parlées, jamais en millisecondes', () => {
  assert.equal(formatDuration(0), '0 s')
  assert.equal(formatDuration(45_000), '45 s')
  assert.equal(formatDuration(72_000), '1 min 12')
  assert.equal(formatDuration(3_900_000), '1 h 05')
})

test("avant le premier appel au modèle, on dit qu'on prépare — pas « 0 % »", () => {
  const { title, detail } = formatCodeGenProgress(null, 4000)
  assert.match(title, /Préparation/)
  assert.equal(detail, '4 s')
})

test("l'étape en cours est annoncée avec son numéro et le total", () => {
  const { title } = formatCodeGenProgress(progress({ stepIndex: 2, stepCount: 2, label: 'Relecture du code' }), 1000)
  assert.equal(title, 'Étape 2 sur 2 · Relecture du code')
})

test('un modèle qui réfléchit le dit, au lieu de laisser un compteur figé à zéro', () => {
  const { detail } = formatCodeGenProgress(progress({ thinking: true, charsWritten: 0 }), 12_000)
  assert.match(detail, /12 s/)
  assert.match(detail, /réfléchit/)
})

test("les caractères écrits sont la preuve que ça avance", () => {
  const { detail } = formatCodeGenProgress(progress({ thinking: false, charsWritten: 4210 }), 72_000)
  assert.match(detail, /1 min 12/)
  // Espace insécable inséré par toLocaleString('fr-FR') : on vérifie les chiffres, pas le séparateur exact.
  assert.match(detail.replace(/\s/g, ' '), /4 210 caractères écrits/)
})

test('un silence prolongé du modèle passe devant tout le reste', () => {
  // C'est LE cas que Léo décrivait ("des fois c'est bloqué") : sans cette phrase, un écran qui n'affiche
  // plus qu'un compteur immobile ne dit pas si Jaris travaille encore.
  const { detail } = formatCodeGenProgress(progress({ thinking: false, charsWritten: 900, idleMs: STALL_HINT_MS + 25_000 }), 120_000)
  assert.match(detail, /rien reçu du modèle depuis 45 s/)
  assert.doesNotMatch(detail, /caractères écrits/)
})

test("juste en dessous du seuil, on n'alarme pas pour rien", () => {
  const { detail } = formatCodeGenProgress(progress({ thinking: false, charsWritten: 900, idleMs: STALL_HINT_MS - 1 }), 30_000)
  assert.match(detail, /caractères écrits/)
  assert.doesNotMatch(detail, /rien reçu/)
})
