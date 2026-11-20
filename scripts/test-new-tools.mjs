import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Étape 508 (Léo : « oui tout », pour les outils qui manquaient à Jaris) : raccourcis clavier, fermer ou remettre devant
 * une application, volume exact, réglages de Windows, voir et annuler les rappels, fichiers. Les vrais modules, avec un
 * faux PowerShell qui note ce qu'il reçoit (le vrai Windows tourne dans la CI) — et les vrais fichiers sur le disque
 * pour les verrous des fichiers.
 */
const nodeRequire = createRequire(import.meta.url)
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

// --- Raccourcis clavier et défilement (inputControl.ts), avec un faux spawn qui garde le script et l'environnement.
const spawned = []
function fakeSpawn(_cmd, args, opts) {
  const { EventEmitter } = nodeRequire('node:events')
  const proc = new EventEmitter()
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  spawned.push({ script: args.at(-1), env: opts?.env ?? {} })
  setImmediate(() => proc.emit('close', 0))
  return proc
}
const input = loadTsModule('electron/services/inputControl.ts', { child_process: { spawn: fakeSpawn, execFile: () => {} } })

test('raccourcis : une liste fixe de raccourcis permis (relecture adverse) ; une lettre seule s’écrit avec type_text', () => {
  assert.deepEqual(input.parseKeys('ctrl+c'), { modifiers: [0x11], vk: 0x43 })
  assert.deepEqual(input.parseKeys(' Alt + Tab '), { modifiers: [0x12], vk: 0x09 })
  assert.deepEqual(input.parseKeys('ctrl+shift+t'), { modifiers: [0x11, 0x10], vk: 0x54 })
  assert.deepEqual(input.parseKeys('win+d'), { modifiers: [0x5b], vk: 0x44 })
  assert.deepEqual(input.parseKeys('F5'), { modifiers: [], vk: 0x74 })
  assert.deepEqual(input.parseKeys('entrée'), { modifiers: [], vk: 0x0d })
  assert.deepEqual(input.parseKeys('Shift + Ctrl + T'), { modifiers: [0x10, 0x11], vk: 0x54 }, 'l’ordre des modificateurs ne compte pas')
  // Tout ce qui mène à lancer une commande ou ferme à l'aveugle : Exécuter, menu Démarrer, Gestionnaire des tâches,
  // alt+f4, barre des tâches (win+1…9), verrouillage.
  for (const refused of ['win+r', 'win+x', 'win+s', 'win+e', 'win+1', 'win+l', 'ctrl+échap', 'ctrl+shift+échap', 'alt+f4', 'ctrl+alt+suppr', 'ctrl+1']) {
    assert.equal(input.parseKeys(refused), null, refused)
  }
  // Clés d'objet JavaScript : jamais prises pour une touche.
  for (const refused of ['constructor', '__proto__', 'ctrl+constructor', 'tostring+c', 'a', '7', 'ctrl+ctrl+c', 'hyper+c', 'ctrl+', '', 'F13', 'ctrl+é']) {
    assert.equal(input.parseKeys(refused), null, refused)
  }
})

test('un raccourci part en une combinaison (modificateurs enfoncés puis relâchés), une touche seule comme avant', async () => {
  spawned.length = 0
  assert.equal(await input.pressKey('ctrl+s'), 'Touche "ctrl+s" pressée.')
  assert.match(spawned[0].script, /\[JarisInput\]::KeyCombo\(\[uint16\[\]\]@\(17\), 83\)$/)
  await input.pressKey('entrée')
  assert.match(spawned[1].script, /\[JarisInput\]::KeyPress\(13\)$/)
  assert.match(await input.pressKey('win+r'), /^Touche "win\+r" inconnue/)
  assert.equal(spawned.length, 2, 'rien d’envoyé pour un raccourci refusé')
})

