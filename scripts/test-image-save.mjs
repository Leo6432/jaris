import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * « Télécharger l'image » sous une image dessinée (étape 185). Le renderer envoie ce qu'il affiche : seul un
 * VRAI PNG en base64 est accepté, jamais autre chose — c'est Léo qui choisit où l'écrire, dans la fenêtre de
 * Windows.
 */
const source = ts.transpileModule(readFileSync(new URL('../electron/services/imageSave.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const module = { exports: {} }
vm.runInThisContext(`(function (exports, module, Buffer) { ${source} })`)(module.exports, module, Buffer)
const { decodePngDataUrl, defaultImageFileName, withPngExtension } = module.exports

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAAAAADhZOFXAAAAEElEQVR4nGNoaGBgYGBgAAAHCAEBw3tAvAAAAABJRU5ErkJggg=='

test('un vrai PNG est décodé octet pour octet', () => {
  const bytes = decodePngDataUrl(`data:image/png;base64,${PNG}`)
  assert.ok(bytes)
  assert.equal(Buffer.compare(bytes, Buffer.from(PNG, 'base64')), 0)
})

test('rien d’autre qu’un PNG n’est accepté', () => {
  for (const bad of [
    `data:image/jpeg;base64,${PNG}`,
    `data:text/html;base64,${Buffer.from('<script>').toString('base64')}`,
    // Annoncé PNG mais ce n'en est pas un (signature absente).
    `data:image/png;base64,${Buffer.from('pas une image').toString('base64')}`,
    'C:\\Windows\\System32\\config',
    '../../profile.json',
    ''
  ]) {
    assert.equal(decodePngDataUrl(bad), null, bad.slice(0, 40))
  }
})

test('nom proposé lisible, et l’extension .png toujours garantie', () => {
  assert.equal(defaultImageFileName(new Date(2026, 8, 27, 14, 5)), 'jaris-image-2026-09-27-14h05.png')
  assert.equal(withPngExtension('C:\\Users\\Léo\\Images\\chat'), 'C:\\Users\\Léo\\Images\\chat.png')
  assert.equal(withPngExtension('D:\\photo.PNG'), 'D:\\photo.PNG')
})
