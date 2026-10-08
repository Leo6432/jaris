import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import {
  PILOT_SYSTEM_PROMPT,
  VISION_PILOT_CASES,
  VISION_TEST_CASES,
  VISION_TOTAL,
  buildPilotPrompt,
  extractPilotStep,
  findPilotElement,
  isCorrectVisionAnswer,
  judgePilotStep,
  loadPilotTargets,
  loadVisionImage
} from './benchmark-vision.mjs'

/**
 * Étape 232 : test de vision version 2 (vraies captures d'écran). Pour chaque image, des réponses qu'un bon modèle
 * peut donner (avec ou sans phrase autour, chiffres ou lettres) doivent compter juste, et les réponses fausses
 * typiques (la valeur voisine, plusieurs valeurs à la fois) doivent compter faux.
 */
const ANSWERS = {
  'bloc-notes-courses.png': {
    good: ['6', 'Six.', 'Il faut acheter 6 œufs.', 'six oeufs'],
    bad: ['4', '2 bouteilles', 'Je ne sais pas.', '6 ou 4', "Ce n'est pas 6.", 'pas six']
  },
  'erreur-disque.png': {
    good: ['Rapport annuel.docx', '« Rapport annuel.docx »', 'Le fichier Rapport annuel.docx', "Rapport annuel.docx n'a pas pu être enregistré."],
    bad: ['Le disque D: est plein.', 'Microsoft Word']
  },
  'meteo-villes.png': {
    good: ['14 °C', '14', 'Il fait 14 degrés à Rennes.', 'quatorze degrés'],
    bad: ['16 °C', '12', '14 ou 16 °C', "Ce n'est pas 14 °C.", 'Non, pas 14.', '12, 14, 16 et 18 °C']
  },
  'premier-plan.png': {
    good: ['Spotify', 'Spotify Premium', "C'est Spotify."],
    bad: ['Discord', 'Spotify et Discord', "Ce n'est pas Spotify."]
  },
  'tableau-prix.png': {
    good: ['49,90 €', '49.90', '49,9 euros', 'Le clavier coûte 49,90 €.'],
    bad: ['59,90 €', '19,90 €', '49 €']
  },
  'mails-non-lus.png': {
    good: ['4', 'Quatre.', 'Il y a 4 mails non lus.'],
    bad: ['3', '7', '4 sur 7']
  },
  'boutons-enregistrer.png': {
    good: ['Annuler', '« Annuler »', 'Le bouton Annuler.'],
    bad: ['Enregistrer', 'Ne pas enregistrer']
  },
  'horloge.png': {
    good: ['14:37', '14 h 37', '14h37', 'Il est 14 heures 37.', 'quatorze heures trente-sept'],
    bad: ['14:47', '18:50', '4 octobre 2026']
  },
  'youtube-resultats.png': {
    good: ['Apprendre la guitare en 10 minutes – Leçon 1', 'Apprendre la guitare en 10 minutes - Leçon 1'],
    bad: ['Les 5 accords faciles pour débuter', 'tuto guitare']
  },
  'notification-message.png': {
    good: ['Julie Martin', 'Julie', "C'est Julie Martin."],
    bad: ['Marc', 'Messages']
  }
}

test('chaque capture a ses réponses justes et fausses, et le total suit ((10 lectures + 7 visées) × 2)', () => {
  assert.deepEqual(Object.keys(ANSWERS).sort(), VISION_TEST_CASES.map((c) => c.file).sort())
  assert.equal(VISION_TOTAL, 34)
})

for (const testCase of VISION_TEST_CASES) {
  test(`« ${testCase.file} » : réponses justes acceptées, fausses refusées`, () => {
    for (const a of ANSWERS[testCase.file].good) assert.equal(isCorrectVisionAnswer(testCase, a), true, `devait être juste : ${a}`)
    for (const a of ANSWERS[testCase.file].bad) assert.equal(isCorrectVisionAnswer(testCase, a), false, `devait être faux : ${a}`)
  })
}

test('les captures existent, en 1280x720 (la taille envoyée par look_at_screen), et partent avec l’installeur', () => {
  for (const testCase of VISION_TEST_CASES) {
    const png = Buffer.from(loadVisionImage(testCase), 'base64')
    assert.equal(png.subarray(1, 4).toString(), 'PNG', testCase.file)
    assert.equal(png.readUInt32BE(16), 1280, `${testCase.file} : largeur`)
    assert.equal(png.readUInt32BE(20), 720, `${testCase.file} : hauteur`)
  }
  const builder = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8')
  for (const file of ['benchmark-vision.mjs', 'benchmark-code.mjs', 'benchmark-browser.mjs', 'benchmark-scenarios.mjs', 'vision-tests/*.png', 'vision-tests/*.json']) {
    assert.ok(builder.includes(`- ${file}`), `${file} absent de electron-builder.yml`)
  }
  // Le script qui fabrique les captures produit exactement ces fichiers.
  const maker = readFileSync(new URL('./make-vision-tests.mjs', import.meta.url), 'utf8')
  for (const testCase of VISION_TEST_CASES) assert.ok(maker.includes(`'${testCase.file.replace('.png', '')}'`), testCase.file)
  assert.ok(existsSync(new URL('./vision-tests/', import.meta.url)))
})

