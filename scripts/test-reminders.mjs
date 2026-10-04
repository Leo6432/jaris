import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * Étape 234 (bêta de Jaris) : un rappel programmé ne doit sonner qu'UNE fois, même si les rappels en attente
 * sont réarmés (avant : chaque redémarrage du moteur vocal — changement de micro, mot d'activation — les
 * réarmait sans annuler les anciens minuteurs, et chaque rappel sonnait en double). Et il doit toujours
 * s'afficher, pas seulement être dit à voix haute.
 */
const nodeRequire = createRequire(import.meta.url)
// CRLF normalisé : la CI extrait le dépôt sous Windows, où les motifs sur plusieurs lignes ne trouvaient plus rien.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

function loadReminders(dataRoot) {
  const source = ts.transpileModule(read('electron/services/reminders.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports = {}
  vm.runInThisContext(`(function (exports, require, module) {\n${source}\n})`)(exports, (name) => (name === './dataLocation' ? { getDataRoot: () => dataRoot } : nodeRequire(name)), { exports })
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
