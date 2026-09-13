import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * findBestMatch/openApp (appLauncher.ts) : reproduit le vrai bug rapporté par Léo ("Ouvre le bloc-notes et
 * écris bonjour" -> Jaris a ouvert "X", le réseau social, sans rien taper). Un `app_name` vide/absent (ex:
 * argument oublié par le petit modèle local lors de l'appel à open_app) faisait matcher TOUTE application
 * installée (`"n'importe quoi".includes('')` vaut toujours `true`), et le tri par nom le plus court élisait
 * alors le nom le plus court de toute la machine — "X" dans le cas de Léo — sans aucun rapport avec la
 * demande. `child_process` est mocké (exec/spawn ne sont jamais réellement appelés dans ces tests : soit la
 * requête est vide et openApp ressort avant, soit findBestMatch est testée directement, en pur).
 */
const source = ts.transpileModule(readFileSync(new URL('../electron/services/appLauncher.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

const modules = {
  child_process: { exec: () => {}, spawn: () => {} },
  util: { promisify: (fn) => fn }
}
const exports = {}
vm.runInNewContext(source, { exports, require: (name) => modules[name], module: { exports }, process }, {})
const { findBestMatch, openApp } = exports

const REAL_WORLD_APPS = [
  { Name: 'Bloc-notes', AppID: 'notepad' },
  { Name: 'X', AppID: 'twitter' },
  { Name: 'Google Chrome', AppID: 'chrome' },
  { Name: 'Calculatrice', AppID: 'calc' },
  { Name: 'Discord', AppID: 'discord' }
]

test('reproduit le vrai cas rapporté par Léo : une requête vide ne doit JAMAIS matcher "X"', () => {
  assert.equal(findBestMatch(REAL_WORLD_APPS, ''), undefined)
})

for (const blank of ['', '   ', '\t\n']) {
  test(`findBestMatch ne matche rien sur une requête vide/blanche : ${JSON.stringify(blank)}`, () => {
    assert.equal(findBestMatch(REAL_WORLD_APPS, blank), undefined)
  })
}

test('findBestMatch trouve toujours la vraie correspondance sur une requête normale', () => {
  assert.equal(findBestMatch(REAL_WORLD_APPS, 'bloc-notes')?.Name, 'Bloc-notes')
  assert.equal(findBestMatch(REAL_WORLD_APPS, 'discord')?.Name, 'Discord')
  assert.equal(findBestMatch(REAL_WORLD_APPS, 'chrome')?.Name, 'Google Chrome')
})

test('findBestMatch renvoie undefined pour un nom qui ne correspond vraiment à rien', () => {
  // Évite tout caractère présent dans un nom d'app court de la liste (notamment "x" de "X") : un vrai nom à
  // une seule lettre reste sujet à des faux positifs par sous-chaîne dès que cette lettre apparaît QUELQUE
  // PART dans la requête (ex: "logiciel-imaginaire-xyz" contient "x") — un risque distinct de celui corrigé
  // ici (requête VIDE), déjà présent avant ce correctif et pas dans le périmètre du bug rapporté par Léo.
  assert.equal(findBestMatch(REAL_WORLD_APPS, 'logiciel-imaginaire-9999'), undefined)
})

for (const blank of ['', '   ']) {
  test(`openApp renvoie un message dédié pour un nom vide/blanc, sans jamais lister ni lancer d'app : ${JSON.stringify(blank)}`, async () => {
    const result = await openApp(blank)
    assert.equal(result, "Aucun nom d'application n'a été précisé : impossible de savoir laquelle ouvrir.")
  })
}