test('défiler : vers le bas = crans négatifs, borné de 1 à 20, 3 par défaut', async () => {
  spawned.length = 0
  assert.equal(await input.scrollWheel('down', undefined), 'Défilé de 3 crans vers le bas.')
  assert.match(spawned[0].script, /\[JarisInput\]::Wheel\(-3\)$/)
  assert.equal(await input.scrollWheel('up', 99), 'Défilé de 20 crans vers le haut.')
  assert.match(spawned[1].script, /\[JarisInput\]::Wheel\(20\)$/)
  assert.match(await input.scrollWheel('left', 2), /inconnue/)
  assert.equal(spawned.length, 2)
})

// --- Applications, volume, réglages (pcControl.ts), avec un faux PowerShell.
function loadPc({ windows = [], fail = null, store = false, foregroundOk = true } = {}) {
  const calls = []
  const opened = []
  const pc = loadTsModule('electron/services/pcControl.ts', {
    electron: { shell: { openExternal: async (url) => opened.push(url) } },
    './inputControl': {
      foregroundMatchesApp: input.foregroundMatchesApp,
      waitForForegroundApp: async () => foregroundOk,
      runPowerShellScript: async (script, env) => {
        calls.push({ script, env: env ?? {} })
        if (script.includes('Get-Process | Where-Object')) return { error: null, stdout: JSON.stringify(windows) }
        return { error: typeof fail === 'function' ? fail(script) : fail, stdout: '' }
      }
    }
  })
  return { pc, calls, opened, store }
}

test('fermer : les fenêtres de l’application, par leur numéro (jamais dans le texte du script), jamais Jaris ni l’Explorateur', async () => {
  const windows = [
    { id: 11, name: 'Spotify', title: 'Spotify Premium' },
    { id: 12, name: 'chrome', title: 'YouTube - Google Chrome' },
    // Jaris lui-même : exclu par son numéro de processus, quel que soit le nom du programme (ici « node »).
    { id: process.pid, name: 'node', title: 'Spotify — Jaris' },
    { id: 15, name: 'Jaris', title: 'Spotify — Jaris' },
    { id: 14, name: 'explorer', title: 'Spotify' }
  ]
  const { pc, calls } = loadPc({ windows })
  assert.equal(await pc.appWindow('close', 'spotify'), 'Fermé : Spotify Premium.')
  const close = calls.filter((c) => c.script.includes('CloseMainWindow'))
  assert.deepEqual(close.map((c) => c.env.JARIS_PID), ['11'])
  assert.ok(close.every((c) => !c.script.includes('11')), 'le numéro passe par l’environnement')
  // Remettre devant : la première seulement.
  const focus = loadPc({ windows })
  assert.equal(await focus.pc.appWindow('focus', 'chrome'), 'YouTube - Google Chrome est au premier plan.')
  assert.deepEqual(focus.calls.filter((c) => c.script.includes('AppActivate')).map((c) => c.env.JARIS_PID), ['12'])
  // Pas ouverte : la phrase de Jaris, rien de fermé.
  const none = loadPc({ windows })
  assert.equal(await none.pc.appWindow('close', 'Discord'), 'Aucune fenêtre ouverte ne correspond à « Discord ».')
  assert.equal(none.calls.length, 1)
  // Une seule fenêtre décrite par PowerShell (objet, pas tableau) est bien lue.
  assert.deepEqual(pc.parseWindows('{"id":5,"name":"Steam","title":"Steam"}'), [{ id: 5, name: 'Steam', title: 'Steam' }])
  assert.deepEqual(pc.parseWindows('pas du json'), [])
})

test('volume : un pourcentage borné de 0 à 100, passé par l’environnement', async () => {
  const { pc, calls } = loadPc()
  assert.equal(await pc.setVolume(130), 'Volume réglé à 100 %.')
  assert.equal(calls[0].env.JARIS_VOLUME, '100')
  assert.ok(calls[0].script.includes('[JarisVolume]::Set([float]([int]$env:JARIS_VOLUME / 100))'))
  assert.equal(await pc.setVolume('beaucoup'), 'Pourcentage de volume invalide : un nombre de 0 à 100.')
  assert.equal(calls.length, 1)
  const failing = loadPc({ fail: 'aucun périphérique audio' })
  assert.equal(await failing.pc.setVolume(30), 'Impossible de régler le volume : aucun périphérique audio')
})

