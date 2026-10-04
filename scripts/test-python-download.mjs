import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * Étape 234 (bêta de Jaris) : l'installation de Python passe par le téléchargeur commun (délai d'inactivité,
 * contrôle de taille) et explique un refus de GitHub au lieu d'afficher « HTTP 403 ».
 */
const source = readFileSync(new URL('../electron/services/pythonRuntime.ts', import.meta.url), 'utf8')

function load() {
  const out = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const stub = new Proxy(function () {}, { get: (_t, key) => (key === Symbol.toPrimitive ? () => '' : stub), apply: () => stub, construct: () => stub })
  const exports = {}
  vm.runInThisContext(`(function (exports, require, module) {\n${out}\n})`)(exports, () => stub, { exports })
  return exports
}

test('un refus de GitHub dit quoi faire (limite atteinte, pare-feu), jamais un simple « HTTP 403 »', () => {
  const { pythonListError } = load()
  assert.match(pythonListError(403, '0'), /réessaie dans une heure/)
  assert.match(pythonListError(429, '0'), /réessaie dans une heure/)
  assert.match(pythonListError(403, '42'), /pare-feu/)
  assert.match(pythonListError(500, null), /réessaie plus tard/)
})

test('Python se télécharge avec le téléchargeur commun (délai d’inactivité, taille vérifiée), plus avec une copie', () => {
  assert.match(source, /await downloadToFile\(await findPythonArchiveUrl\(\), archivePath, \{\s*onProgress:/)
  assert.ok(!/async function download\(/.test(source), 'l’ancienne copie sans délai a disparu')
})
