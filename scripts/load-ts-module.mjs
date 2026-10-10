import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * Charge un module TypeScript du dépôt dans le realm COURANT (étape 277), avec un faux pont pour ses imports.
 * Le realm courant plutôt que `vm.runInNewContext` : ces tests comparent des tableaux et des objets entiers
 * (`assert.deepEqual`), ce qui échoue entre deux realms (piège déjà noté dans CLAUDE.md, étape 32).
 * Un import absent du faux pont lève une erreur qui le nomme, au lieu d'un `undefined` silencieux.
 */
export function loadTsModule(relativePath, modules = {}) {
  const source = ts.transpileModule(readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  const require = (name) => {
    if (!(name in modules)) throw new Error(`Import non fourni au test : ${name} (${relativePath})`)
    return modules[name]
  }
  vm.runInThisContext(`(function (exports, require, module) {${source}\n})`)(module.exports, require, module)
  return module.exports
}