test('réglages : mode sombre (Store = la page « Couleurs », le registre y est isolé), luminosité, pages de Paramètres connues seulement', async () => {
  const store = loadPc()
  assert.equal(await store.pc.windowsSetting('dark_mode', 'on', true), "J'ai ouvert les réglages de couleurs de Windows : choisis « Sombre » ou « Clair ».")
  assert.deepEqual(store.opened, ['ms-settings:colors'])
  assert.equal(store.calls.length, 0, 'jamais d’écriture de registre dans la version Store')
  const exe = loadPc()
  assert.equal(await exe.pc.windowsSetting('dark_mode', 'on', false), 'Mode sombre activé.')
  assert.equal(exe.calls[0].env.JARIS_LIGHT, '0')
  assert.equal(await exe.pc.windowsSetting('dark_mode', 'off', false), 'Mode clair activé.')
  assert.equal(exe.calls[1].env.JARIS_LIGHT, '1')
  assert.equal(await exe.pc.windowsSetting('brightness', '40', false), 'Luminosité réglée à 40 %.')
  assert.equal(exe.calls[2].env.JARIS_BRIGHTNESS, '40')
  const desktop = loadPc({ fail: 'code de sortie 4' })
  assert.equal(await desktop.pc.windowsSetting('brightness', 50, false), 'Cet écran ne permet pas de régler la luminosité depuis Windows (seulement les écrans de portable).')
  const pages = loadPc()
  assert.equal(await pages.pc.windowsSetting('open_page', 'WiFi', false), 'Page de Paramètres ouverte : WiFi.')
  assert.deepEqual(pages.opened, ['ms-settings:network-wifi'])
  assert.match(await pages.pc.windowsSetting('open_page', 'ms-settings:privacy-webcam', false), /^Page "ms-settings:privacy-webcam" inconnue/)
  assert.equal(pages.opened.length, 1, 'jamais une adresse donnée par le modèle')
})

