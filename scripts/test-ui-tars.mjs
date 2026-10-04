import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

// Étape 231 : adaptateur UI-TARS (uiTars.ts), choix du rôle (shared/pilotModel.ts) et liste fermée des
// combinaisons de touches (inputControl.ts). Chargés dans le realm courant pour comparer des objets entiers.
function load(path, requireFn = () => ({})) {
  const source = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  vm.runInThisContext(`(function (exports, require, module) {\n${source}\n})`)(module.exports, requireFn, module)
  return module.exports
}
const { parseUiTarsResponse, smartResize, buildUiTarsPrompt } = load('../electron/services/uiTars.ts')
const { pickPilotModel, PILOT_MODEL } = load('../shared/pilotModel.ts')
const { hotkeyVirtualKeys } = load('../electron/services/inputControl.ts', () => ({ spawn: () => { throw new Error('jamais lancé ici') } }))

const inside = (step, [l, t, w, h]) => step.x >= l && step.x < l + w && step.y >= t && step.y < t + h

test('vraies réponses d’UI-TARS obtenues ici : chaque clic atterrit sur le bon bouton', () => {
  // Fausse fenêtre 1280x720 (scene.mjs) : VALIDER en 700-870 x 420-476, ANNULER en 480-650 x 420-476.
  const valider = parseUiTarsResponse("Thought: Le bouton vert « VALIDER » confirme.\nAction: click(start_box='(796,453)')", 1280, 720)
  assert.equal(valider.action, 'click')
  assert.ok(inside(valider, [700, 420, 170, 56]))
  assert.ok(inside(parseUiTarsResponse("Thought: annuler.\nAction: click(start_box='(568,455)')", 1280, 720), [480, 420, 170, 56]))
  // Image 1280x1024 : OK en 1020-1180 x 880-936 — le repère de 1288x1036 (pas une réduction à 1 Mpx).
  assert.ok(inside(parseUiTarsResponse("Thought: OK.\nAction: click(start_box='(1117,920)')", 1280, 1024), [1020, 880, 160, 56]))
})

test('repère du modèle : multiples de 28, ramené aux pixels de l’image envoyée', () => {
  assert.deepEqual(smartResize(1280, 720), { width: 1288, height: 728 })
  assert.deepEqual(smartResize(1280, 1024), { width: 1288, height: 1036 })
  const step = parseUiTarsResponse("Action: click(start_box='(1288,728)')", 1280, 720)
  assert.deepEqual([step.x, step.y], [1280, 720])
})

test('formats de zone acceptés : balises, sans balises, rectangle (centre)', () => {
  const tagged = parseUiTarsResponse("Action: click(start_box='<|box_start|>(100,200)<|box_end|>')", 1288, 728)
  assert.deepEqual([tagged.x, tagged.y], [100, 200])
  const box = parseUiTarsResponse("Action: click(start_box='(100,200,300,400)')", 1288, 728)
  assert.deepEqual([box.x, box.y], [200, 300])
})

test('double clic, clic droit, attente, fin', () => {
  assert.equal(parseUiTarsResponse("Action: left_double(start_box='(10,10)')", 1288, 728).action, 'double_click')
  assert.equal(parseUiTarsResponse("Action: right_single(start_box='(10,10)')", 1288, 728).action, 'right_click')
  assert.equal(parseUiTarsResponse('Action: wait()', 1288, 728).action, 'wait')
  const done = parseUiTarsResponse("Action: finished(content='C\\'est fait')", 1288, 728)
  assert.equal(done.action, 'done')
  assert.equal(done.result, "C'est fait")
})

test('saisie : échappements défaits, \\n final = valider ; \\n seul = touche Entrée', () => {
  const typed = parseUiTarsResponse("Action: type(content='l\\'heure à Paris\\n')", 1288, 728)
  assert.equal(typed.action, 'type')
  assert.equal(typed.text, "l'heure à Paris")
  assert.equal(typed.submit, true)
  assert.equal(parseUiTarsResponse("Action: type(content='bonjour')", 1288, 728).submit, false)
  const enter = parseUiTarsResponse("Action: type(content='\\n')", 1288, 728)
  assert.deepEqual([enter.action, enter.key], ['key', 'enter'])
})

