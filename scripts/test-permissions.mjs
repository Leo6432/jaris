import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * electron/services/permissions.ts (étape 271, Léo : « on peut pas cliquer sur agrandir ») : le bouton plein
 * écran du lecteur vidéo passe par la permission `fullscreen` d'Electron, que Jaris refusait (seul `media`
 * était accordé). Vérifié aussi avec le vrai Electron : refus avec l'ancienne règle, plein écran avec celle-ci.
 */
const source = ts.transpileModule(readFileSync(new URL('../electron/services/permissions.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

const exports = {}
vm.runInThisContext(`(function (exports, module, require) { ${source} })`)(exports, { exports }, () => ({}))
const { isPermissionAllowed } = exports

test('le plein écran (lecteur vidéo) et le micro sont accordés', () => {
  assert.equal(isPermissionAllowed('fullscreen'), true)
  assert.equal(isPermissionAllowed('media'), true)
})

test('tout le reste reste refusé', () => {
  for (const permission of ['geolocation', 'notifications', 'clipboard-read', 'midi', 'pointerLock', 'openExternal', 'display-capture']) {
    assert.equal(isPermissionAllowed(permission), false, permission)
  }
})

test('main.ts passe bien par cette règle (et ne la recopie pas à côté)', () => {
  const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8')
  assert.match(main, /setPermissionRequestHandler\(\(_webContents, permission, callback\) => \{\s*callback\(isPermissionAllowed\(permission\)\)/)
})
