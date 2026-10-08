import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

// Étape 256 : Jaris s'écarte pendant qu'il pilote l'écran (pilotWindows.ts, gestes fournis par main.ts).
function load() {
  const code = ts.transpileModule(readFileSync(new URL('../electron/services/pilotWindows.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  vm.runInThisContext(`(function (exports, require, module) {\n${code}\n})`)(module.exports, () => ({}), module)
  return module.exports
}

test('étape 263 : Jaris ne s’écarte QUE si la tâche reprend l’écran, et revient alors même quand elle échoue', async () => {
  const { setPilotWindowHooks, withPilotWindows } = load()
  const events = []
  setPilotWindowHooks({ begin: async () => { events.push('begin') }, end: () => { events.push('end') }, guard: (on) => events.push(`guard ${on}`) })
  // En arrière-plan : aucune fenêtre de Jaris ne bouge ; le widget n'est protégé que le temps d'un geste emprunté.
  assert.equal(await withPilotWindows(async (w) => { w.guard(true); w.guard(false); events.push('task'); return 'ok' }), 'ok')
  assert.deepEqual(events.splice(0), ['guard true', 'guard false', 'task'])
  // Reprise de l'écran : écarté une seule fois, ramené à la fin, même en cas d'échec.
  await assert.rejects(withPilotWindows(async (w) => { await w.setAside(); await w.setAside(); events.push('task'); throw new Error('Page de connexion') }), /Page de connexion/)
  assert.deepEqual(events, ['begin', 'task', 'end'])
})

test('un geste qui échoue n’empêche jamais la tâche ; sans gestes enregistrés (tests), rien ne se passe', async () => {
  const { setPilotWindowHooks, withPilotWindows } = load()
  assert.equal(await withPilotWindows(async (w) => { await w.setAside(); w.guard(true); return 'sans gestes' }), 'sans gestes')
  setPilotWindowHooks({ begin: async () => { throw new Error('fenêtre détruite') }, end: () => { throw new Error('idem') }, guard: () => { throw new Error('idem') } })
  assert.equal(await withPilotWindows(async (w) => { await w.setAside(); w.guard(true); return 'quand même' }), 'quand même')
})

test('main.ts : gestes enregistrés au démarrage ; la grande fenêtre se replie, le widget sort de la vue et des clics du pilote', () => {
  const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8')
  assert.match(main, /setPilotWindowHooks\(\{ begin: setJarisAsideForPilot, end: bringJarisBackAfterPilot, guard: setPilotBorrowGuard \}\)/)
  const aside = main.slice(main.indexOf('async function setJarisAsideForPilot'), main.indexOf('function bringJarisBackAfterPilot'))
  // Repli comme une perte de focus (widget), réduite sinon ; attente avant la première capture.
  assert.match(aside, /fullWindow\.hide\(\)\s+showWidgetWindow\(\)/)
  assert.match(aside, /fullWindow\.minimize\(\)/)
  assert.match(aside, /setTimeout\(resolve, \d+\)/)
  const guard = main.slice(main.indexOf('function applyPilotWidgetGuard'), main.indexOf('async function setJarisAsideForPilot'))
  // Étape 263 : aussi le temps d'un geste emprunté en arrière-plan.
  assert.match(guard, /const guarded = pilotTasks > 0 \|\| pilotBorrowing/)
  assert.match(guard, /setContentProtection\(guarded\)/)
  assert.match(guard, /setIgnoreMouseEvents\(guarded\)/)
  assert.match(guard, /function setPilotBorrowGuard\(on: boolean\): void \{\s+pilotBorrowing = on\s+applyPilotWidgetGuard\(\)/)
  // À la fin, le widget redevient cliquable et visible aux captures (compteur, pour deux tâches qui se chevauchent).
  const back = main.slice(main.indexOf('function bringJarisBackAfterPilot'), main.indexOf('function bringJarisBackAfterPilot') + 200)
  assert.match(back, /pilotTasks = Math\.max\(0, pilotTasks - 1\)\s+applyPilotWidgetGuard\(\)/)
  // Un widget créé ou réaffiché PENDANT la tâche reçoit la même protection.
  const show = main.slice(main.indexOf('function showWidgetWindow'), main.indexOf('function triggerVisibleWake'))
  assert.match(show, /if \(pilotTasks > 0 \|\| pilotBorrowing\) applyPilotWidgetGuard\(\)/)
})

test('computerUse.ts : toute la tâche passe par withPilotWindows', () => {
  const source = readFileSync(new URL('../electron/services/computerUse.ts', import.meta.url), 'utf8')
  assert.match(source, /return withPilotWindows\(\(windows\) => runComputerUseTask\(goal, visionModel, windows, onProgress, signal\)\)/)
})
