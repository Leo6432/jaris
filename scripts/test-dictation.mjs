import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * Étape 276 (Léo : « quand on clique sur le micro dans le Chat, ça ne doit pas aller en vocal, ça doit enregistrer
 * et transcrire en texte ») : la partie pure de la dictée. Le WAV produit par le champ de saisie doit être
 * accepté TEL QUEL par le contrôle que Jaris fait avant de le transcrire (isExpectedWav, phoneServer.ts) —
 * deux fichiers, une seule forme attendue.
 */
function load(path, modules = {}) {
  const source = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const exports = {}
  vm.runInThisContext(`(function (exports, module, require) { ${source} })`)(exports, { exports }, (name) => modules[name] ?? require(name))
  return exports
}
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const { downsampleTo16k, encodeWav16k, appendDictation } = load('../src/lib/dictation.ts')

test('48 kHz ramené à 16 kHz : un tiers des échantillons, la moyenne de chaque groupe', () => {
  const chunk = new Float32Array([0.3, 0.3, 0.3, -0.6, -0.6, -0.6])
  const out = downsampleTo16k([chunk], 6, 48000)
  assert.equal(out.length, 2)
  assert.ok(Math.abs(out[0] - 0.3) < 1e-6 && Math.abs(out[1] + 0.6) < 1e-6)
  // Déjà à 16 kHz : inchangé.
  assert.equal(downsampleTo16k([new Float32Array([0.1, 0.2])], 2, 16000).length, 2)
})

test('le WAV de la dictée est accepté tel quel par le contrôle de Jaris (16 kHz mono 16 bits)', () => {
  const wav = Buffer.from(encodeWav16k(new Float32Array(1600).fill(0.5)))
  assert.equal(wav.length, 44 + 1600 * 2)
  const { isExpectedWav } = load('../electron/services/phoneServer.ts', {})
  assert.equal(isExpectedWav(wav), true)
  // Et les valeurs hors bornes sont écrêtées, pas repliées.
  const loud = Buffer.from(encodeWav16k(new Float32Array([2, -2])))
  assert.equal(loud.readInt16LE(44), 0x7fff)
  assert.equal(loud.readInt16LE(46), -0x8000)
})

test('le texte dicté s’ajoute à ce qui est déjà écrit, séparé par une espace', () => {
  assert.equal(appendDictation('', ' bonjour Jaris '), 'bonjour Jaris')
  assert.equal(appendDictation('Écris', 'un mail'), 'Écris un mail')
  assert.equal(appendDictation('Écris   \n', 'un mail'), 'Écris un mail')
  assert.equal(appendDictation('déjà là', '   '), 'déjà là', 'une transcription vide ne change rien')
})