// --- Visée : une étape de computer_use_task ---------------------------------------------------------------------

const box = (file, id) => loadPilotTargets()[file][id]
const center = (b) => [Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2)]
const click = ([x, y]) => JSON.stringify({ action: 'click', x, y })

/** Pour chaque cas : des réponses que Jaris exécuterait correctement, et des réponses fausses typiques. */
function pilotAnswers(testCase) {
  if (testCase.expect === 'done') {
    return {
      good: ['{"action":"done","result":"La recherche tuto guitare est affichée."}', '```json\n{"action":"done","result":"Fait."}\n```'],
      bad: [click(center(box('youtube-resultats.png', 'barre-recherche'))), '{"action":"type","text":"tuto guitare"}', 'C’est fait.']
    }
  }
  const target = box(testCase.file, testCase.target)
  const [cx, cy] = center(target)
  // Consigne de Jaris depuis la campagne du 05/10/2026 : positions sur 0–1000, la convention des modèles de vision.
  const k = ([x, y]) => [Math.round((x / 1280) * 1000), Math.round((y / 720) * 1000)]
  const good = [
    click(k([cx, cy])),
    `Voici l'action : {"action":"click","x":${k([target.x + 3, target.y + 3]).join(',"y":')}}`,
    JSON.stringify({ action: 'double_click', x: k([cx, cy])[0], y: k([cx, cy])[1] }),
    // Étape 260 : nombres entre guillemets, comme qwen3.8:27b chez Léo — lus comme des nombres par Jaris.
    JSON.stringify({ action: 'click', x: String(k([cx, cy])[0]), y: String(k([cx, cy])[1]) })
  ]
  // Une valeur au-delà de 1000 ne peut être qu'un pixel : un modèle qui répond quand même en pixels reste compris.
  if (cx > 1000) good.push(click([cx, cy]))
  const bad = [
    click(k([target.x + target.width + 20, cy])),
    '{"action":"done","result":"Fait."}',
    '{"action":"click","x":"cinq cents","y":300}',
    JSON.stringify({ action: 'right_click', x: k([cx, cy])[0], y: k([cx, cy])[1] })
  ]
  // En pixels SOUS 1000 : indiscernable de l'échelle 0–1000, donc lu comme tel — le clic part ailleurs.
  if (cx <= 1000 && cy <= 1000) bad.push(click([cx, cy]))
  if (testCase.elements) {
    good.push(JSON.stringify({ action: 'click_element', name: 'Annuler' }), JSON.stringify({ action: 'click_element', name: 'annuler' }))
    bad.push(JSON.stringify({ action: 'click_element', name: 'Ne pas enregistrer' }), JSON.stringify({ action: 'click_element', name: 'Quitter' }))
  }
  if (testCase.id === 'recherche-a-faire') bad.push('{"action":"type","text":"tuto guitare"}')
  return { good, bad }
}

for (const testCase of VISION_PILOT_CASES) {
  test(`visée « ${testCase.id} » : les bons clics (sur 0–1000) passent, les mauvais (à côté, en pixels, trop tôt « fini ») échouent`, () => {
    const targets = loadPilotTargets()
    const { good, bad } = pilotAnswers(testCase)
    for (const answer of good) assert.equal(judgePilotStep(testCase, answer, targets), null, answer)
    for (const answer of bad) assert.ok(judgePilotStep(testCase, answer, targets), `devait échouer : ${answer}`)
  })
}

test('les cibles de visée sont de vrais éléments des captures, à des endroits distincts', () => {
  const targets = loadPilotTargets()
  for (const testCase of VISION_PILOT_CASES.filter((c) => c.target)) {
    const b = targets[testCase.file]?.[testCase.target]
    assert.ok(b && b.width > 10 && b.height > 10 && b.x >= 0 && b.y >= 0 && b.x + b.width <= 1280 && b.y + b.height <= 720, testCase.id)
  }
  // Les trois boutons de la boîte « Enregistrer ? » ne se chevauchent pas : viser l'un ne touche jamais l'autre.
  const [a, n, c] = ['enregistrer', 'ne-pas-enregistrer', 'annuler'].map((id) => targets['boutons-enregistrer.png'][id])
  assert.ok(a.x + a.width <= n.x && n.x + n.width <= c.x)
})

