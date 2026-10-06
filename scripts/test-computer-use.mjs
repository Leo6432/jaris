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

// Étape 251 : le viseur (maiUi.ts) et le choix du rôle (shared/pilotModel.ts) sont les VRAIS modules : seul
// l'appel au modèle est simulé, pour tester la vraie conversion recadrage -> écran à travers la vraie boucle.
function loadReal(path) {
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  vm.runInThisContext(`(function (exports, require, module) {\n${code}\n})`)(module.exports, () => ({}), module)
  return module.exports
}
const maiUi = loadReal('../electron/services/maiUi.ts')
const pilotModel = loadReal('../shared/pilotModel.ts')

/**
 * Fausse capture à pleine résolution (2560 x 1440) : chaque vue (entière ou recadrée) garde dans son « image »
 * le rectangle d'écran qu'elle montre, pour que le faux viseur vise comme s'il voyait vraiment l'écran.
 */
function fakeFull(width = 2560, height = 1440) {
  const view = (rect, w, h) => ({
    getSize: () => ({ width: w, height: h }),
    crop: (r) => view({ x: rect.x + r.x, y: rect.y + r.y, w: r.width, h: r.height }, r.width, r.height),
    resize: ({ width: nw }) => view(rect, nw, Math.round((h * nw) / w)),
    toPNG: () => ({ toString: () => JSON.stringify(rect) })
  })
  return view({ x: 0, y: 0, w: width, h: height }, width, height)
}

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
    './maiUi': maiUi,
    '../../shared/pilotModel': pilotModel,
    './scanOverlay': { showScanOverlay() {}, hideScanOverlay() { hidden++ } },
    './inputControl': {
      clickMouse: (...a) => input('click', ...a), typeText: (...a) => input('type', ...a), pressKey: (...a) => input('key', ...a)
    },
    './uiAutomation': {
      listClickableElements: async () => { uiaReads++; return elements },
      findElementByName: uia.exports.findElementByName,
      describeElements: uia.exports.describeElements
    },
    './vision': {
      MAX_SCREENSHOT_WIDTH: 1280,
      captureScreenshotBase64: async () => { captures++; return { imageBase64: 'test', scale: pilot.scale ?? 1, width: 1280, height: 720 } },
      captureScreenForPilot: async () => { captures++; fullCaptures++; return { imageBase64: 'test', scale: pilot.scale ?? 1, width: 1280, height: 720, full: fakeFull() } }
    }
  }
  let fullCaptures = 0
  const aims = []
  const unloads = []
  const prompts = []
  const exports = {}
  vm.runInNewContext(source, {
    exports, Error, AbortSignal, require: name => modules[name], setTimeout: fn => fn(),
    fetch: async (url, options) => {
      const body = JSON.parse(options.body)
      if (url.endsWith('/api/generate')) {
        unloads.push(body)
        return { ok: true, json: async () => ({}) }
      }
      if (pilot.aim && body.model === pilotModel.PILOT_MODEL) {
        aims.push(body)
        pilot.onAim?.()
        return pilot.aim(body)
      }
      onFetch?.()
      bodies.push(body)
      prompts.push(body.messages[body.messages.length - 1].content)
      const next = steps.shift() ?? { action: 'wait' }
      return { ok: true, json: async () => ({ message: { content: typeof next === 'string' ? next : JSON.stringify(next) } }) }
    }
  })
  return { exports, run: signal => exports.computerUseTask('Cherche un tuto guitare', 'test', line => logs.push(line), signal),
    state: () => ({ captures, fullCaptures, actions, hidden, logs, clicks: clicks.map((c) => c[0] === 'click' ? c.slice(1) : c), calls: clicks, prompts, bodies, uiaReads, aims, unloads }) }
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
    [{ action: 'click_element', name: 'Envoyer' }, { action: 'click', x: 500, y: 500 }, { action: 'done', result: 'Fait' }],
    'Clic left effectué à (12, 34).',
    undefined,
    ELEMENTS
  )
  assert.equal(await app.run(), 'Fait')
  // Aucun clic pour l'élément manquant, puis le clic par position du tour suivant (milieu de l'image 1280 × 720).
  assert.equal(app.state().clicks.length, 1)
  assert.deepEqual(app.state().clicks[0], [640, 360, 'left'])
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
  assert.match(app.state().prompts[0], /aucun élément cliquable.*clics par position \(x\/y de 0 à 1000\)/s)
})

// --- Étape 251 : le viseur MAI-UI vise ce que le modèle de vision a décidé de cliquer ---

