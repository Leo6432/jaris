import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Étape 324 : une trentaine d'écrans affichaient « Error invoking remote method 'jaris:…': Error: » devant le vrai
 * message, en anglais, parce que seuls quelques-uns retiraient ce préfixe ajouté par Electron. Il est maintenant
 * retiré à la source, dans le preload, pour TOUS les appels.
 */
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('le préfixe technique d’Electron est retiré, le message écrit pour Léo reste intact', () => {
  const { ipcErrorMessage } = loadTsModule('shared/ipcError.ts')
  const raw = new Error("Error invoking remote method 'jaris:installImageStudio': Error: Pas assez de place sur le disque : il faut 5 Go.")
  assert.equal(ipcErrorMessage(raw), 'Pas assez de place sur le disque : il faut 5 Go.')
  assert.equal(ipcErrorMessage(new Error("Error invoking remote method 'jaris:x': TypeError: boum")), 'boum')
  assert.equal(ipcErrorMessage(new Error('Message déjà propre.')), 'Message déjà propre.')
  assert.equal(ipcErrorMessage('texte'), 'texte')
})

test('chaque appel du preload passe par le nettoyage : aucun ipcRenderer.invoke direct hors de la fonction invoke', () => {
  const preload = read('electron/preload.ts')
  const helper = preload.match(/function invoke\(channel: string, \.\.\.args: unknown\[\]\)[^]*?\n\}\n/)
  assert.ok(helper, 'la fonction invoke existe')
  assert.match(helper[0], /ipcErrorMessage\(err\)/, 'elle nettoie le message')
  const outside = preload.replace(helper[0], '')
  assert.equal((outside.match(/ipcRenderer\.invoke\(/g) ?? []).length, 0, 'aucun appel ne contourne le nettoyage')
  assert.ok((outside.match(/\binvoke\(IPC_CHANNELS\./g) ?? []).length > 50, 'les appels passent bien par invoke')
})
