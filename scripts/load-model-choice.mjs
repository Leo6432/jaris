import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * Charge le VRAI electron/services/modelChoice.ts (étape 141) pour les faux ponts de modules des tests
 * d'assistant.ts et de codeGenerator.ts. Le module est pur (aucun import à l'exécution), donc aucun faux pont
 * à lui fournir — et le vrai module plutôt qu'un bouchon : un bouchon qui répond toujours « Auto » ne
 * vérifierait jamais que le choix à la main est réellement pris en compte.
 */
export function loadModelChoice() {
  const source = ts.transpileModule(readFileSync(new URL('../electron/services/modelChoice.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  vm.runInThisContext(`(function (exports, require, module) {${source}\n})`)(module.exports, () => ({}), module)
  return module.exports
}

export const modelChoiceModule = loadModelChoice()