test('touches : seule connue -> pressKey, combinaison -> hotkey', () => {
  const enter = parseUiTarsResponse("Action: hotkey(key='enter')", 1288, 728)
  assert.deepEqual([enter.action, enter.key], ['key', 'enter'])
  assert.equal(parseUiTarsResponse("Action: hotkey(key='down')", 1288, 728).key, 'bas')
  const combo = parseUiTarsResponse("Action: hotkey(key='ctrl l')", 1288, 728)
  assert.deepEqual([combo.action, [...combo.keys]], ['hotkey', ['ctrl', 'l']])
  assert.deepEqual([...parseUiTarsResponse("Action: hotkey(key='ctrl+shift+t')", 1288, 728).keys], ['ctrl', 'shift', 't'])
})

test('défilement : avec ou sans position, sens obligatoire', () => {
  const at = parseUiTarsResponse("Action: scroll(start_box='(640,360)', direction='down')", 1288, 728)
  assert.deepEqual([at.action, at.direction, at.x, at.y], ['scroll', 'down', 640, 360])
  const here = parseUiTarsResponse("Action: scroll(direction='up')", 1288, 728)
  assert.deepEqual([here.action, here.direction, here.x], ['scroll', 'up', undefined])
  assert.equal(parseUiTarsResponse("Action: scroll(start_box='(1,1)', direction='diagonal')", 1288, 728), null)
})

test('réponses inexploitables : rien n’est cliqué', () => {
  for (const bad of [
    'Thought: je réfléchis encore.',
    'Action: drag(start_box=\'(1,1)\', end_box=\'(5,5)\')',
    "Action: click(start_box='')",
    "Action: click(start_box='(5000,10)')",
    "Action: type(content='')",
    'Action: click'
  ]) assert.equal(parseUiTarsResponse(bad, 1288, 728), null, bad)
  assert.equal(parseUiTarsResponse('Action: call_user()', 1288, 728).action, 'fail')
})

test('la consigne contient l’objectif, l’historique et demande le raisonnement en français', () => {
  const prompt = buildUiTarsPrompt('Ouvre YouTube', ["1. click(start_box='(1,2)')"])
  assert.match(prompt, /## User Instruction\nOuvre YouTube/)
  assert.match(prompt, /Actions déjà faites\n1\. click/)
  assert.match(prompt, /Use French in `Thought`/)
  // Seules les actions que Jaris sait exécuter sont proposées.
  assert.doesNotMatch(prompt, /drag\(|select\(/)
})

test('rôle seulement avec une carte de 8 Go ou plus, sinon aucun modèle et une raison lisible', () => {
  assert.equal(pickPilotModel(8).model, PILOT_MODEL)
  assert.equal(pickPilotModel(7.6).model, PILOT_MODEL)
  assert.equal(pickPilotModel(24).model, PILOT_MODEL)
  const small = pickPilotModel(6)
  assert.equal(small.model, null)
  assert.match(small.reason, /trop petite \(6 Go/)
  assert.match(pickPilotModel(null).reason, /aucune carte graphique/)
})

test('combinaisons : liste fermée de touches, rien d’autre', () => {
  assert.deepEqual([...hotkeyVirtualKeys(['ctrl', 'l'])], [0x11, 0x4c])
  assert.deepEqual([...hotkeyVirtualKeys(['alt', 'f4'])], [0x12, 0x73])
  assert.deepEqual([...hotkeyVirtualKeys(['Win', '1'])], [0x5b, 0x31])
  assert.equal(hotkeyVirtualKeys(['ctrl', '0x41']), null)
  assert.equal(hotkeyVirtualKeys(['ctrl', 'é']), null)
  assert.equal(hotkeyVirtualKeys([]), null)
})