/** Charge un fichier TypeScript de Jaris avec des dépendances neutres (seules ses fonctions pures servent ici). */
function loadTs(path) {
  const source = ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const stub = new Proxy(function () {}, { get: (_t, key) => (key === Symbol.toPrimitive ? () => '' : stub), apply: () => stub, construct: () => stub })
  const module = { exports: {} }
  const ui = path.includes('computerUse') ? loadTs('electron/services/uiAutomation.ts') : null
  vm.runInThisContext(`(function (exports, require, module) {\n${source}\n})`)(module.exports, (name) => (name === './uiAutomation' ? ui : stub), module)
  return module.exports
}

test('l’étape de pilotage du test est EXACTEMENT celle de Jaris (consignes, message, lecture de l’action)', () => {
  const real = loadTs('electron/services/computerUse.ts')
  const ui = loadTs('electron/services/uiAutomation.ts')
  assert.equal(PILOT_SYSTEM_PROMPT, real.SYSTEM_PROMPT)
  const elements = [{ name: 'Annuler', type: 'Button', x: 1, y: 1 }, { name: 'Ne pas enregistrer', type: 'Button', x: 2, y: 2 }]
  for (const testCase of VISION_PILOT_CASES) {
    assert.equal(buildPilotPrompt(testCase.goal, [], testCase.elements ?? []), real.buildStepPrompt(testCase.goal, [], testCase.elements ?? []))
  }
  assert.equal(buildPilotPrompt('x', ['1. Clic'], elements), real.buildStepPrompt('x', ['1. Clic'], elements))
  // Étape 256 : éléments numérotés sur la capture (Set-of-Marks).
  const marked = elements.map((element, index) => ({ ...element, id: index + 1 }))
  assert.equal(buildPilotPrompt('x', [], marked), real.buildStepPrompt('x', [], marked))
  const samples = [
    '{"action":"click","x":10,"y":20}', '```json\n{"action":"done","result":"ok"}\n```', '{"action":"click","x":"10","y":20}', '{"action":"scroll"}',
    '{"action":"click_element","name":" "}', '{"action":"type","text":"a"}', 'rien', '{"action":"key","key":"entrée"}', '{"action":"done","result":3}',
    '{"action":"click_element","id":4}', '{"action":"click_element","id":"12"}', '{"action":"click_element","id":0}', '{"action":"click_element","id":2,"name":"OK"}',
    // Étape 260.
    '{"action":"click","x":"douze","y":2}', '{"action":"click","x":"396","y":"973"}', '{"action":"open_app","app":"Calculatrice"}', '{"action":"open_app","app":" "}'
  ]
  for (const raw of samples) assert.deepEqual(extractPilotStep(raw), real.extractStep(raw), raw)
  for (const name of ['Annuler', 'annuler', 'Ne pas', 'enregistrer', 'Quitter', '']) {
    assert.equal(findPilotElement(elements, name)?.name ?? null, ui.findElementByName(elements, name)?.name ?? null, name)
  }
})

// Test de vision v4 (05/10/2026) : « 14 37 » (qwen3.5:4b) est la bonne heure, juste sans « h » ; une autre heure
// ou un nombre qui ne fait que contenir 14 reste faux.
test('horloge : « 14 37 » est juste, « 15 heures 37 » ou « 114 37 » non', () => {
  const clock = VISION_TEST_CASES.find((c) => c.file === 'horloge.png')
  for (const answer of ['14 37', '14:37', '14h37', 'Il est 14 heures 37.', 'Quatorze heures trente-sept']) assert.ok(isCorrectVisionAnswer(clock, answer), answer)
  for (const answer of ['15 heures 37', 'Treize quarante trois', '114 37', '14 h 47']) assert.ok(!isCorrectVisionAnswer(clock, answer), answer)
})

// Relecture du 05/10/2026 : plus de marge autour des cibles. gemma4:31b, gemma4:26b et gemma4:12b cliquaient 1 à
// 3 px AU-DESSUS de la barre de recherche (y = 80 sur 1000, soit 58 px ; la barre commence à 59 px) : compté juste
// grâce à une marge de 4 px, alors que sur un vrai écran le clic ne la touche pas. Le bord lui-même reste juste.
test('visée : un clic juste à côté de la cible est faux, un clic sur son bord est juste', () => {
  const targets = loadPilotTargets()
  const search = VISION_PILOT_CASES.find((c) => c.id === 'recherche-a-faire')
  const box = targets[search.file][search.target]
  assert.ok(judgePilotStep(search, '{"action":"click","x":318,"y":80}', targets), 'gemma4:31b : 58 px, au-dessus de la barre')
  assert.ok(judgePilotStep(search, '{"action":"click","x":313,"y":78}', targets), 'gemma4:12b : 56 px')
  // 82 sur 1000 = 59 px, exactement le bord haut de la barre.
  assert.equal(Math.round((82 / 1000) * 720), box.y)
  assert.equal(judgePilotStep(search, '{"action":"click","x":400,"y":82}', targets), null, 'sur le bord haut')
  assert.equal(judgePilotStep(search, '{"action":"click","x":318,"y":104}', targets), null, 'au milieu de la barre')
})
