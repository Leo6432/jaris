import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Étape 527 (Léo : « on va faire un tableau de bord avec tout ») : rapports d'erreurs anonymes vers Sentry — jamais sans
 * l'accord de la personne, et jamais rien qui l'identifie ni le contenu de ce qu'elle fait.
 */
const nodeRequire = createRequire(import.meta.url)
const shared = loadTsModule('shared/errorReports.ts')

test('étape 527 : le texte d’un rapport perd le nom d’utilisateur, le nom du PC, les dossiers personnels et les mails', () => {
  const text = 'ENOENT C:\\Users\\Léo Moulard\\Jaris\\profile.json — /home/leo/x — écrire à leo.m@gmail.com depuis DESKTOP-LEO42'
  const out = shared.scrubText(text, ['DESKTOP-LEO42', 'leo'])
  assert.equal(out, 'ENOENT C:\\Users\\<user>\\Jaris\\profile.json — /home/<user>/x — écrire à <email> depuis <user>')
  // Le mot entier seulement : « galleon » ou « Leo6432 » ne sont pas le prénom.
  assert.equal(shared.scrubText('galleon Leo6432 leo', ['leo']), 'galleon Leo6432 <user>')
})

test('étape 527 : un rapport perd l’utilisateur, le nom de la machine, la requête, les extras et le fil d’actions', () => {
  const event = {
    message: 'Échec dans C:\\Users\\leo\\Jaris',
    user: { id: '1', ip_address: '1.2.3.4' },
    server_name: 'DESKTOP-LEO42',
    request: { url: 'x' },
    extra: { conversation: 'mon secret' },
    breadcrumbs: [{ message: 'ce que Léo a tapé' }],
    exception: { values: [{ value: 'erreur chez DESKTOP-LEO42', stacktrace: { frames: [{ filename: 'C:\\Users\\leo\\app.js' }] } }] },
    contexts: { os: { name: 'Windows' } }
  }
  const out = shared.scrubErrorEvent(event, ['DESKTOP-LEO42'])
  for (const key of ['user', 'server_name', 'request', 'extra', 'breadcrumbs']) assert.equal(key in out, false, key)
  assert.equal(out.message, 'Échec dans C:\\Users\\<user>\\Jaris')
  assert.equal(out.exception.values[0].value, 'erreur chez <user>')
  assert.equal(out.exception.values[0].stacktrace.frames[0].filename, 'C:\\Users\\<user>\\app.js')
  assert.equal(out.contexts.os.name, 'Windows', 'le contexte utile reste')
  assert.equal(event.user.id, '1', 'l’original n’est pas modifié')
})

test('étape 527 : tout ce que Sentry collecte par défaut est coupé — surtout les variables du programme', () => {
  const c = shared.PRIVATE_DATA_COLLECTION
  assert.equal(c.stackFrameVariables, false)
  assert.equal(c.userInfo, false)
  assert.equal(c.httpHeaders, false)
  assert.equal(c.urlQueryParams, false)
  assert.equal(JSON.stringify(c.httpBodies), '[]')
  assert.equal(c.genAI.inputs, false)
  assert.equal(c.genAI.outputs, false)
  assert.match(shared.ERROR_REPORTS_DSN, /^https:\/\/[0-9a-f]+@o\d+\.ingest\.de\.sentry\.io\/\d+$/, 'serveurs en Europe (de)')
})

function loadMain(dir) {
  const calls = { init: [], close: 0 }
  const atomicFile = loadTsModule('electron/services/atomicFile.ts', { fs: nodeRequire('fs'), 'fs/promises': nodeRequire('fs/promises'), path: nodeRequire('path') })
  const mod = loadTsModule('electron/services/errorReports.ts', {
    electron: { app: { getVersion: () => '0.79.0' } },
    '@sentry/electron/main': {
      init: (options) => calls.init.push(options),
      close: async () => {
        calls.close++
        return true
      }
    },
    os: { homedir: () => 'C:\\Users\\Léo', hostname: () => 'DESKTOP-LEO42', userInfo: () => ({ username: 'Léo' }) },
    path: nodeRequire('path'),
    './dataLocation': { getDataRoot: () => dir },
    './atomicFile': atomicFile,
    '../../shared/errorReports': shared
  })
  return { mod, calls }
}

