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
loadUia(uia.exports, () => ({}), uia)

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
// Étape 256 : le centre des éléments numérotés est calculé par le vrai module.
const screenMarks = loadReal('../electron/services/screenMarks.ts')

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

/** Réponse d'Ollama en continu (étape 255) : une ligne JSON par morceau, le texte coupé en deux morceaux. */
function streamed(content) {
  const half = Math.floor(content.length / 2)
  const lines = [content.slice(0, half), content.slice(half)].map((part) => JSON.stringify({ message: { content: part }, done: false }))
  return new Response(lines.join('\n') + '\n' + JSON.stringify({ done: true }))
}

// Étape 231 : `pilot` = profil + modèles installés simulés. Par défaut, aucun modèle de pilotage : le modèle de
// vision pilote, exactement comme avant — tous les tests historiques ci-dessous passent par ce chemin.
/**
 * `pilot.textSteps` (étape 256) : réponses du modèle rapide qui planifie sans image (profil `models.medium`) ;
 * `pilot.physical` : capture sensible au DPI (clics en pixels réels).
 */
function setup(steps, inputResult, onFetch, elements = [], pilot = { profile: null, installed: [] }) {
  let captures = 0
  let asides = 0
  let backs = 0
  const textBodies = []
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
    './uiAutomation': uia.exports,
    './screenMarks': screenMarks,
    './pilotWindows': {
      withJarisSetAside: async (task) => {
        asides++
        try { return await task() } finally { backs++ }
      }
    },
    './markedCapture': {
      capturePilotScreen: async () => {
        captures++
        uiaReads++
        return { imageBase64: 'test', scale: pilot.scale ?? 1, width: 1280, height: 720, full: fakeFull(), marks: elements, physical: pilot.physical ?? false, window: 'YouTube - Firefox' }
      }
    },
    './vision': { MAX_SCREENSHOT_WIDTH: 1280 },
    // Étape 260 : l'ouverture d'une application par Windows, simulée (le vrai openApp passe par PowerShell).
    './appLauncher': {
      didAppLaunch: (result) => result.endsWith('a été lancé.'),
      openApp: async (name) => { opened.push(name); return pilot.openResult ?? `${name} a été lancé.` }
    }
  }
  const aims = []
  const opened = []
  const unloads = []
  const prompts = []
  const exports = {}
  vm.runInNewContext(source, {
    exports, Error, AbortSignal, AbortController, TextDecoder, require: name => modules[name],
    // L'attente « wait » (1,2 s) passe tout de suite ; les délais d'inactivité (minutes) ne se déclenchent jamais ici.
    setTimeout: (fn, ms) => (ms <= 2000 ? fn() : 0), clearTimeout: () => {},
    fetch: async (url, options) => {
      const body = JSON.parse(options.body)
      if (url.endsWith('/api/generate')) {
        unloads.push(body)
        return { ok: true, json: async () => ({}) }
      }
      if (body.model === pilot.profile?.models?.medium) {
        textBodies.push(body)
        pilot.onText?.()
        if (pilot.textError) return { ok: false, status: 500, text: async () => pilot.textError }
        const next = pilot.textSteps?.shift() ?? { action: 'look' }
        return streamed(typeof next === 'string' ? next : JSON.stringify(next))
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
      return streamed(typeof next === 'string' ? next : JSON.stringify(next))
    }
  })
  return { exports, run: signal => exports.computerUseTask('Cherche un tuto guitare', 'test', line => logs.push(line), signal),
    state: () => ({
      captures, actions, hidden, logs, clicks: clicks.map((c) => c[0] === 'click' ? c.slice(1, 4) : c), calls: clicks, prompts, bodies, uiaReads, aims, unloads,
      physical: clicks.filter((c) => c[0] === 'click').map((c) => c[4]), textBodies, asides, backs, opened
    }) }
}

