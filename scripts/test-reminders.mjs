import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Étape 234 (bêta de Jaris) : un rappel programmé ne doit sonner qu'UNE fois, même si les rappels en attente
 * sont réarmés (avant : chaque redémarrage du moteur vocal — changement de micro, mot d'activation — les
 * réarmait sans annuler les anciens minuteurs, et chaque rappel sonnait en double). Et il doit toujours
 * s'afficher, pas seulement être dit à voix haute.
 */
const nodeRequire = createRequire(import.meta.url)
// CRLF normalisé : la CI extrait le dépôt sous Windows, où les motifs sur plusieurs lignes ne trouvaient plus rien.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

// Écritures d'un seul tenant et lecture prudente des rappels (étape 325) : le vrai module, sur le vrai disque.
const atomicFile = loadTsModule('electron/services/atomicFile.ts', { fs: nodeRequire('fs'), 'fs/promises': nodeRequire('fs/promises'), path: nodeRequire('path') })

function loadReminders(dataRoot) {
  const source = ts.transpileModule(read('electron/services/reminders.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports = {}
  const modules = { './dataLocation': { getDataRoot: () => dataRoot }, './atomicFile': atomicFile }
  vm.runInThisContext(`(function (exports, require, module) {\n${source}\n})`)(exports, (name) => modules[name] ?? nodeRequire(name), { exports })
  return exports
}

test('un rappel réarmé plusieurs fois ne sonne qu’une fois', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jaris-rappels-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // Horloge simulée : avec une vraie, le rappel (120 ms) sonnait parfois AVANT d'être réarmé sur une machine
  // chargée, et le test échouait sans que le code soit en cause.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const reminders = loadReminders(dir)
  const fired = []
  await reminders.scheduleReminder('boire de l’eau', 0.002, (m) => fired.push(`direct ${m}`))
  // Comme un changement de micro, deux fois de suite, avant que le rappel ne sonne.
  await reminders.restoreReminders((m) => fired.push(`réarmé ${m}`))
  await reminders.restoreReminders((m) => fired.push(`réarmé ${m}`))
  assert.deepEqual(fired, [], 'rien avant l’heure')
  t.mock.timers.tick(200)
  assert.deepEqual(fired, ['réarmé boire de l’eau'])
})

test('tous les rappels passent par fireReminder (notification Windows + voix), réarmés une seule fois au lancement', () => {
  const main = read('electron/main.ts')
  const pipeline = read('electron/services/voicePipeline.ts')
  assert.match(main, /function fireReminder\(message: string\): void \{\n\s*if \(Notification\.isSupported\(\)\) new Notification\(/)
  assert.ok(!/restoreReminders/.test(pipeline), 'le moteur vocal ne réarme plus les rappels à chaque démarrage')
  assert.equal((main.match(/restoreReminders\(fireReminder\)/g) ?? []).length, 1)
  const start = main.indexOf('async function startVoicePipeline')
  const body = main.slice(start, main.indexOf('\n}\n', start))
  assert.ok(!body.includes('restoreReminders'), 'pas dans startVoicePipeline, qui est rappelée à chaque changement de micro')
  assert.ok(!/announceReminder\((message|reminder)\)/.test(main.replace('void pipeline?.announceReminder(message)', '')), 'aucun rappel ne contourne fireReminder')
  assert.match(pipeline, /this\.emit\('reminder', message\)/)
  assert.match(main, /pipeline\.on\('reminder', fireReminder\)/)
})

test('un rappel dans un mois attend vraiment un mois (étape 324 : setTimeout ramenait plus de 24,8 jours à 1 ms)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jaris-rappels-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const reminders = loadReminders(dir)
  const fired = []
  const DAY = 24 * 3600 * 1000
  await reminders.scheduleReminder('payer le loyer', 30 * 24 * 60, (m) => fired.push(m))
  t.mock.timers.tick(1000)
  assert.deepEqual(fired, [], 'rien tout de suite')
  t.mock.timers.tick(25 * DAY)
  assert.deepEqual(fired, [], 'rien après la première tranche de 24,8 jours')
  // Un redémarrage au milieu réarme le rappel lu sur le disque : toujours rien avant l'heure.
  await reminders.restoreReminders((m) => fired.push(`réarmé ${m}`))
  t.mock.timers.tick(4 * DAY)
  assert.deepEqual(fired, [], 'toujours rien à 29 jours')
  t.mock.timers.tick(DAY)
  assert.deepEqual(fired, ['réarmé payer le loyer'], 'sonne une seule fois, à 30 jours')
  // L'effacement du fichier est asynchrone (vraie écriture disque, hors horloge simulée) : on lui laisse jusqu'à 5 s
  // de VRAI temps (performance.now n'est pas simulé). Un nombre de tours fixe échouait sur une machine chargée.
  let stored = null
  const deadline = performance.now() + 5000
  while (performance.now() < deadline) {
    try {
      stored = JSON.parse(readFileSync(join(dir, 'reminders.json'), 'utf8'))
      if (!stored.length) break
    } catch {
      // fichier en cours de réécriture : on relit au tour suivant
    }
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.deepEqual(stored, [], 'puis disparaît du fichier')
})
