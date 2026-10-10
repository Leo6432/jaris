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
vm.runInThisContext(`(function (exports, module, require) { ${source} })`)(exports, { exports }, () => ({}))
const { formatCodeLive, formatDuration, STALL_HINT_MS } = exports

function progress(extra) {
  return { label: "Écriture de l'application", stepIndex: 1, stepCount: 2, charsWritten: 0, thinking: true, idleMs: 0, ...extra }
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
  assert.deepEqual(text, { action: 'Écrit', path: 'index.html', lines: '+20 lignes', stall: null })
})

test('une modification et une relecture ont leur propre verbe ; une seule ligne reste au singulier', () => {
  assert.equal(formatCodeLive({ kind: 'edit', path: 'a.js', lines: 1 }, null).action, 'Modifie')
  assert.equal(formatCodeLive({ kind: 'edit', path: 'a.js', lines: 1 }, null).lines, '+1 ligne')
  assert.equal(formatCodeLive({ kind: 'review', path: 'index.html', lines: 3 }, null).action, 'Relit')
})

test('avant la première ligne reçue, pas de « +0 lignes »', () => {
  assert.equal(formatCodeLive({ kind: 'write', path: 'style.css', lines: 0 }, null).lines, null)
})

test("sans fichier en cours, on dit qu'il réfléchit (ou qu'il travaille) — jamais un numéro d'étape", () => {
  assert.equal(formatCodeLive(null, null).action, 'Réfléchit…')
  assert.equal(formatCodeLive(null, progress({ thinking: true })).action, 'Réfléchit…')
  assert.equal(formatCodeLive(null, progress({ thinking: false, charsWritten: 300 })).action, 'Travaille…')
  for (const text of [formatCodeLive(null, progress()), formatCodeLive({ kind: 'write', path: 'index.html', lines: 4 }, progress())]) {
    assert.doesNotMatch(Object.values(text).join(' '), /Étape|caractères/)
  }
})

test('un silence prolongé du modèle est dit en clair', () => {
  // C'est LE cas que Léo décrivait (étape 99, « des fois c'est bloqué ») : sans cette phrase, une ligne immobile ne
  // dit pas si Jaris travaille encore.
  const text = formatCodeLive({ kind: 'write', path: 'index.html', lines: 12 }, progress({ idleMs: STALL_HINT_MS + 25_000 }))
  assert.equal(text.stall, 'rien reçu du modèle depuis 45 s')
  assert.equal(text.path, 'index.html')
})

test("juste en dessous du seuil, on n'alarme pas pour rien", () => {
  assert.equal(formatCodeLive(null, progress({ idleMs: STALL_HINT_MS - 1 })).stall, null)
})
