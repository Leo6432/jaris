import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * shared/imageGallery.ts (étape 200, mode Image) : nom, date et avancement d'une image dessinée, lus sur son
 * nom de fichier et sur le journal du moteur. Et surtout : seul un NOM de fichier PNG passe, jamais un chemin
 * (l'écran l'envoie au main pour lire ou SUPPRIMER un fichier).
 */
const source = ts.transpileModule(readFileSync(new URL('../shared/imageGallery.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const exports = {}
vm.runInThisContext(`(function (exports, module, require) { ${source} })`)(exports, { exports }, () => ({}))
const { isGeneratedImageFileName, imageTimestampFromFileName, imageLabelFromFileName, imageStepFromLog } = exports

const NAME = '2026-09-28T17-22-15-un-chat-astronaute-sur-la-lune.png'

test('un vrai nom d’image dessinée est accepté', () => {
  assert.equal(isGeneratedImageFileName(NAME), true)
  assert.equal(isGeneratedImageFileName('2026-09-28T17-22-15-image.png'), true)
})

test('jamais un chemin, une remontée ou autre chose qu’un PNG (suppression côté main)', () => {
  for (const bad of ['../profile.json', '..\\profile.json', 'C:\\Windows\\a.png', '/etc/a.png', 'sous/dossier.png', '..png', 'a..png', 'image.jpg', 'image.png.exe', '', null, 42]) {
    assert.equal(isGeneratedImageFileName(bad), false, String(bad))
  }
})

test('la date vient du nom (heure universelle), et le libellé de la description', () => {
  assert.equal(imageTimestampFromFileName(NAME), Date.parse('2026-09-28T17:22:15Z'))
  assert.equal(imageLabelFromFileName(NAME), 'Un chat astronaute sur la lune')
  assert.equal(imageLabelFromFileName('2026-09-28T17-22-15-image.png'), 'Image')
  assert.equal(imageTimestampFromFileName('dessin.png'), null)
  assert.equal(imageLabelFromFileName('dessin.png'), 'Dessin')
})

test('la barre suit « Dessin : étape 2 sur 4 », les autres lignes restent du texte', () => {
  assert.deepEqual({ ...imageStepFromLog('Dessin : étape 2 sur 4') }, { step: 2, total: 4 })
  assert.equal(imageStepFromLog('Préparation du dessin…'), null)
  assert.equal(imageStepFromLog('étape 5 sur 4'), null)
})
