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
const { findBestMatch, openApp, didAppLaunch } = exports

const REAL_WORLD_APPS = [
  { Name: 'Bloc-notes', AppID: 'notepad' },
  { Name: 'X', AppID: 'twitter' },
  { Name: 'Google Chrome', AppID: 'chrome' },
  { Name: 'Calculatrice', AppID: 'calc' },
  { Name: 'Paramètres', AppID: 'settings' },
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

/**
 * Deuxième signalement de Léo, le même jour : « même quand je dit ouvre l'application youtube ou bloc note
 * il dit c'est lancé mais il lance pas ». Ces graphies-là (celles d'une transcription vocale : sans trait
 * d'union, sans accent, au singulier) ne matchaient RIEN avant la normalisation — mesuré avant de corriger,
 * seule "bloc-notes" exactement orthographiée fonctionnait.
 */
for (const spoken of ['bloc note', 'bloc notes', 'blocnotes', 'bloc-notes', 'le bloc-notes', 'Bloc-Notes', 'notepad']) {
  test(`la graphie parlée trouve bien le Bloc-notes : ${JSON.stringify(spoken)}`, () => {
    assert.equal(findBestMatch(REAL_WORLD_APPS, spoken)?.Name, 'Bloc-notes')
  })
}

for (const spoken of ['parametres', 'Paramètres', 'settings']) {
  test(`accents et langue ne bloquent plus l'appariement : ${JSON.stringify(spoken)}`, () => {
    assert.equal(findBestMatch(REAL_WORLD_APPS, spoken)?.Name, 'Paramètres')
  })
}

/**
 * Le vrai piège de la normalisation, attrapé en la testant AVANT de livrer : "X" (1 caractère, réellement
 * installé chez Léo, et déjà ouvert à tort une fois) matchait par sous-chaîne dès que la lettre apparaissait
 * n'importe où dans la demande — "ouvre explorateur", "excel" et "le fichier texte" élisaient tous "X" parce
 * que le tri prenait ensuite le nom le plus court. La comparaison se fait donc sur des MOTS entiers, avec une
 * longueur minimale pour les fragments.
 */
for (const query of ['ouvre explorateur', 'excel', 'le fichier texte', 'luxe']) {
  test(`un nom d'app d'une lettre ne se glisse plus dans un mot sans rapport : ${JSON.stringify(query)}`, () => {
    assert.equal(findBestMatch(REAL_WORLD_APPS, query), undefined)
  })
}

test('"X" reste ouvrable en le demandant par son nom exact', () => {
  assert.equal(findBestMatch(REAL_WORLD_APPS, 'x')?.Name, 'X')
  assert.equal(findBestMatch(REAL_WORLD_APPS, 'X')?.Name, 'X')
})

test('le nom le plus explicatif gagne quand deux applications se ressemblent', () => {
  const apps = [...REAL_WORLD_APPS, { Name: 'Notes', AppID: 'notes' }]
  // "bloc notes" ne doit pas élire "Notes" (plus court) alors que "Bloc-notes" couvre toute la demande.
  assert.equal(findBestMatch(apps, 'bloc notes')?.Name, 'Bloc-notes')
  assert.equal(findBestMatch(apps, 'notes rapides')?.Name, 'Notes')
})

test('une partie du nom suffit toujours à trouver une application', () => {
  assert.equal(findBestMatch(REAL_WORLD_APPS, 'chrome')?.Name, 'Google Chrome')
  assert.equal(findBestMatch(REAL_WORLD_APPS, 'google chrome')?.Name, 'Google Chrome')
})

test('une application vraiment absente reste absente (pas de faux positif de secours)', () => {
  // YouTube n'est pas installé dans cette liste : findBestMatch ne doit rien inventer, c'est ce qui déclenche
  // le message d'échec relayé tel quel à Léo (court-circuit open_app dans assistant.ts).
  assert.equal(findBestMatch(REAL_WORLD_APPS, 'youtube'), undefined)
})

test("didAppLaunch ne reconnaît que le vrai message de succès d'openApp", () => {
  assert.equal(didAppLaunch('Bloc-notes a été lancé.'), true)
  assert.equal(didAppLaunch('Je n\'ai trouvé aucune application nommée "youtube" installée sur cette machine.'), false)
  assert.equal(didAppLaunch("Aucun nom d'application n'a été précisé : impossible de savoir laquelle ouvrir."), false)
  assert.equal(didAppLaunch('Échec de l\'ouverture de "Discord" : spawn ENOENT'), false)
  assert.equal(didAppLaunch('Impossible de lister les applications installées : boom'), false)
})