// --- Rappels (reminders.ts), sur le vrai disque.
const atomicFile = loadTsModule('electron/services/atomicFile.ts', { fs: nodeRequire('fs'), 'fs/promises': nodeRequire('fs/promises'), path: nodeRequire('path') })
function loadReminders(dataRoot) {
  const source = ts.transpileModule(read('electron/services/reminders.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports = {}
  const modules = { './dataLocation': { getDataRoot: () => dataRoot }, './atomicFile': atomicFile }
  vm.runInThisContext(`(function (exports, require, module) {\n${source}\n})`)(exports, (name) => modules[name] ?? nodeRequire(name), { exports })
  return exports
}

test('rappels : la liste dans l’ordre où ils sonnent ; annuler par numéro ou par mots ; plusieurs = on demande lequel', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jaris-rappels-508-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const reminders = loadReminders(dir)
  const fired = []
  assert.equal(await reminders.listReminders(), 'Aucun rappel programmé.')
  await reminders.scheduleReminder('Sortir le chien', 120, (m) => fired.push(m))
  await reminders.scheduleReminder('Appeler le garage', 45, (m) => fired.push(m))
  await reminders.scheduleReminder('Appeler maman', 60, (m) => fired.push(m))
  const list = await reminders.listReminders()
  assert.match(list, /^1\. Appeler le garage — dans 4[45] min \(.+\)\n2\. Appeler maman — dans (59|60) min \(.+\)\n3\. Sortir le chien — dans 1(19|20) min \(.+\)$/)
  assert.match(await reminders.cancelReminder('appeler'), /^Plusieurs rappels correspondent, lequel annuler \?\n1\. Appeler le garage/)
  assert.equal(await reminders.cancelReminder('garage'), 'Rappel annulé : Appeler le garage.')
  assert.equal(await reminders.cancelReminder('2'), 'Rappel annulé : Sortir le chien.')
  assert.match(await reminders.cancelReminder('dentiste'), /^Aucun rappel ne correspond à « dentiste »\. Rappels programmés :\n1\. Appeler maman/)
  // Un rappel annulé ne sonne plus, et n'est plus dans le fichier.
  t.mock.timers.tick(121 * 60_000)
  assert.deepEqual(fired, ['Appeler maman'])
  // Le rappel qui a sonné est retiré du fichier juste après (écriture réelle, non attendue) : on attend qu'elle soit faite.
  const saved = () => JSON.parse(readFileSync(join(dir, 'reminders.json'), 'utf8'))
  // Horloge réelle pour attendre l'écriture (jusqu'à 2 s : la suite complète charge la machine).
  t.mock.timers.reset()
  for (const end = Date.now() + 2000; saved().length && Date.now() < end; ) await new Promise((done) => setTimeout(done, 20))
  assert.deepEqual(saved(), [])
})

// --- Fichiers (fileTools.ts), sur le vrai disque.
function loadFiles(openPath = async () => '') {
  return loadTsModule('electron/services/fileTools.ts', {
    electron: { app: { getPath: () => { throw new Error('pas ici') } }, shell: { openPath } },
    'fs/promises': nodeRequire('fs/promises'),
    path: nodeRequire('path'),
    './dataLocation': { getDataRoot: () => join(tmpdir(), 'jaris-donnees-absentes') }
  })
}

test('fichiers : seulement dans les dossiers de Léo — un raccourci vers ailleurs, un chemin relatif ou extérieur sont refusés', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'jaris-fichiers-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const docs = join(base, 'Documents')
  const secret = join(base, 'Secret')
  mkdirSync(docs)
  mkdirSync(secret)
  writeFileSync(join(docs, 'Courses.txt'), '﻿pain, beurre, tomates')
  writeFileSync(join(secret, 'mots-de-passe.txt'), 'motdepasse123')
  let linked = true
  try {
    symlinkSync(secret, join(docs, 'raccourci'), 'junction')
  } catch {
    linked = false // Windows sans droit de lien : le reste du test garde son sens.
  }
  const files = loadFiles()
  const roots = [docs]
  assert.equal(await files.readTextFile(join(docs, 'Courses.txt'), roots), 'pain, beurre, tomates', 'le BOM est retiré')
  const outside = 'Je n\'ouvre et ne lis que les fichiers de tes dossiers personnels (Documents, Bureau, Téléchargements, Images, Musique, Vidéos).'
  assert.equal(await files.readTextFile(join(secret, 'mots-de-passe.txt'), roots), outside)
  assert.equal(await files.readTextFile(join(docs, '..', 'Secret', 'mots-de-passe.txt'), roots), outside)
  assert.equal(await files.readTextFile('Courses.txt', roots), outside, 'jamais un chemin relatif')
  if (linked) assert.equal(await files.readTextFile(join(docs, 'raccourci', 'mots-de-passe.txt'), roots), outside, 'le vrai chemin compte, pas le lien')
})