const PILOT = pilotModel.PILOT_MODEL
const ok = (_kind, ...args) => {
  if (_kind === 'click') return `Clic ${args[2]} effectué à (${args[0]}, ${args[1]}).`
  if (_kind === 'type') return 'Texte tapé.'
  if (_kind === 'key') return `Touche "${args[0]}" pressée.`
}
/** Le vrai bouton « Rechercher », en pixels de la capture pleine résolution (2560 x 1440). */
const TRUTH = { 'the "Rechercher" button': [2000, 300] }
/** Faux MAI-UI : vise le vrai bouton dans la vue qu'il reçoit, avec une erreur en pixels au 1er regard seulement. */
function fakeMaiUi({ firstError = [0, 0], answer } = {}) {
  return (body) => {
    const user = body.messages.at(-1)
    const target = user.content.replace(/^Click on /, '').trim()
    const view = JSON.parse(user.images[0])
    const zoomed = view.w < 2560
    const [tx, ty] = TRUTH[target]
    const [ex, ey] = zoomed ? [0, 0] : firstError
    const fx = (tx + ex - view.x) / view.w
    const fy = (ty + ey - view.y) / view.h
    const content = answer ?? `<grounding_think>ok</grounding_think><answer>{"coordinate":[${Math.round(fx * 999)},${Math.round(fy * 999)}]}</answer>`
    return { ok: true, json: async () => ({ message: { content } }) }
  }
}
const withPilot = (extra = {}) => ({ profile: { pilotModel: PILOT }, installed: [PILOT, 'qwen3.5:4b'], scale: 2, ...extra })
const CLICK = { action: 'click', x: 700, y: 180, target: 'the "Rechercher" button' }

test('viseur installé : le modèle de vision décide, MAI-UI vise avec son zoom, et le clic tombe sur le vrai bouton', async () => {
  // 1er regard 90 px à côté (il raterait le bouton), corrigé par le zoom.
  const app = setup([CLICK, { action: 'done', result: 'ok' }], ok, undefined, ELEMENTS, withPilot({ aim: fakeMaiUi({ firstError: [90, 40] }) }))
  assert.equal(await app.run(), 'ok')
  const { aims, clicks, bodies, uiaReads, unloads, prompts } = app.state()
  // Le modèle de vision reçoit la règle « target » en plus de sa consigne habituelle, et la liste Windows.
  assert.match(bodies[0].messages[0].content, /"target"/)
  assert.equal(bodies[0].messages[0].content, `${app.exports.SYSTEM_PROMPT}\n\n${app.exports.PILOT_TARGET_RULE}`)
  assert.ok(uiaReads > 0, 'un clic par le nom reste possible et exact')
  // Deux regards : toute l'image, puis la moitié de l'écran autour du 1er point ; consigne officielle, température 0.
  assert.equal(aims.length, 2)
  assert.equal(aims[0].messages[0].content, maiUi.MAI_UI_GROUNDING_PROMPT)
  assert.equal(aims[0].messages[1].content, 'Click on the "Rechercher" button\n')
  assert.equal(aims[0].options.temperature, 0)
  assert.equal(JSON.parse(aims[1].messages[1].images[0]).w, 1280, 'le 2e regard est recadré')
  // Pixels de l'image (1280 x 720) x 2 = l'écran : le vrai bouton (2000, 300), à l'arrondi de l'échelle 0–999 près.
  assert.ok(Math.abs(clicks[0][0] - 2000) <= 2 && Math.abs(clicks[0][1] - 300) <= 2, JSON.stringify(clicks[0]))
  // La carte est libérée pour le modèle de vision, et l'historique dit qui a visé.
  assert.deepEqual(unloads.map((u) => [u.model, u.keep_alive]), [[PILOT, 0]])
  assert.match(prompts[1], /Clic left sur the "Rechercher" button à \(\d+, \d+\) \(visé par MAI-UI\)/)
})

test('viseur : sans le zoom, le même 1er regard aurait raté — le test mord vraiment', async () => {
  const app = setup([CLICK, { action: 'done', result: 'ok' }], ok, undefined, [], withPilot({ aim: fakeMaiUi({ firstError: [90, 40] }) }))
  await app.run()
  const first = JSON.parse(app.state().aims[1].messages[1].images[0])
  // Le recadrage est centré sur le 1er point (2090, 340), pas sur le bon : c'est bien le 2e regard qui corrige.
  assert.deepEqual([first.x, first.y], [1280, 0])
})