test('étape 527 : sans « oui », Sentry n’est jamais démarré ; « oui » le démarre, « non » le coupe ; le choix est gardé', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jaris-rapports-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { mod, calls } = loadMain(dir)
  assert.equal(JSON.stringify(mod.readErrorReportsState()), JSON.stringify({ asked: false, enabled: false }), 'jamais demandé')
  mod.startErrorReports()
  assert.equal(calls.init.length, 0, 'pas d’accord : rien ne démarre')
  assert.equal(JSON.stringify(await mod.setErrorReports(false)), JSON.stringify({ asked: true, enabled: false }))
  mod.startErrorReports()
  assert.equal(calls.init.length, 0, '« non » : toujours rien')
  assert.equal(JSON.stringify(await mod.setErrorReports(true)), JSON.stringify({ asked: true, enabled: true }))
  assert.equal(calls.init.length, 1, '« oui » : démarré tout de suite')
  const options = calls.init[0]
  assert.equal(options.dsn, shared.ERROR_REPORTS_DSN)
  assert.equal(options.release, 'jaris@0.79.0')
  assert.equal(options.maxBreadcrumbs, 0)
  assert.equal(options.attachScreenshot, false)
  assert.equal(options.dataCollection.stackFrameVariables, false)
  assert.equal(options.includeServerName, false, 'le nom du PC n’est jamais lu')
  // Un plantage natif joint un « minidump » (extrait de la mémoire du programme) : retiré, le rapport part quand même.
  const hint = { attachments: [{ filename: 'minidump.dmp', data: 'mémoire' }] }
  const sent = options.beforeSend({ message: 'C:\\Users\\Léo\\x sur DESKTOP-LEO42', server_name: 'DESKTOP-LEO42' }, hint)
  assert.equal(sent.message, 'C:\\Users\\<user>\\x sur <user>')
  assert.equal('server_name' in sent, false)
  assert.equal(hint.attachments.length, 0, 'aucune pièce jointe ne part')
  assert.equal(JSON.parse(readFileSync(join(dir, mod.ERROR_REPORTS_FILE), 'utf8')).enabled, true, 'gardé sur le disque')
  await mod.setErrorReports(false)
  assert.equal(calls.close, 1, '« non » coupe tout de suite')
  // Un fichier abîmé n'est jamais pris pour un « oui ».
  const { writeFileSync } = nodeRequire('fs')
  writeFileSync(join(dir, mod.ERROR_REPORTS_FILE), '{pas du json')
  assert.equal(mod.readErrorReportsState().enabled, false)
})

test('étape 527 : démarré avant les fenêtres, dans la seule instance de Jaris ; l’écran aussi, seulement avec l’accord ; fichier suivi par « Déplacer »', () => {
  const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8')
  assert.match(main, /const gotSingleInstanceLock = app\.requestSingleInstanceLock\(\)\r?\n[^\n]*\r?\nif \(gotSingleInstanceLock\) startErrorReports\(\)/)
  assert.match(main, /ipcMain\.handle\(IPC_CHANNELS\.setErrorReports, \(_event, enabled: unknown\) => setErrorReports\(enabled === true\)\)/)
  const renderer = readFileSync(new URL('../src/lib/errorReports.ts', import.meta.url), 'utf8')
  assert.match(renderer, /if \(!state\.enabled\) return/)
  assert.match(renderer, /dataCollection: PRIVATE_DATA_COLLECTION/)
  assert.match(renderer, /hint\.attachments = \[\]/)
  const storage = readFileSync(new URL('../electron/services/storageRoot.ts', import.meta.url), 'utf8')
  assert.ok(storage.includes("'rapports-erreurs.json'"))
})
