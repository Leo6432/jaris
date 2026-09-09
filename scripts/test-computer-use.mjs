import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const source = ts.transpileModule(readFileSync(new URL('../electron/services/computerUse.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

function setup(steps, inputResult, onFetch) {
  let captures = 0
  let actions = 0
  let hidden = 0
  const logs = []
  const input = async () => { actions++; return inputResult }
  const modules = {
    '../config': { config: { ollama: { host: 'http://test', numCtx: 8192 } } },
    './hardwareScan': { getLiveGpuStatus: async () => ({ freeVramGb: null }) },
    './ollama': { listInstalledModels: async () => [] },
    './scanOverlay': { showScanOverlay() {}, hideScanOverlay() { hidden++ } },
    './inputControl': { clickMouse: input, typeText: input, pressKey: input },
    './vision': { captureScreenshotBase64: async () => { captures++; return { imageBase64: 'test', scale: 1 } } }
  }
  const exports = {}
  vm.runInNewContext(source, {
    exports, Error, AbortSignal, require: name => modules[name], setTimeout: fn => fn(),
    fetch: async () => {
      onFetch?.()
      return { ok: true, json: async () => ({ message: { content: JSON.stringify(steps.shift() ?? { action: 'wait' }) } }) }
    }
  })
  return { run: signal => exports.computerUseTask('Cherche un tuto guitare', 'test', line => logs.push(line), signal),
    state: () => ({ captures, actions, hidden, logs }) }
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
