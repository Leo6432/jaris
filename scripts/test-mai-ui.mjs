import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * Étape 251 : MAI-UI 8B, le viseur du pilotage d'écran (maiUi.ts), et le choix du rôle (shared/pilotModel.ts).
 * Chargés dans le realm courant pour comparer des objets entiers.
 */
function load(path) {
  const source = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  vm.runInThisContext(`(function (exports, require, module) {\n${source}\n})`)(module.exports, () => ({}), module)
  return module.exports
}
const { MAI_UI_MODEL, MAI_UI_GROUNDING_PROMPT, maiUiInstruction, parseMaiUiPoint, zoomRect, aimWithMaiUi } = load('../electron/services/maiUi.ts')
const { pickPilotModel, PILOT_MODEL, PILOT_MODEL_LABEL } = load('../shared/pilotModel.ts')

test('le rôle installe bien MAI-UI, le modèle que le viseur sait lire', () => {
  assert.equal(PILOT_MODEL, MAI_UI_MODEL)
  assert.equal(PILOT_MODEL_LABEL, 'MAI-UI 8B')
})

test('rôle seulement avec une carte de 8 Go ou plus, sinon aucun modèle et une raison lisible', () => {
  assert.equal(pickPilotModel(8).model, PILOT_MODEL)
  assert.equal(pickPilotModel(7.6).model, PILOT_MODEL, 'une carte vendue 8 Go est lue 7,6 Go par nvidia-smi')
  assert.equal(pickPilotModel(24).model, PILOT_MODEL)
  const small = pickPilotModel(6)
  assert.equal(small.model, null)
  assert.match(small.reason, /6 Go/)
  assert.match(pickPilotModel(null).reason, /aucune carte graphique/)
})

test('échelle 0–999 de MAI-UI (vérifiée ici sur une capture 1920x1080 envoyée en 1280x720)', () => {
  const p = parseMaiUiPoint('<grounding_think>la barre</grounding_think>\n<answer>\n{"coordinate": [267, 130]}\n</answer>')
  assert.ok(Math.abs(p.fx - 267 / 999) < 1e-9 && Math.abs(p.fy - 130 / 999) < 1e-9)
  assert.deepEqual(parseMaiUiPoint('<answer>{"coordinate": [100, 200, 300, 400]}</answer>'), { fx: 200 / 999, fy: 300 / 999 })
  assert.deepEqual(parseMaiUiPoint('think [1,1] <answer>{"coordinate":[999,0]}</answer>'), { fx: 1, fy: 0 })
  assert.equal(parseMaiUiPoint('<answer>{"coordinate":[1200,40]}</answer>'), null, 'hors échelle : illisible, jamais ramené de force')
  assert.equal(parseMaiUiPoint('je ne sais pas'), null)
})

test('consigne : celle du duel, où MAI-UI a été mesuré', () => {
  assert.equal(maiUiInstruction(' the "Rechercher" button '), 'Click on the "Rechercher" button')
  assert.match(MAI_UI_GROUNDING_PROMPT, /<answer>\n\{"coordinate": \[x,y\]\}\n<\/answer>/)
})

test('zone du zoom : moitié de l’écran centrée sur le 1er point, sans jamais déborder', () => {
  assert.deepEqual(zoomRect(1280, 720, 2560, 1440), { x: 640, y: 360, w: 1280, h: 720 })
  assert.deepEqual(zoomRect(10, 10, 2560, 1440), { x: 0, y: 0, w: 1280, h: 720 })
  assert.deepEqual(zoomRect(2550, 1430, 2560, 1440), { x: 1280, y: 720, w: 1280, h: 720 })
})

test('visée : le 2e regard est reconverti du recadrage vers l’écran entier', async () => {
  const views = []
  const answers = ['<answer>{"coordinate":[999,0]}</answer>', '<answer>{"coordinate":[500,250]}</answer>']
  const aim = await aimWithMaiUi('the "OK" button', {
    width: 2560,
    height: 1440,
    view: async (rect) => (views.push(rect), { base64: 'x', width: 1280, height: 720 }),
    chat: async (messages) => {
      assert.equal(messages[0].content, MAI_UI_GROUNDING_PROMPT)
      assert.equal(messages[1].content, 'Click on the "OK" button\n')
      return answers.shift()
    }
  })
  // 1er point au coin haut droit -> recadrage collé en haut à droite ; (500, 250)/999 de ce recadrage.
  assert.deepEqual(views, [null, { x: 1280, y: 0, w: 1280, h: 720 }])
  assert.ok(Math.abs(aim.fx * 2560 - (1280 + (500 / 999) * 1280)) < 1e-6)
  assert.ok(Math.abs(aim.fy * 1440 - (250 / 999) * 720) < 1e-6)
  assert.equal(aim.zoomed, true)
})

test('visée : 2e regard illisible = 1er point gardé ; 1er regard illisible = null, sans 2e appel', async () => {
  const deps = (answers) => ({ width: 2560, height: 1440, view: async () => ({ base64: 'x', width: 1280, height: 720 }), chat: async () => answers.shift() })
  assert.deepEqual(await aimWithMaiUi('x', deps(['<answer>[999,999]</answer>', 'rien'])), { fx: 1, fy: 1, zoomed: false })
  const second = ['rien', '<answer>[1,1]</answer>']
  assert.equal(await aimWithMaiUi('x', deps(second)), null)
  assert.equal(second.length, 1, 'aucun zoom sans 1er point')
})

test('visée : une erreur d’appel remonte telle quelle (c’est la boucle qui choisit le secours)', async () => {
  await assert.rejects(
    aimWithMaiUi('x', { width: 10, height: 10, view: async () => ({ base64: 'x', width: 10, height: 10 }), chat: async () => { throw new Error('délai dépassé') } }),
    /délai dépassé/
  )
})
