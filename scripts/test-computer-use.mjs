import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const source = ts.transpileModule(readFileSync(new URL('../electron/services/computerUse.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

// Étape 32 : les fonctions pures d'uiAutomation (recherche par nom, mise en forme) sont utilisées TELLES
// QUELLES par la boucle testée ici — seule la lecture de l'écran (PowerShell, impossible hors Windows) est
// simulée. Tester le vrai appariement de noms à travers la vraie boucle, plutôt qu'un mock qui renverrait
// toujours l'élément attendu.
const uiaSource = ts.transpileModule(readFileSync(new URL('../electron/services/uiAutomation.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const loadUia = vm.runInThisContext(`(function (exports, require, module) {\n${uiaSource}\n})`)
const uia = { exports: {} }
loadUia(uia.exports, () => ({ spawn: () => {} }), uia)

const uiTarsSource = ts.transpileModule(readFileSync(new URL('../electron/services/uiTars.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const loadUiTars = vm.runInThisContext(`(function (exports, require, module) {\n${uiTarsSource}\n})`)
const uiTars = { exports: {} }
loadUiTars(uiTars.exports, () => ({}), uiTars)

// Étape 231 : `pilot` = profil + modèles installés simulés. Par défaut, aucun modèle de pilotage : le modèle de
// vision pilote, exactement comme avant — tous les tests historiques ci-dessous passent par ce chemin.
function setup(steps, inputResult, onFetch, elements = [], pilot = { profile: null, installed: [] }) {
  let captures = 0
  let actions = 0
  let hidden = 0
  const logs = []
  const clicks = []
  const input = async (...args) => { actions++; clicks.push(args); return typeof inputResult === 'function' ? inputResult(...args) : inputResult }
  let uiaReads = 0
  const bodies = []
  const modules = {
    '../config': { config: { ollama: { host: 'http://test', numCtx: 8192 } } },
    './hardwareScan': { getLiveGpuStatus: async () => ({ freeVramGb: null }) },
    './ollama': { listInstalledModels: async () => pilot.installed },
    './profileStore': { getProfile: async () => pilot.profile },
    './uiTars': uiTars.exports,
    './scanOverlay': { showScanOverlay() {}, hideScanOverlay() { hidden++ } },
    './inputControl': {
      clickMouse: (...a) => input('click', ...a), typeText: (...a) => input('type', ...a), pressKey: (...a) => input('key', ...a),
      pressHotkey: (...a) => input('hotkey', ...a), scrollMouse: (...a) => input('scroll', ...a)
    },
    './uiAutomation': {
      listClickableElements: async () => { uiaReads++; return elements },
      findElementByName: uia.exports.findElementByName,
      describeElements: uia.exports.describeElements
    },
    './vision': { captureScreenshotBase64: async () => { captures++; return { imageBase64: 'test', scale: pilot.scale ?? 1, width: 1280, height: 720 } } }
  }
  const prompts = []
  const exports = {}
  vm.runInNewContext(source, {
    exports, Error, AbortSignal, require: name => modules[name], setTimeout: fn => fn(),
    fetch: async (_url, options) => {
      onFetch?.()
      const body = JSON.parse(options.body)
      bodies.push(body)
      prompts.push(body.messages[body.messages.length - 1].content)
      const next = steps.shift() ?? { action: 'wait' }
      return { ok: true, json: async () => ({ message: { content: typeof next === 'string' ? next : JSON.stringify(next) } }) }
    }
  })
  return { run: signal => exports.computerUseTask('Cherche un tuto guitare', 'test', line => logs.push(line), signal),
    state: () => ({ captures, actions, hidden, logs, clicks: clicks.map((c) => c[0] === 'click' ? c.slice(1) : c), calls: clicks, prompts, bodies, uiaReads }) }
}

for (const step of [{ action: 'move' }, { action: 'click' }, { action: 'click', x: '12', y: 2 }, { action: 'type', text: '' }, { action: 'key', key: 42 }]) {
  test(`action invalide arrêtée sans scan supplémentaire : ${JSON.stringify(step)}`, async () => {
    const app = setup([step])
    await assert.rejects(app.run(), /action inexécutable/)
    assert.equal(app.state().captures, 1)
    assert.equal(app.state().actions, 0)
    assert.equal(app.state().hidden, 1)
  })
}
for (const [step, result] of [
  [{ action: 'click', x: 2, y: 4 }, 'Échec du clic : accès refusé'],
  [{ action: 'type', text: 'guitare' }, 'Échec de la saisie du texte : test'],
  [{ action: 'key', key: 'ctrl+l' }, 'Touche "ctrl+l" inconnue.']
]) {
  test(`erreur réelle transmise : ${step.action}`, async () => {
    const app = setup([step], result)
    await assert.rejects(app.run(), error => error.message === result)
    assert.equal(app.state().captures, 1)
    assert.ok(!app.state().logs.some(line => /texte tapé|pressée|clic left/.test(line)))
  })
}
test('trois attentes consécutives arrêtent la boucle', async () => {
  const app = setup([])
  await assert.rejects(app.run(), /trois captures/)
  assert.equal(app.state().captures, 3)
})
test('un clic réussi est suivi de la vérification de fin', async () => {
  const app = setup([{ action: 'click', x: 2, y: 4 }, { action: 'done', result: 'Recherche affichée' }], 'Clic left effectué à (2, 4).')
  assert.equal(await app.run(), 'Recherche affichée')
  assert.equal(app.state().actions, 1)
})
test('une annulation pendant la vision empêche le clic tardif', async () => {
  const controller = new AbortController()
  const app = setup([{ action: 'click', x: 2, y: 4 }], '', () => controller.abort())
  assert.match(await app.run(controller.signal), /interrompue/)
  assert.equal(app.state().actions, 0)
})

// --- Étape 32 : clics par élément d'accessibilité plutôt qu'en pixels devinés ---

const ELEMENTS = [
  { name: 'Rechercher', type: 'Edit', x: 300, y: 120 },
  { name: 'Se connecter', type: 'Button', x: 640, y: 40 }
]

test('click_element clique à la position donnée par Windows, pas à des pixels devinés', async () => {
  const app = setup(
    [{ action: 'click_element', name: 'rechercher' }, { action: 'done', result: 'Champ ouvert' }],
    'Clic left effectué à (300, 120).',
    undefined,
    ELEMENTS
  )
  assert.equal(await app.run(), 'Champ ouvert')
  assert.deepEqual(app.state().clicks[0], [300, 120, 'left'])
})

test('un élément introuvable ne fait PAS échouer la tâche : le clic en pixels reste possible', async () => {
  const app = setup(
    [{ action: 'click_element', name: 'Envoyer' }, { action: 'click', x: 12, y: 34 }, { action: 'done', result: 'Fait' }],
    'Clic left effectué à (12, 34).',
    undefined,
    ELEMENTS
  )
  assert.equal(await app.run(), 'Fait')
  // Aucun clic pour l'élément manquant, puis le clic en pixels du tour suivant.
  assert.equal(app.state().clicks.length, 1)
  assert.deepEqual(app.state().clicks[0], [12, 34, 'left'])
  assert.ok(app.state().logs.some(line => /introuvable/.test(line)))
  // L'échec est visible dans l'historique envoyé au modèle, sinon il retenterait le même nom.
  assert.match(app.state().prompts[1], /Élément "Envoyer" introuvable/)
})

test('click_element sans nom est refusé comme action inexécutable', async () => {
  const app = setup([{ action: 'click_element' }], '', undefined, ELEMENTS)
  await assert.rejects(app.run(), /action inexécutable/)
  assert.equal(app.state().actions, 0)
})

test('la liste des éléments est bien transmise au modèle', async () => {
  const app = setup([{ action: 'done', result: 'ok' }], '', undefined, ELEMENTS)
  await app.run()
  assert.match(app.state().prompts[0], /- \[Edit\] Rechercher/)
  assert.match(app.state().prompts[0], /- \[Button\] Se connecter/)
})

test("sans arbre d'accessibilité, le modèle est explicitement renvoyé vers le clic en pixels", async () => {
  const app = setup([{ action: 'done', result: 'ok' }], '', undefined, [])
  await app.run()
  assert.match(app.state().prompts[0], /aucun élément cliquable.*clics en pixels/s)
})

// --- Étape 231 : modèle de pilotage d'écran (UI-TARS) quand il est installé ---

const PILOT = 'hf.co/mradermacher/UI-TARS-1.5-7B-GGUF:Q4_K_M'
const withPilot = { profile: { pilotModel: PILOT }, installed: [PILOT, 'qwen3.5:4b'] }
const ok = (_kind, ...args) => {
  if (_kind === 'click') return `Clic ${args[2]} effectué à (${args[0]}, ${args[1]}).`
  if (_kind === 'type') return 'Texte tapé.'
  if (_kind === 'key') return `Touche "${args[0]}" pressée.`
  if (_kind === 'hotkey') return `Combinaison "${args[0].join('+')}" pressée.`
  if (_kind === 'scroll') return `Défilement ${args[2]} effectué.`
}

test('pilotage installé : consigne UI-TARS sans message système, clic ramené aux pixels puis à l’écran', async () => {
  // Vraie réponse obtenue ici d'UI-TARS sur la fausse fenêtre 1280x720 (bouton VALIDER en 700-870 x 420-476).
  const real = "Thought: Le bouton vert VALIDER confirme l'enregistrement.\nAction: click(start_box='(796,453)')"
  const app = setup([real, "Thought: c'est fait.\nAction: finished(content='Enregistré')"], ok, undefined, [], { ...withPilot, scale: 1.5 })
  assert.equal(await app.run(), 'Enregistré')
  const body = app.state().bodies[0]
  assert.equal(body.model, PILOT)
  assert.equal(body.messages.length, 1)
  assert.equal(body.messages[0].role, 'user')
  assert.match(body.messages[0].content, /You are a GUI agent[\s\S]*Cherche un tuto guitare/)
  assert.equal(body.options.temperature, 0)
  // 796 x 1280/1288 = 791, 453 x 720/728 = 448 ; puis x1,5 pour l'écran réel.
  assert.deepEqual(app.state().clicks[0], [1187, 672, 'left'])
  // Le modèle de pilotage vise sur l'image : pas de lecture de l'arbre Windows (5 s de PowerShell par étape).
  assert.equal(app.state().uiaReads, 0)
  // Son action, telle qu'il l'a écrite, lui revient dans l'historique au tour suivant.
  assert.match(app.state().prompts[1], /1\. click\(start_box='\(796,453\)'\)/)
})

test('pilotage : texte terminé par \\n tapé PUIS validé par Entrée, combinaison et défilement exécutés', async () => {
  const app = setup([
    "Thought: je tape.\nAction: type(content='tuto guitare\\n')",
    "Thought: barre d'adresse.\nAction: hotkey(key='ctrl l')",
    "Thought: plus bas.\nAction: scroll(start_box='(640,360)', direction='down')",
    "Thought: fini.\nAction: finished(content='ok')"
  ], ok, undefined, [], withPilot)
  assert.equal(await app.run(), 'ok')
  const calls = app.state().calls
  assert.deepEqual(calls[0], ['type', 'tuto guitare'])
  assert.deepEqual(calls[1], ['key', 'enter'])
  assert.deepEqual(calls[2], ['hotkey', ['ctrl', 'l']])
  assert.equal(calls[3][0], 'scroll')
  assert.equal(calls[3][3], 'down')
})

test('pilotage : une combinaison refusée par Windows fait échouer la tâche avec la vraie raison', async () => {
  const app = setup(["Thought: x\nAction: hotkey(key='ctrl l')"], 'Échec de la combinaison de touches : accès refusé', undefined, [], withPilot)
  await assert.rejects(app.run(), /accès refusé/)
})

test('pilotage : réponse sans action exploitable = échec clair, aucun clic', async () => {
  const app = setup(['Thought: je ne sais pas.'], ok, undefined, [], withPilot)
  await assert.rejects(app.run(), /modèle de pilotage a proposé une action inexécutable/)
  assert.equal(app.state().actions, 0)
})

test('profil qui cite le modèle de pilotage mais qu’Ollama ne l’a plus : le modèle de vision pilote, comme avant', async () => {
  const app = setup([{ action: 'click', x: 2, y: 4 }, { action: 'done', result: 'ok' }], ok, undefined, [], { profile: { pilotModel: PILOT }, installed: ['qwen3.5:4b'] })
  assert.equal(await app.run(), 'ok')
  assert.equal(app.state().bodies[0].model, 'test')
  assert.equal(app.state().bodies[0].messages[0].role, 'system')
  assert.deepEqual(app.state().clicks[0], [2, 4, 'left'])
  assert.ok(app.state().uiaReads > 0)
})
