import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * Charge un module TypeScript du dépôt dans le realm COURANT (étape 277), avec un faux pont pour ses imports.
 * Le realm courant plutôt que `vm.runInNewContext` : ces tests comparent des tableaux et des objets entiers
 * (`assert.deepEqual`), ce qui échoue entre deux realms (piège déjà noté dans CLAUDE.md, étape 32).
 * Un import absent du faux pont lève une erreur qui le nomme, au lieu d'un `undefined` silencieux — sauf le
 * traducteur (shared/i18n, étape 293), fourni d'office : presque tous les modules l'importent.
 */
export function loadTsModule(relativePath, modules = {}) {
  const source = ts.transpileModule(readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  const require = (name) => {
    if (name in modules) return modules[name]
    const i18n = i18nModules()
    if (name in i18n) return i18n[name]
    throw new Error(`Import non fourni au test : ${name} (${relativePath})`)
  }
  vm.runInThisContext(`(function (exports, require, module) {${source}\n})`)(module.exports, require, module)
  return module.exports
}

let i18n = null

/**
 * Le VRAI traducteur de Jaris, une seule instance pour tout le processus de test (en français par défaut, comme
 * Jaris avant tout réglage) : un test qui change la langue la change aussi pour le module qu'il teste. Le vrai
 * module plutôt qu'un bouchon `t = (key) => key` : un test qui attend « Recherche annulée. » doit lire ce texte.
 * Les clés sont les chemins d'import du dépôt, selon le dossier du module qui importe.
 */
export function i18nModules() {
  if (i18n) return i18n
  i18n = {}
  const fr = loadTsModule('shared/i18n/fr.ts')
  const languages = loadTsModule('shared/i18n/languages.ts')
  const index = loadTsModule('shared/i18n/index.ts', { './fr': fr, './languages': languages })
  Object.assign(i18n, {
    '../../shared/i18n': index,
    '../shared/i18n': index,
    './i18n': index,
    '../../shared/i18n/languages': languages,
    '../shared/i18n/languages': languages,
    './i18n/languages': languages,
    '../../shared/i18n/fr': fr
  })
  return i18n
}
