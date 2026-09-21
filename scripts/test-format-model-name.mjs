import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * src/lib/formatModelName.ts, étape 133 : Léo — "met pas ai9stars_G9v3-3B mais G9v3-3B". L'algorithme
 * générique (retirer le suffixe "-GGUF" d'un import hf.co/<org>/<dépôt>) ne peut pas deviner qu'un préfixe
 * comme "ai9stars_" dans le nom du DÉPÔT (choisi par le quantifieur, pas par le modèle) est le nom de
 * l'organisation d'origine à retirer — d'où une table d'exceptions explicite, testée ici pour ne jamais
 * redevenir "ai9stars_G9v3-3B" au prochain changement de cette fonction.
 */
const source = ts.transpileModule(readFileSync(new URL('../src/lib/formatModelName.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

const exports = {}
vm.runInThisContext(`(function (exports, module, require) { ${source} })`)(exports, { exports }, () => ({}))
const { formatModelName } = exports

test('un tag Ollama officiel (sans préfixe hf.co/) reste affiché tel quel', () => {
  assert.equal(formatModelName('qwen3.5:9b'), 'qwen3.5:9b')
  assert.equal(formatModelName('granite4.2:3b'), 'granite4.2:3b')
})

test('un import hf.co/<org>/<dépôt>:<quant> générique retire juste le suffixe -GGUF et affiche le quant', () => {
  assert.equal(formatModelName('hf.co/ggml-org/GLM-4.6V-Flash-GGUF:Q4_K_M'), 'GLM-4.6V-Flash (Q4_K_M)')
})

test('un import hf.co/<org>/<dépôt>-GGUF (sans quant) retire juste le suffixe -GGUF', () => {
  assert.equal(formatModelName('hf.co/openbmb/MiniCPM5-1B-GGUF'), 'MiniCPM5-1B')
})

test('G9v3-3B (bartowski, exception explicite) s\'affiche sans le préfixe d\'organisation "ai9stars_"', () => {
  assert.equal(formatModelName('hf.co/bartowski/ai9stars_G9v3-3B-GGUF'), 'G9v3-3B')
})