for (const step of [{ action: 'move' }, { action: 'click' }, { action: 'click', x: 'douze', y: 2 }, { action: 'click', x: '12px', y: 2 }, { action: 'open_app', app: ' ' }, { action: 'type', text: '' }, { action: 'key', key: 42 }]) {
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

// Étape 256 : des éléments numérotés, avec le rectangle donné par Windows — le clic vise son centre.
const ELEMENTS = [
  { id: 1, name: 'Rechercher', type: 'Edit', x: 250, y: 100, w: 100, h: 40 },
  { id: 2, name: 'Se connecter', type: 'Button', x: 600, y: 25, w: 80, h: 30 }
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

test('la liste des éléments est bien transmise au modèle, avec les numéros dessinés sur la capture', async () => {
  const app = setup([{ action: 'done', result: 'ok' }], '', undefined, ELEMENTS)
  await app.run()
  assert.match(app.state().prompts[0], /encadrés et numérotés sur la capture/)
  assert.match(app.state().prompts[0], /^1\. \[Edit\] Rechercher$/m)
  assert.match(app.state().prompts[0], /^2\. \[Button\] Se connecter$/m)
  // La règle « clique par numéro » s'ajoute aux consignes, qui restent identiques à leur copie de test.
  assert.equal(app.state().bodies[0].messages[0].content, `${app.exports.SYSTEM_PROMPT}\n\n${app.exports.OPEN_APP_RULE}\n\n${app.exports.MARKS_RULE}`)
})

test("sans arbre d'accessibilité, le modèle est explicitement renvoyé vers le clic en pixels", async () => {
  const app = setup([{ action: 'done', result: 'ok' }], '', undefined, [])
  await app.run()
  assert.match(app.state().prompts[0], /aucun élément cliquable.*clics par position \(x\/y de 0 à 1000\)/s)
})

// --- Étape 256 : éléments numérotés sur la capture (Set-of-Marks) ---

/** Le module tourne dans un autre realm (vm.runInNewContext) : ses objets se comparent par leur contenu. */
const plain = (value) => (value === null ? null : JSON.parse(JSON.stringify(value)))

test('click_element par numéro : clic au centre du rectangle de Windows, dans le repère de la capture', async () => {
  const app = setup(
    [{ action: 'click_element', id: 2 }, { action: 'done', result: 'Connexion ouverte' }],
    'Clic left effectué à (640, 40).',
    undefined,
    ELEMENTS,
    { profile: null, installed: [], physical: true }
  )
  assert.equal(await app.run(), 'Connexion ouverte')
  assert.deepEqual(app.state().clicks[0], [640, 40, 'left'])
  assert.deepEqual(app.state().physical, [true], 'capture sensible au DPI : clic en pixels réels')
  assert.match(app.state().prompts[1], /Clic sur "Se connecter" \(Button, position donnée par Windows\)/)
})

test('numéro absent de la liste : rien n’est cliqué, l’historique le dit, la tâche continue', async () => {
  const app = setup([{ action: 'click_element', id: 9 }, { action: 'done', result: 'Fait' }], ok, undefined, ELEMENTS)
  assert.equal(await app.run(), 'Fait')
  assert.equal(app.state().actions, 0)
  assert.match(app.state().prompts[1], /Élément n°9 introuvable/)
})

test('numéro écrit en texte ("12") accepté ; zéro, négatif ou décimal refusés', () => {
  const app = setup([])
  assert.deepEqual(plain(app.exports.extractStep('{"action":"click_element","id":"2"}')), { action: 'click_element', id: 2 })
  for (const raw of ['{"action":"click_element","id":0}', '{"action":"click_element","id":-3}', '{"action":"click_element","id":1.5}']) {
    assert.equal(app.exports.extractStep(raw), null, raw)
  }
  // L'ancienne forme (par le nom) reste comprise.
  assert.deepEqual(plain(app.exports.extractStep('{"action":"click_element","name":"OK"}')), { action: 'click_element', name: 'OK' })
})

test('capture sensible au DPI : un clic par position est fait en pixels réels lui aussi', async () => {
  const app = setup([{ action: 'click', x: 500, y: 500 }, { action: 'done', result: 'ok' }], ok, undefined, [], { profile: null, installed: [], physical: true, scale: 1.5 })
  assert.equal(await app.run(), 'ok')
  assert.deepEqual(app.state().clicks[0], [960, 540, 'left'])
  assert.deepEqual(app.state().physical, [true])
})

test('Jaris est écarté pendant toute la tâche, et revient même quand elle échoue', async () => {
  const done = setup([{ action: 'done', result: 'ok' }])
  await done.run()
  assert.deepEqual([done.state().asides, done.state().backs], [1, 1])
  const failed = setup([{ action: 'fail', result: 'Page de connexion' }])
  await assert.rejects(failed.run(), /Page de connexion/)
  assert.deepEqual([failed.state().asides, failed.state().backs], [1, 1])
})

// --- Étape 256 : planifier sans image quand Windows donne une liste fournie ---

const MEDIUM = 'granite4.2:8b'
const PAGE = [
  ...ELEMENTS,
  { id: 3, name: 'Accueil', type: 'Hyperlink', x: 10, y: 80, w: 100, h: 30 },
  { id: 4, name: 'Shorts', type: 'Hyperlink', x: 10, y: 120, w: 100, h: 30 },
  { id: 5, name: 'Tuto guitare débutant', type: 'Hyperlink', x: 300, y: 300, w: 400, h: 60 }
]
const planner = (textSteps, extra = {}) => ({ profile: { models: { medium: MEDIUM } }, installed: [MEDIUM], textSteps, ...extra })

test('liste fournie : le modèle rapide pilote sans image — aucun appel au modèle de vision', async () => {
  const app = setup([], ok, undefined, PAGE, planner([
    { action: 'click_element', id: 1 }, { action: 'type', text: 'tuto guitare' }, { action: 'key', key: 'entrée' }, { action: 'done', result: 'Recherche lancée' }
  ]))
  assert.equal(await app.run(), 'Recherche lancée')
  const { bodies, textBodies, calls, logs } = app.state()
  assert.equal(bodies.length, 0, 'pas une seule capture envoyée au modèle de vision')
  assert.deepEqual(calls.map((c) => c[0]), ['click', 'type', 'key'])
  assert.deepEqual(app.state().clicks[0], [300, 120, 'left'])
  // Sans image, liste numérotée + titre de la fenêtre, consigne propre, réponse forcée en JSON, température 0.
  const first = textBodies[0]
  assert.equal(first.model, MEDIUM)
  assert.ok(first.messages.every((m) => !m.images))
  assert.equal(first.messages[0].content, app.exports.TEXT_PLANNER_PROMPT)
  assert.match(first.messages[1].content, /Fenêtre au premier plan : « YouTube - Firefox »/)
  assert.match(first.messages[1].content, /^5\. \[Hyperlink\] Tuto guitare débutant$/m)
  assert.deepEqual(first.format, plain(app.exports.TEXT_STEP_FORMAT))
  assert.equal(first.think, false)
  assert.equal(first.options.temperature, 0)
  assert.match(textBodies[3].messages[1].content, /Texte tapé : "tuto guitare"/)
  assert.ok(logs.some((l) => /je lis les boutons de la fenêtre/.test(l)))
})

test('« look » : l’étape passe au modèle de vision, sur la même capture', async () => {
  const app = setup([{ action: 'click_element', id: 5 }, { action: 'done', result: 'ok' }], ok, undefined, PAGE, planner([{ action: 'look' }, { action: 'done', result: 'ok' }]))
  assert.equal(await app.run(), 'ok')
  const { bodies, textBodies, captures } = app.state()
  assert.equal(bodies.length, 1)
  assert.equal(textBodies.length, 2)
  // Une seule capture pour l'étape 1 (texte puis vision), une pour l'étape 2.
  assert.equal(captures, 2)
  assert.ok(app.state().logs.some((l) => /je regarde l'écran de plus près/.test(l)))
})

test('deux « look » : la liste ne suffit pas ici, le modèle rapide n’est plus sollicité', async () => {
  const app = setup(
    [{ action: 'wait' }, { action: 'click_element', id: 5 }, { action: 'click_element', id: 2 }, { action: 'done', result: 'ok' }],
    ok, undefined, PAGE, planner([{ action: 'look' }, { action: 'look' }, { action: 'done', result: 'jamais lu' }])
  )
  assert.equal(await app.run(), 'ok')
  assert.equal(app.state().textBodies.length, 2)
  assert.equal(app.state().bodies.length, 4)
})

test('« fini » alors que rien n’a été fait : sans image ce serait une supposition, la vision vérifie', async () => {
  const app = setup([{ action: 'click_element', id: 1 }, { action: 'done', result: 'vu' }], ok, undefined, PAGE, planner([{ action: 'done', result: 'déjà fait' }, { action: 'look' }]))
  assert.equal(await app.run(), 'vu')
  assert.equal(app.state().bodies.length, 2)
})

test('étape 259 : le modèle rapide reclique 3 fois le même bouton : la vision reprend, elle voit le résultat', async () => {
  // Reproduit avec granite4.2:8b sur la Calculatrice : « Sept » cliqué en boucle jusqu'à la 20e étape.
  const app = setup([{ action: 'done', result: '12 affiché' }], ok, undefined, PAGE, planner([
    { action: 'click_element', id: 5 }, { action: 'click_element', id: 5 }, { action: 'click_element', id: 5 }, { action: 'click_element', id: 5 }
  ]))
  assert.equal(await app.run(), '12 affiché')
  assert.equal(app.state().textBodies.length, 3, 'plus aucun appel au modèle rapide après le 3e clic identique')
  assert.equal(app.state().bodies.length, 1)
  assert.ok(app.state().logs.some((l) => /même bouton 3 fois de suite, je regarde l'écran/.test(l)))
})

test('étape 259 : des clics différents, ou le même bouton non consécutif, ne déclenchent rien', async () => {
  const app = setup([], ok, undefined, PAGE, planner([
    { action: 'click_element', id: 5 }, { action: 'click_element', id: 5 }, { action: 'click_element', id: 4 },
    { action: 'click_element', id: 5 }, { action: 'click_element', id: 5 }, { action: 'done', result: 'ok' }
  ]))
  assert.equal(await app.run(), 'ok')
  assert.equal(app.state().bodies.length, 0)
})

test('numéro inventé par le modèle rapide : jamais cliqué, la vision reprend l’étape', async () => {
  const app = setup([{ action: 'done', result: 'ok' }], ok, undefined, PAGE, planner([{ action: 'click_element', id: 42 }]))
  assert.equal(await app.run(), 'ok')
  assert.equal(app.state().actions, 0)
  assert.equal(app.state().bodies.length, 1)
})

test('modèle rapide en erreur : la vraie raison est notée, il n’est plus resollicité', async () => {
  const app = setup([{ action: 'wait' }, { action: 'done', result: 'ok' }], ok, undefined, PAGE, planner([], { textError: 'model not found' }))
  assert.equal(await app.run(), 'ok')
  assert.equal(app.state().textBodies.length, 1)
  assert.ok(app.state().logs.some((l) => /Lecture des boutons par granite4\.2:8b impossible \(Ollama a répondu 500 : model not found\)/.test(l)))
})

test('peu de boutons (moins de 5), modèle rapide absent du profil ou désinstallé : vision directement', async () => {
  for (const [elements, pilot] of [
    [ELEMENTS, planner([{ action: 'done', result: 'x' }])],
    [PAGE, { profile: null, installed: [] }],
    [PAGE, { ...planner([{ action: 'done', result: 'x' }]), installed: [] }]
  ]) {
    const app = setup([{ action: 'done', result: 'ok' }], ok, undefined, elements, pilot)
    assert.equal(await app.run(), 'ok')
    assert.equal(app.state().textBodies.length, 0)
  }
})

test('annulation pendant la lecture des boutons : aucun clic', async () => {
  const controller = new AbortController()
  const app = setup([], ok, undefined, PAGE, planner([{ action: 'click_element', id: 1 }], { onText: () => controller.abort() }))
  assert.match(await app.run(controller.signal), /interrompue/)
  assert.equal(app.state().actions, 0)
})

test('réponse du modèle rapide : seules les actions exécutables passent', () => {
  const app = setup([])
  const marks = [{ id: 1 }, { id: 2 }]
  const read = (raw) => plain(app.exports.extractTextStep(raw, marks))
  assert.deepEqual(read('{"action":"click_element","id":2}'), { action: 'click_element', id: 2 })
  assert.deepEqual(read('```json\n{"action":"key","key":"entrée"}\n```'), { action: 'key', key: 'entrée' })
  assert.deepEqual(read('{"action":"look"}'), { action: 'look' })
  assert.deepEqual(read('{"action":"done","result":"ok"}'), { action: 'done', result: 'ok' })
  for (const raw of ['{"action":"click_element","id":3}', '{"action":"click","x":1,"y":2}', '{"action":"type","text":" "}', 'rien', '{"action":"scroll"}']) {
    assert.equal(read(raw), null, raw)
  }
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
    return streamed(content)
  }
}
const withPilot = (extra = {}) => ({ profile: { pilotModel: PILOT }, installed: [PILOT, 'qwen3.5:4b'], scale: 2, ...extra })
const CLICK = { action: 'click', x: 700, y: 180, target: 'the "Rechercher" button' }

test('viseur installé : le modèle de vision décide, MAI-UI vise avec son zoom, et le clic tombe sur le vrai bouton', async () => {
  // 1er regard 90 px à côté (il raterait le bouton), corrigé par le zoom.
  const app = setup([CLICK, { action: 'done', result: 'ok' }], ok, undefined, ELEMENTS, withPilot({ aim: fakeMaiUi({ firstError: [90, 40] }) }))
  assert.equal(await app.run(), 'ok')
  const { aims, clicks, bodies, uiaReads, unloads, prompts } = app.state()
  // Le modèle de vision reçoit les règles « numéro » et « target » en plus de sa consigne habituelle, et la liste Windows.
  assert.match(bodies[0].messages[0].content, /"target"/)
  assert.equal(bodies[0].messages[0].content, `${app.exports.SYSTEM_PROMPT}\n\n${app.exports.OPEN_APP_RULE}\n\n${app.exports.MARKS_RULE}\n\n${app.exports.PILOT_TARGET_RULE}`)
  assert.ok(uiaReads > 0, 'un clic par numéro reste possible et exact')
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
  assert.match(app.state().prompts[1], /viseur indisponible : Ollama a répondu 500 : model runner has unexpectedly stopped/)
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
  assert.equal(app.state().bodies[0].messages[0].content, `${app.exports.SYSTEM_PROMPT}\n\n${app.exports.OPEN_APP_RULE}`, 'copie vérifiée par le test des modèles de vision, plus la règle d’ouverture')
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

// --- Étape 255 : plus de limite fixe de 45 s — on attend tant que le modèle donne signe de vie ---

/** Le module avec des minuteries pilotées par le test, et un faux Ollama qui ne répond qu'au signal d'arrêt. */
function silentOllama({ firstChunk = false } = {}) {
  const timers = []
  const exports = {}
  const modules = {
    '../config': { config: { ollama: { host: 'http://test', numCtx: 8192 } } },
    './hardwareScan': {}, './ollama': {}, './profileStore': {}, './scanOverlay': {}, './inputControl': {},
    './maiUi': maiUi, '../../shared/pilotModel': pilotModel, './uiAutomation': {}, './vision': {}
  }
  vm.runInNewContext(source, {
    exports, Error, AbortSignal, AbortController, TextDecoder, require: (name) => modules[name],
    setTimeout: (fn, ms) => (timers.push({ fn, ms }), timers.length), clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = null },
    fetch: async (_url, options) => {
      const aborted = new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))))
      if (!firstChunk) return aborted
      let sent = false
      return new Response(new ReadableStream({
        async pull(controller) {
          if (!sent) {
            sent = true
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ message: { content: '{"action":' } }) + '\n'))
            return
          }
          await aborted.catch((err) => controller.error(err))
        }
      }))
    }
  })
  const fire = (ms) => {
    const timer = [...timers].reverse().find((t) => t.ms === ms && t.fn)
    assert.ok(timer, `aucune minuterie de ${ms} ms en attente`)
    timer.fn()
  }
  return { exports, timers, fire }
}

