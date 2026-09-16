import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * src/lib/formatContextLength.ts : affichage court du curseur de longueur de contexte (Options -> Modèles),
 * même convention que le curseur "Context length" de l'app Ollama ("4k", "128k"...). Fonction pure, testable
 * directement ici sans navigateur.
 */
const source = ts.transpileModule(readFileSync(new URL('../src/lib/formatContextLength.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

const exports = {}
vm.runInThisContext(`(function (exports, module, require) { ${source} })`)(exports, { exports }, () => ({}))
const { formatContextLength } = exports

test('formatContextLength affiche les paliers comme le curseur Ollama (k = 1024, pas 1000)', () => {
  assert.equal(formatContextLength(4096), '4k')
  assert.equal(formatContextLength(8192), '8k')
  assert.equal(formatContextLength(16384), '16k')
  // Piège évité : diviser par 1000 aurait donné "33k" ici, pas "32k" comme l'affiche Ollama.
  assert.equal(formatContextLength(32768), '32k')
  assert.equal(formatContextLength(65536), '64k')
  assert.equal(formatContextLength(131072), '128k')
  assert.equal(formatContextLength(262144), '256k')
})

test('formatContextLength reste correct sous 1024 tokens, sans arrondi trompeur', () => {
  assert.equal(formatContextLength(0), '0')
  assert.equal(formatContextLength(512), '512')
})
