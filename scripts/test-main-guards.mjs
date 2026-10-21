import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Étape 328 : garde-fous du processus principal (main.ts), trouvés par une relecture complète.
 * - Un fichier glissé sur une fenêtre remplaçait toute l'interface ; un lien partait au système quel que soit son
 *   protocole.
 * - La touche + du pavé numérique était retirée à toutes les applications, même décochée dans Options.
 * - « Ouvrir le dossier » d'une application ouvrait n'importe quel chemin reçu de l'écran.
 * - Options réécrivait tout le profil avec une copie prise à son ouverture.
 */

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const main = read('electron/main.ts')
const { isSameDocument, isWebUrl } = loadTsModule('electron/services/navigationGuard.ts')

test('seules les adresses web s’ouvrent dans le navigateur', () => {
  for (const url of ['https://github.com/login/device', 'http://localhost:3000/']) assert.equal(isWebUrl(url), true, url)
  for (const url of ['file:///C:/Windows/System32/calc.exe', 'ms-settings:privacy', 'javascript:alert(1)', 'mailto:a@b.c', 'pas une adresse', '']) {
    assert.equal(isWebUrl(url), false, url)
  }
})

test('seule la page déjà ouverte (ou son ancre) peut être rechargée dans une fenêtre', () => {
  const page = 'file:///C:/Program%20Files/Jaris/resources/app.asar/out/renderer/index.html?mode=full'
  assert.equal(isSameDocument(`${page}#options`, page), true)
  assert.equal(isSameDocument(page, page), true)
  assert.equal(isSameDocument('file:///C:/Users/leo/Documents/facture.pdf', page), false, 'un fichier glissé ne remplace pas Jaris')
  assert.equal(isSameDocument('https://example.com/', page), false)
  assert.equal(isSameDocument('pas une adresse', page), false)
})

test('toutes les fenêtres passent par la même garde, et plus aucune n’ouvre un lien sans contrôle', () => {
  const guardAt = main.indexOf("app.on('web-contents-created'")
  assert.ok(guardAt > -1, 'garde absente')
  assert.ok(guardAt < main.indexOf('\napp.whenReady().then('), 'posée avant la création de la première fenêtre')
  const guard = main.slice(guardAt, main.indexOf('\n})\n', guardAt))
  assert.match(guard, /will-navigate[\s\S]*isSameDocument[\s\S]*event\.preventDefault\(\)/)
  // Étape 337 : jamais pour une page de recherche cachée (webSearch.ts), même une adresse web.
  assert.match(guard, /setWindowOpenHandler[\s\S]*if \(!isSearchContents\(contents\.id\) && isWebUrl\(url\)\) void shell\.openExternal\(url\)[\s\S]*action: 'deny'/)
  assert.equal(main.match(/setWindowOpenHandler/g).length, 1, 'un seul gestionnaire, celui de la garde')
  assert.doesNotMatch(main, /shell\.openExternal\(details\.url\)/)
})

test('la touche + n’est réservée que si elle est activée, et jamais quand Jaris a le focus', () => {
  const sync = main.slice(main.indexOf('function syncWakeShortcut('), main.indexOf('function setWakeShortcutWanted('))
  assert.match(sync, /const wanted = wakeShortcutWanted && BrowserWindow\.getFocusedWindow\(\) === null/)
  assert.match(sync, /globalShortcut\.unregister\(WAKE_SHORTCUT\)/)
  const code = main.split('\n').filter((line) => !/^\s*(\*|\/\/)/.test(line)).join('\n')
  assert.equal(code.match(/globalShortcut\.register\(/g).length, 1, 'enregistrée à un seul endroit, sous condition')
  assert.match(main, /app\.on\('browser-window-focus', syncWakeShortcutSoon\)/)
  assert.match(main, /app\.on\('browser-window-blur', syncWakeShortcutSoon\)/)
  assert.match(main, /readProfileAtStartup\(\)\n\s*if \(profile === undefined\) return\n\s*setWakeShortcutWanted\(profile\?\.activationKeyEnabled !== false\)/)
  for (const channel of ['IPC_CHANNELS.saveProfile,', 'IPC_CHANNELS.patchProfile,']) {
    const at = main.indexOf(channel)
    assert.ok(at > -1, channel)
    assert.match(main.slice(at, at + 400), /setWakeShortcutWanted\(/, `${channel} remet la touche à jour`)
  }
})

test('« Ouvrir le dossier » n’ouvre que le dossier d’une application générée', () => {
  const at = main.indexOf('IPC_CHANNELS.openGeneratedApp,')
  assert.match(main.slice(at, at + 400), /shell\.openPath\(path \? assertGeneratedAppDir\(path\) : getGeneratedAppsDir\(\)\)/)
})

test('Options n’envoie que les champs changés, jamais une copie entière du profil', () => {
  const options = read('src/components/OptionsMenu.tsx')
  assert.doesNotMatch(options, /saveProfile\(/, 'plus aucune réécriture du profil entier depuis Options')
  assert.match(options, /window\.jaris\.patchProfile\(change\)/)
})
