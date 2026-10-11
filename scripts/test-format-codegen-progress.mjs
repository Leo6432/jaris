import { withI18n } from './i18n-test-module.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * src/lib/formatCodeGenProgress.ts (étapes 99 et 288) : la ligne que Léo lit pendant qu'une génération tourne —
 * souvent la SEULE chose visible pendant plusieurs minutes. Fonction pure (le temps écoulé est un
 * paramètre), donc testable directement, comme formatRecentDate et formatUpdateProgress.
 */
const source = ts.transpileModule(readFileSync(new URL('../src/lib/formatCodeGenProgress.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

const exports = {}
vm.runInThisContext(`(function (exports, module, require) { ${source} })`)(exports, { exports }, withI18n(() => ({})))
const { formatCodeLive, formatDuration, STALL_HINT_MS, START_STALL_HINT_MS } = exports

function progress(extra) {
  return { label: "Écriture de l'application", stepIndex: 1, stepCount: 2, charsWritten: 0, thinking: true, idleMs: 0, phase: 'writing', ...extra }
}

test('les durées sont parlées, jamais en millisecondes', () => {
  assert.equal(formatDuration(0), '0 s')
  assert.equal(formatDuration(45_000), '45 s')
  assert.equal(formatDuration(72_000), '1 min 12')
  assert.equal(formatDuration(3_900_000), '1 h 05')
})

// Étape 288 (Léo : « on s'en fout [de l'étape et des caractères], mais mets ce qu'il fait en direct, par exemple code
// index.html plus 20 lignes ») : la ligne dit le FICHIER et ses lignes, plus jamais « Étape N » ni un compte de caractères.
test('un fichier en cours d\'écriture : le verbe, le fichier, et ses lignes', () => {
  const text = formatCodeLive({ kind: 'write', path: 'index.html', lines: 20 }, progress({ thinking: false, charsWritten: 900 }))
  assert.deepEqual(text, { action: 'Écrit', path: 'index.html', lines: '+20 lignes', elapsed: null, stall: null })
})

test('une modification et une relecture ont leur propre verbe ; une seule ligne reste au singulier', () => {
  assert.equal(formatCodeLive({ kind: 'edit', path: 'a.js', lines: 1 }, null).action, 'Modifie')
  assert.equal(formatCodeLive({ kind: 'edit', path: 'a.js', lines: 1 }, null).lines, '+1 ligne')
  assert.equal(formatCodeLive({ kind: 'review', path: 'index.html', lines: 3 }, null).action, 'Relit')
})

test('avant la première ligne reçue, pas de « +0 lignes »', () => {
  assert.equal(formatCodeLive({ kind: 'write', path: 'style.css', lines: 0 }, null).lines, null)
})

// Étape 291 (Léo : « pourquoi tu mets aucune nouvelle du modèle depuis 20 s, et après il écrit ») : avant son premier
// mot, le modèle se charge puis lit — la ligne le DIT, au lieu d'annoncer un silence suspect.
test('sans fichier en cours, la ligne dit où en est le modèle — jamais un numéro d’étape', () => {
  assert.equal(formatCodeLive(null, null).action, 'Prépare sa réponse…')
  assert.equal(formatCodeLive(null, progress({ phase: 'loading' })).action, 'Charge le modèle…')
  assert.equal(formatCodeLive(null, progress({ phase: 'reading' })).action, 'Prépare sa réponse…')
  assert.equal(formatCodeLive(null, progress({ phase: 'thinking' })).action, 'Réfléchit…')
  assert.equal(formatCodeLive(null, progress({ phase: 'writing', thinking: false, charsWritten: 300 })).action, 'Écrit…')
  for (const text of [formatCodeLive(null, progress()), formatCodeLive({ kind: 'write', path: 'index.html', lines: 4 }, progress())]) {
    assert.doesNotMatch(Object.values(text).join(' '), /Étape|caractères/)
  }
})

test('avant le premier mot, 45 s de chargement ne sont pas « rien reçu » : juste le temps qui passe', () => {
  for (const phase of ['loading', 'reading']) {
    const text = formatCodeLive(null, progress({ phase, idleMs: 45_000 }))
    assert.equal(text.stall, null, `${phase} : alerte à 45 s`)
    assert.equal(text.elapsed, '45 s')
  }
  // Les toutes premières secondes, rien du tout : la ligne vient d'apparaître.
  assert.equal(formatCodeLive(null, progress({ phase: 'loading', idleMs: 4_000 })).elapsed, null)
  // Au-delà de 2 minutes sans le moindre mot, là on le dit.
  const long = formatCodeLive(null, progress({ phase: 'loading', idleMs: START_STALL_HINT_MS + 5_000 }))
  assert.equal(long.stall, 'toujours rien après 2 min 05')
  assert.equal(long.elapsed, null)
})

test('un modèle qui écrivait puis se tait : le silence est dit en clair', () => {
  // C'est LE cas que Léo décrivait (étape 99, « des fois c'est bloqué ») : sans cette phrase, une ligne immobile ne
  // dit pas si Jaris travaille encore.
  const text = formatCodeLive({ kind: 'write', path: 'index.html', lines: 12 }, progress({ idleMs: STALL_HINT_MS + 15_000 }))
  assert.equal(text.stall, 'rien reçu du modèle depuis 45 s')
  assert.equal(text.path, 'index.html')
  assert.equal(formatCodeLive(null, progress({ phase: 'thinking', idleMs: STALL_HINT_MS + 15_000 })).stall, 'rien reçu du modèle depuis 45 s')
})

test("juste en dessous du seuil, on n'alarme pas pour rien", () => {
  assert.equal(formatCodeLive(null, progress({ idleMs: STALL_HINT_MS - 1 })).stall, null)
  assert.equal(formatCodeLive(null, progress({ phase: 'reading', idleMs: START_STALL_HINT_MS - 1 })).stall, null)
})