test('fichiers : ouvrir des documents et des dossiers, jamais un programme ; lire du texte seulement, pas trop gros', async (t) => {
  const docs = mkdtempSync(join(tmpdir(), 'jaris-docs-'))
  t.after(() => rmSync(docs, { recursive: true, force: true }))
  writeFileSync(join(docs, 'CV Léo 2026.pdf'), '%PDF')
  writeFileSync(join(docs, 'installe.exe'), 'MZ')
  writeFileSync(join(docs, 'lance.bat'), 'del *')
  writeFileSync(join(docs, 'site.url'), '[InternetShortcut]')
  writeFileSync(join(docs, 'gros.txt'), 'x'.repeat(2_000_001))
  mkdirSync(join(docs, 'Factures 2026'))
  const opened = []
  const files = loadFiles(async (p) => {
    opened.push(p)
    return ''
  })
  const roots = [docs]
  assert.match(await files.openFile(join(docs, 'CV Léo 2026.pdf'), roots), /^Ouvert : .*CV Léo 2026\.pdf$/)
  assert.match(await files.openFile(join(docs, 'Factures 2026'), roots), /^Ouvert : .*Factures 2026$/)
  for (const program of ['installe.exe', 'lance.bat', 'site.url']) {
    assert.match(await files.openFile(join(docs, program), roots), /^Je n'ouvre pas ce type de fichier/, program)
  }
  assert.equal(opened.length, 2, 'jamais un programme ni un raccourci ouvert')
  assert.match(await files.readTextFile(join(docs, 'CV Léo 2026.pdf'), roots), /^Je ne lis que les fichiers texte/)
  assert.equal(await files.readTextFile(join(docs, 'gros.txt'), roots), 'Ce fichier est trop gros pour être lu (plus de 2 Mo).')
  assert.match(await files.openFile(join(docs, 'absent.pdf'), roots), /^Je n'ouvre et ne lis que|^Fichier introuvable/)
})

test('fichiers : chercher par nom (tous les mots, sans accents), dossiers compris, sans fichiers cachés', async (t) => {
  const docs = mkdtempSync(join(tmpdir(), 'jaris-cherche-'))
  t.after(() => rmSync(docs, { recursive: true, force: true }))
  mkdirSync(join(docs, 'Travail', 'Candidatures'), { recursive: true })
  writeFileSync(join(docs, 'Travail', 'Candidatures', 'CV Léo 2026.pdf'), '%PDF')
  writeFileSync(join(docs, '.cv-cache'), 'caché')
  mkdirSync(join(docs, 'node_modules', 'cv'), { recursive: true })
  const files = loadFiles()
  const found = await files.findFiles('cv leo', [docs])
  assert.match(found, /^\[fichier\] .*CV Léo 2026\.pdf \(modifié le \d{2}\/\d{2}\/\d{4}\)$/)
  assert.match(await files.findFiles('candidatures', [docs]), /^\[dossier\] .*Candidatures/)
  assert.match(await files.findFiles('facture', [docs]), /^Aucun fichier ni dossier dont le nom contient « facture »/)
  assert.equal(await files.findFiles('  ', [docs]), 'Dis le nom (ou une partie du nom) du fichier à chercher.')
})

test('les nouveaux outils sont branchés : interdits en duel Discussion (vrai PC) et depuis le téléphone, sauf les rappels', () => {
  const duel = loadTsModule('shared/duel.ts')
  for (const tool of ['app_window', 'manage_reminders', 'files', 'windows_setting', 'shutdown_pc']) assert.ok(duel.DUEL_FORBIDDEN_TOOLS.has(tool), tool)
  const phone = read('electron/services/phoneAccess.ts')
  assert.match(phone, /'manage_reminders'/)
  for (const tool of ['app_window', 'files', 'windows_setting', 'scroll']) assert.ok(!phone.includes(`'${tool}'`), tool)
  const tools = read('electron/services/tools.ts')
  for (const tool of ['app_window', 'manage_reminders', 'files', 'scroll', 'windows_setting']) assert.match(tools, new RegExp(`case '${tool}':`))
})

// --- Sur un vrai Windows (la CI) : les scripts sont du PowerShell valide, le C# compile, la liste des fenêtres se lit.
const { execFileSync } = nodeRequire('node:child_process')
function findPowerShell() {
  for (const candidate of [process.env.PWSH_PATH, 'powershell', 'pwsh'].filter(Boolean)) {
    try {
      execFileSync(candidate, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { stdio: 'pipe' })
      return candidate
    } catch {
      // essai suivant
    }
  }
  return null
}
const powershell = findPowerShell()
const onWindows = powershell && process.platform === 'win32'

test('étape 508 : les nouveaux scripts sont du PowerShell valide (parseur officiel)', { skip: powershell ? false : 'PowerShell absent ici (vérifié par la CI Windows)' }, () => {
  const pc = loadPc().pc
  const dir = mkdtempSync(join(tmpdir(), 'jaris-ps-508-'))
  try {
    const scripts = {
      list: pc.LIST_WINDOWS,
      close: pc.CLOSE_WINDOW,
      focus: pc.FOCUS_WINDOW,
      brightness: pc.SET_BRIGHTNESS,
      dark: pc.SET_DARK_MODE,
      volume: `Add-Type -TypeDefinition @'${pc.VOLUME_CS}'@ -ErrorAction Stop; [JarisVolume]::Set([float]([int]$env:JARIS_VOLUME / 100))`
    }
    for (const [name, script] of Object.entries(scripts)) {
      const file = join(dir, `${name}.ps1`)
      writeFileSync(file, script, 'utf8')
      const report = execFileSync(powershell, ['-NoProfile', '-Command',
        `$e = $null; $t = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file.replace(/'/g, "''")}', [ref]$t, [ref]$e); if ($e.Count) { $e | ForEach-Object { "$($_.Extent.StartLineNumber): $($_.Message)" } } else { 'OK' }`
      ], { encoding: 'utf8' }).trim()
      assert.equal(report, 'OK', `${name} : ${report}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('étape 508 : sur Windows, le C# des raccourcis, de la molette et du volume compile ; la liste des fenêtres se lit', { skip: onWindows ? false : 'Windows seulement (vérifié par la CI)' }, () => {
  const pc = loadPc().pc
  const compile = (cs, check) =>
    execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -TypeDefinition @'${cs}'@ -ErrorAction Stop; ${check}`], { encoding: 'utf8' }).trim()
  // Compiler seulement : jamais d'appui de touche, de défilement ni de changement de volume sur la machine de la CI.
  assert.equal(compile(input.INPUT_HELPER_CS, "if ([JarisInput].GetMethod('KeyCombo') -and [JarisInput].GetMethod('Wheel')) { 'OK' }"), 'OK')
  assert.equal(compile(pc.VOLUME_CS, "if ([JarisVolume].GetMethod('Set')) { 'OK' }"), 'OK')
  const listed = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', pc.LIST_WINDOWS], { encoding: 'utf8' })
  assert.ok(Array.isArray(pc.parseWindows(listed)), listed)
})

test('relecture adverse : « ferme X » vise le programme X — jamais un onglet de navigateur, jamais Teams pour Edge ; ambigu = on demande', async () => {
  const pc = loadPc().pc
  const spotifyApp = { id: 21, name: 'Spotify', title: 'Spotify Premium' }
  const spotifyTab = { id: 22, name: 'chrome', title: 'Spotify – Web Player - Google Chrome' }
  const close = (windows, name) => pc.windowsToClose(windows, name, 1)
  assert.deepEqual(close([spotifyApp, spotifyTab], 'Spotify'), [spotifyApp], 'le programme Spotify, pas Chrome')
  assert.deepEqual(close([spotifyTab], 'Spotify'), [], 'un onglet de Chrome n’est pas Spotify')
  const edge = { id: 31, name: 'msedge', title: 'Accueil - Personnel - Microsoft Edge' }
  const teams = { id: 32, name: 'ms-teams', title: 'Chat | Microsoft Teams' }
  assert.deepEqual(close([edge, teams], 'Microsoft Edge'), [edge])
  const word = { id: 41, name: 'WINWORD', title: 'Rapport.docx - Word' }
  const keepass = { id: 42, name: 'KeePass', title: 'password.kdbx - KeePass' }
  assert.deepEqual(close([word, keepass], 'Word'), [word], '« word » n’est pas « password »')
  // Deux programmes différents dont le titre contient le nom entier : rien n'est fermé.
  const a = { id: 51, name: 'notepad', title: 'Rapport annuel - Bloc-notes' }
  const b = { id: 52, name: 'acrobat', title: 'Rapport annuel.pdf - Adobe Acrobat' }
  const ambiguous = close([a, b], 'Rapport annuel')
  assert.deepEqual(ambiguous, { ambiguous: [a, b] })
  const asked = loadPc({ windows: [a, b] })
  assert.match(await asked.pc.appWindow('close', 'Rapport annuel'), /^Plusieurs applications correspondent, laquelle fermer \?\n1\. Rapport annuel - Bloc-notes/)
  assert.equal(asked.calls.filter((c) => c.script.includes('CloseMainWindow')).length, 0)
})

test('relecture adverse : « exit 3 » dit en clair ; une fenêtre que Windows n’a pas mise devant n’est jamais dite « au premier plan »', async () => {
  const windows = [{ id: 61, name: 'Spotify', title: 'Spotify Premium' }]
  const refused = loadPc({ windows, fail: (script) => (script.includes('CloseMainWindow') ? 'code de sortie 3' : null) })
  assert.equal(await refused.pc.appWindow('close', 'Spotify'), "« Spotify Premium » n'a pas voulu se fermer (une fenêtre de confirmation est peut-être ouverte).")
  const blinking = loadPc({ windows, foregroundOk: false })
  assert.equal(await blinking.pc.appWindow('focus', 'Spotify'), "Windows n'a pas laissé mettre « Spotify Premium » au premier plan : elle clignote dans la barre des tâches.")
})

test('relecture adverse : un chemin réseau (\\\\serveur…) est refusé AVANT tout accès disque — Windows y enverrait l’identifiant de Léo', async () => {
  const touched = []
  const fsp = nodeRequire('fs/promises')
  const files = loadTsModule('electron/services/fileTools.ts', {
    electron: { app: { getPath: () => { throw new Error('pas ici') } }, shell: { openPath: async () => '' } },
    'fs/promises': { ...fsp, realpath: async (p) => { touched.push(p); return fsp.realpath(p) }, stat: async (p) => { touched.push(p); return fsp.stat(p) } },
    path: nodeRequire('path').win32,
    './dataLocation': { getDataRoot: () => 'C:\\Users\\leo\\JarisData' }
  })
  const roots = ['C:\\Users\\leo\\Documents']
  for (const evil of ['\\\\pirate.example\\partage\\a.txt', '\\\\pirate.example@80\\s\\a.txt', '\\\\?\\UNC\\pirate.example\\s\\a.txt', '\\\\.\\pipe\\x', '//pirate.example/s/a.txt', 'C:\\Windows\\win.ini']) {
    assert.equal(await files.insideRoots(evil, roots, []), null, evil)
  }
  assert.deepEqual(touched, [], 'aucun accès au disque ni au réseau pour un chemin refusé')
})

test('relecture adverse : jamais les données de Jaris (même déplacées dans Documents) ni un dossier AppData', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'jaris-donnees-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const docs = join(base, 'Documents')
  const data = join(docs, 'Jaris')
  mkdirSync(data, { recursive: true })
  mkdirSync(join(docs, 'AppData', 'Roaming'), { recursive: true })
  writeFileSync(join(data, 'notes.txt'), 'clé secrète des outils')
  writeFileSync(join(docs, 'AppData', 'Roaming', 'jeton.txt'), 'jeton')
  writeFileSync(join(docs, 'liste.txt'), 'ok')
  const files = loadTsModule('electron/services/fileTools.ts', {
    electron: { app: { getPath: () => { throw new Error('pas ici') } }, shell: { openPath: async () => '' } },
    'fs/promises': nodeRequire('fs/promises'),
    path: nodeRequire('path'),
    './dataLocation': { getDataRoot: () => data }
  })
  assert.equal(await files.readTextFile(join(docs, 'liste.txt'), [docs]), 'ok')
  assert.match(await files.readTextFile(join(data, 'notes.txt'), [docs]), /^Je n'ouvre et ne lis que/)
  assert.match(await files.readTextFile(join(docs, 'AppData', 'Roaming', 'jeton.txt'), [docs]), /^Je n'ouvre et ne lis que/)
  // CI Windows (étape 509) : le dossier temporaire est sous C:\\Users\\…\\AppData\\Local\\Temp. Un AppData AU-DESSUS du dossier
  // de Léo ne doit rien refuser ; seul un AppData DEDANS compte.
  const underAppData = join(base, 'AppData', 'Local', 'Temp', 'Documents')
  mkdirSync(underAppData, { recursive: true })
  writeFileSync(join(underAppData, 'liste.txt'), 'ok aussi')
  assert.equal(await files.readTextFile(join(underAppData, 'liste.txt'), [underAppData]), 'ok aussi')
  // Plus de .json, .ini, .log lisibles : ils gardent souvent des mots de passe et des jetons.
  writeFileSync(join(docs, 'config.json'), '{"token":"x"}')
  assert.match(await files.readTextFile(join(docs, 'config.json'), [docs]), /^Je ne lis que les fichiers texte/)
})