test('viseur illisible : la position estimée par le modèle de vision sert de secours, la tâche continue', async () => {
  const app = setup([CLICK, { action: 'done', result: 'ok' }], ok, undefined, [], withPilot({ aim: fakeMaiUi({ answer: 'je ne vois pas' }) }))
  assert.equal(await app.run(), 'ok')
  // (700, 180) sur 0–1000 de l'image 1280 x 720 = (896, 129.6), x 2 pour l'écran.
  assert.deepEqual(app.state().clicks[0], [1792, 259, 'left'])
  assert.equal(app.state().aims.length, 1, 'pas de zoom sans 1er point')
  assert.match(app.state().prompts[1], /viseur sans réponse lisible : position estimée/)
})

test('viseur injoignable : la vraie raison est notée, la position estimée sert de secours', async () => {
  const down = () => ({ ok: false, status: 500, text: async () => 'model runner has unexpectedly stopped' })
  const app = setup([CLICK, { action: 'done', result: 'ok' }], ok, undefined, [], withPilot({ aim: down }))
  assert.equal(await app.run(), 'ok')
  assert.deepEqual(app.state().clicks[0], [1792, 259, 'left'])
  assert.match(app.state().prompts[1], /viseur indisponible : le viseur a répondu 500 : model runner has unexpectedly stopped/)
})

test('viseur : une annulation pendant la visée empêche tout clic', async () => {
  const controller = new AbortController()
  const app = setup([CLICK], ok, undefined, [], withPilot({ aim: fakeMaiUi(), onAim: () => controller.abort() }))
  assert.match(await app.run(controller.signal), /interrompue/)
  assert.equal(app.state().actions, 0)
})

test('viseur : un clic par le nom (Windows) et un clic sans cible décrite ne le sollicitent pas', async () => {
  const app = setup(
    [{ action: 'click_element', name: 'Rechercher' }, { action: 'click', x: 500, y: 500 }, { action: 'done', result: 'ok' }],
    ok,
    undefined,
    ELEMENTS,
    withPilot({ aim: fakeMaiUi() })
  )
  assert.equal(await app.run(), 'ok')
  assert.equal(app.state().aims.length, 0)
  assert.deepEqual(app.state().clicks, [[300, 120, 'left'], [1280, 720, 'left']])
})

test('profil qui cite encore UI-TARS : pas de viseur, consigne habituelle intacte, comme sans rôle', async () => {
  const old = 'hf.co/mradermacher/UI-TARS-1.5-7B-GGUF:Q4_K_M'
  const app = setup([CLICK, { action: 'done', result: 'ok' }], ok, undefined, [], { profile: { pilotModel: old }, installed: [old, 'qwen3.5:4b'], aim: fakeMaiUi() })
  assert.equal(await app.run(), 'ok')
  assert.equal(app.state().aims.length, 0)
  assert.equal(app.state().fullCaptures, 0)
  assert.equal(app.state().bodies[0].messages[0].content, app.exports.SYSTEM_PROMPT, 'copie vérifiée par le test des modèles de vision')
  assert.deepEqual(app.state().clicks[0], [896, 130, 'left'])
})

test('profil qui cite MAI-UI mais qu’Ollama ne l’a plus : le modèle de vision vise lui-même', async () => {
  const app = setup([CLICK, { action: 'done', result: 'ok' }], ok, undefined, [], { profile: { pilotModel: PILOT }, installed: ['qwen3.5:4b'], aim: fakeMaiUi() })
  assert.equal(await app.run(), 'ok')
  assert.equal(app.state().aims.length, 0)
  assert.equal(app.state().bodies[0].model, 'test')
})

// Campagne de Léo (05/10/2026) : les modèles de vision visent sur 0–1000 (qwen3.8:27b : 9 clics justes sur 10 lus
// ainsi, 3 sur 10 lus en pixels). Leur position est ramenée à l'image, puis à l'écran réel (facteur d'échelle).
test('modèle de vision : position sur 0–1000 ramenée à l’image puis à l’écran ; au-delà de 1000, des pixels', async () => {
  const app = setup(
    [{ action: 'click', x: 1000, y: 1000 }, { action: 'click', x: 250, y: 100 }, { action: 'click', x: 1100, y: 300 }, { action: 'done', result: 'ok' }],
    ok,
    undefined,
    [],
    { scale: 1.5 }
  )
  assert.equal(await app.run(), 'ok')
  // (1000, 1000) = coin bas droit de l'image 1280 × 720, × 1,5 pour l'écran réel 1920 × 1080.
  assert.deepEqual(app.state().clicks[0], [1920, 1080, 'left'])
  assert.deepEqual(app.state().clicks[1], [480, 108, 'left'])
  // x = 1100 : forcément un pixel de l'image (repli pour un modèle qui ignore la consigne).
  assert.deepEqual(app.state().clicks[2], [1650, 450, 'left'])
  assert.match(app.state().bodies[0].messages[0].content, /échelle de 0 à 1000/)
})