test('rien reçu : on attend 3 min (chargement d’un gros modèle), puis une raison claire en français', async () => {
  const o = silentOllama()
  const call = o.exports.streamOllamaChat({ model: 'qwen3.8:27b' })
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(o.timers.map((t) => t.ms), [180000], 'plus de limite de 45 s avant le premier morceau')
  o.fire(180000)
  await assert.rejects(call, /il n'a rien répondu en 3 min \(chargement ou lecture de l'image trop long sur cette machine\)/)
})

test('le modèle répond puis se tait : abandon après 45 s de silence, pas avant', async () => {
  const o = silentOllama({ firstChunk: true })
  const call = o.exports.streamOllamaChat({ model: 'qwen3.8:27b' })
  for (let i = 0; i < 5 && !o.timers.some((t) => t.ms === 45000); i++) await new Promise((r) => setImmediate(r))
  assert.ok(o.timers.some((t) => t.ms === 45000), 'le délai d’inactivité est armé après le premier morceau')
  o.fire(45000)
  await assert.rejects(call, /il s'est arrêté de répondre pendant 45 s/)
})


// --- Étape 260 : coordonnées entre guillemets, et ouverture d'application par Windows ---

test('étape 260 : la réponse RÉELLE de qwen3.8:27b chez Léo (x/y entre guillemets) est exécutée, plus refusée', async () => {
  const real = '{"action":"click","x":"396","y":"973","target":"the Windows Start/Search bar labeled \\"Rechercher\\" in the taskbar"}'
  const app = setup([real, { action: 'done', result: 'ok' }], 'Clic left effectué.')
  assert.equal(await app.run(), 'ok')
  // 396 et 973 sur 1000, ramenés à la capture de 1280 x 720.
  assert.deepEqual(app.state().clicks[0], [507, 701, 'left'])
  const step = app.exports.extractStep(real)
  assert.equal(step.x, 396)
  assert.equal(step.y, 973)
})

test('étape 260 : le modèle de vision ouvre une application par Windows, en une étape, puis continue', async () => {
  const app = setup([{ action: 'open_app', app: 'Calculatrice' }, { action: 'done', result: '12 affiché' }], 'x')
  assert.equal(await app.run(), '12 affiché')
  assert.deepEqual([...app.state().opened], ['Calculatrice'])
  assert.equal(app.state().actions, 0, 'aucun clic ni frappe pour ouvrir')
  assert.match(app.state().prompts[1], /Application ouverte par Windows : Calculatrice a été lancé\./)
  // La règle est donnée au modèle de vision, à côté des consignes inchangées (copie du test des modèles de vision).
  assert.ok(app.state().bodies[0].messages[0].content.includes(app.exports.OPEN_APP_RULE))
  assert.ok(app.state().bodies[0].messages[0].content.startsWith(app.exports.SYSTEM_PROMPT))
})

test('étape 260 : le modèle rapide peut aussi ouvrir une application, sans image', async () => {
  const app = setup([], 'x', undefined, PAGE, planner([{ action: 'open_app', app: 'Calculatrice' }, { action: 'done', result: 'ok' }]))
  assert.equal(await app.run(), 'ok')
  assert.deepEqual([...app.state().opened], ['Calculatrice'])
  assert.equal(app.state().bodies.length, 0)
  assert.match(app.state().textBodies[0].messages[0].content, /"action":"open_app"/)
})

test('étape 260 : application introuvable = pas un échec de la tâche, le modèle le voit et passe par le menu Démarrer', async () => {
  const app = setup([{ action: 'open_app', app: 'Calculette' }, { action: 'done', result: 'ok' }], 'x', undefined, [],
    { profile: null, installed: [], openResult: 'Je n\'ai trouvé aucune application nommée "Calculette" installée sur cette machine.' })
  assert.equal(await app.run(), 'ok')
  assert.match(app.state().prompts[1], /Ouverture de "Calculette" impossible : Je n'ai trouvé aucune application nommée "Calculette".* reste le menu Démarrer/)
})
