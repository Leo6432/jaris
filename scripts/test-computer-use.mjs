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

function setup(steps, inputResult, onFetch, elements = []) {
  let captures = 0
  let actions = 0
  let hidden = 0
  const logs = []
  const clicks = []
  const input = async (...args) => { actions++; clicks.push(args); return inputResult }
  const modules = {
    '../config': { config: { ollama: { host: 'http://test', numCtx: 8192 } } },
    './hardwareScan': { getLiveGpuStatus: async () => ({ freeVramGb: null }) },
    './ollama': { listInstalledModels: async () => [] },
    './scanOverlay': { showScanOverlay() {}, hideScanOverlay() { hidden++ } },
    './inputControl': { clickMouse: input, typeText: input, pressKey: input },
    './uiAutomation': {
      listClickableElements: async () => elements,
      findElementByName: uia.exports.findElementByName,
      describeElements: uia.exports.describeElements
    },
    './vision': { captureScreenshotBase64: async () => { captures++; return { imageBase64: 'test', scale: 1 } } }
  }
  const prompts = []
  const exports = {}
  vm.runInNewContext(source, {
    exports, Error, AbortSignal, require: name => modules[name], setTimeout: fn => fn(),
    fetch: async (_url, options) => {
      onFetch?.()
      prompts.push(JSON.parse(options.body).messages[1].content)
      return { ok: true, json: async () => ({ message: { content: JSON.stringify(steps.shift() ?? { action: 'wait' }) } }) }
    }
  })
  return { run: signal => exports.computerUseTask('Cherche un tuto guitare', 'test', line => logs.push(line), signal),
    state: () => ({ captures, actions, hidden, logs, clicks, prompts }) }
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
