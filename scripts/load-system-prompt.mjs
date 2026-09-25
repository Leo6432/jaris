import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * Charge le VRAI electron/services/systemPrompt.ts (étape 162) pour les faux ponts de modules des tests
 * d'assistant.ts, et pour vérifier que la copie des consignes dans scripts/benchmark-cases.mjs suit l'original.
 * Module pur (aucun import) : aucun faux pont à lui fournir.
 */
export function loadSystemPrompt() {
  const source = ts.transpileModule(readFileSync(new URL('../electron/services/systemPrompt.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  vm.runInThisContext(`(function (exports, require, module) {${source}\n})`)(module.exports, () => ({}), module)
  return module.exports
}

export const systemPromptModule = loadSystemPrompt()
