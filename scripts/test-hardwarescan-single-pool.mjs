import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { promisify } from 'node:util'
import ts from 'typescript'

/**
 * Étape 160, Léo : « que tous les modèles soient au même endroit, pas des modèles code, pas des modèles
 * rapide : Jaris choisit le plus rapide dans tous les modèles, le meilleur pour le code — ça peut être des
 * modèles puissants ». Déclencheur : le modèle Code (qwen3.6:35b-a3b, Intelligence 18) était moins fort que le
 * Puissant (qwen3.8:27b, 34), parce que chaque rôle ne cherchait que dans sa propre liste.
 *
 * Tests sur les VRAIS scores du dépôt (scripts/verified-tool-scores.md), pas sur des scores inventés : ce qui
 * est vérifié ici, c'est ce que Jaris choisira réellement pour une machine donnée.
 */
const nodeRequire = createRequire(import.meta.url)
const source = ts.transpileModule(readFileSync(new URL('../electron/services/hardwareScan.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const REAL_SCORES = readFileSync(new URL('./verified-tool-scores.md', import.meta.url), 'utf8')

function setup({ vramMib, ramGb = 32, scores = REAL_SCORES } = {}) {
  // Marque [util.promisify.custom] indispensable (voir test-hardwarescan-tiebreak.mjs) : sans elle, detectGpu()
  // ignorerait silencieusement la VRAM simulée.
  const exec = (_cmd, opts, cb) => (typeof opts === 'function' ? opts : cb)(null, `Fake GPU, ${vramMib}\n`, '')
  exec[promisify.custom] = () => Promise.resolve({ stdout: `Fake GPU, ${vramMib}\n`, stderr: '' })
  const modules = {
    child_process: { exec },
    fs: {
      readFileSync: (path) => {
        if (String(path).includes('verified-tool-scores.md')) return scores
        const err = new Error('ENOENT')
        err.code = 'ENOENT'
        throw err
      }
    },
    '../paths': { resourcesRoot: () => '/fake/resources' },
    './dataLocation': { getDataRoot: () => '/fake/data' },
    './systemResources': { RESOURCE_SAFETY_MARGIN_GB: 16, detectRamGb: () => ramGb },
    './ollama': { getModelInfo: async () => null, getInstalledModelSizeBytes: async () => null, listInstalledModels: async () => [] }
  }
  const exports = {}
  vm.runInNewContext(source, { exports, module: { exports }, require: (name) => modules[name] ?? nodeRequire(name) })
  return exports
}

async function picksFor(vramGb, ramGb) {
  const r = await setup({ vramMib: vramGb * 1024, ramGb }).pickBestModelsFromBenchmark()
  return { ...r.models, vision: r.visionModel, code: r.codeModel }
}

test('machine de Léo (8 Go de VRAM) : Code prend le plus intelligent de TOUS les modèles, comme Puissant', async () => {
  const picks = await picksFor(8, 32)
  // Test version 6 (03/10/2026) : qwen3.8:27b (77/78, Intelligence 33,7) bat qwen3.5:27b (78/78) — une réponse
  // d'écart sur 78 est une égalité (TOOL_SCORE_TOLERANCE), l'intelligence départage.
  assert.equal(picks.large, 'qwen3.8:27b')
  // Avant l'étape 160 : qwen3.6:35b-a3b (Intelligence 18), le seul choix possible dans la liste « code ».
  assert.equal(picks.code, 'qwen3.8:27b', `Code attendu : le même que Puissant, obtenu ${picks.code}`)
})

test('Rapide sur 8 Go, seuil de 50 % (Léo, 04/10/2026) : granite4.2:8b entre dans la course et l’emporte', async () => {
  const picks = await picksFor(8, 32)
  // Référence : ministral-3:8b (100), le plus rapide des 78/78. À 75 %, seuls les 3B passaient (granite4.2:3b
  // gagnait) ; à 50 % (50 et plus), granite4.2:8b (62, intelligence 11,1) passe aussi et a la meilleure note.
  assert.equal(picks.flash, 'granite4.2:8b')
})

// 03/10/2026, Léo : « une vraie analyse, avec un algorithme qui sait faire un entre-deux entre intelligence et
// appel d'outils ». Les deux sens comptent : une erreur sur 78 ne doit pas écarter un modèle bien plus
// intelligent, mais un modèle peu fiable ne doit jamais gagner sur sa seule intelligence.
test('fiabilité et intelligence en balance : ni le score exact, ni l’intelligence seule', async () => {
  const md = (rows) => ['## Conversation', '| Modèle | Fiabilité |', '|---|---|', ...rows].join('\n')
  const pick = async (rows) => (await setup({ vramMib: 24 * 1024, ramGb: 64, scores: md(rows) }).pickBestModelsFromBenchmark()).models.large
  // 1 erreur sur 78 : qwen3.8:27b (33,7) bat qwen3.5:27b (22,9) parfait.
  assert.equal(await pick(['| qwen3.5:27b | 78/78 |', '| qwen3.8:27b | 77/78 |']), 'qwen3.8:27b')
  // 18 erreurs sur 78 : (60/78)^5 = 0,27, sa note tombe à 9 — le modèle parfait gagne.
  assert.equal(await pick(['| qwen3.5:27b | 78/78 |', '| qwen3.8:27b | 60/78 |']), 'qwen3.5:27b')
})

// Étape 241, Léo : faire compter les demandes complètes dans le choix (« tu les fusionnes ? »). Les deux tests sont
// multipliés : un modèle parfait aux 78 questions mais qui rate les vraies demandes perd sa place.
test('demandes complètes : multipliées à la note des rôles de conversation, jamais à Vision ni Code', async () => {
  const md = (conversation, demands = []) =>
    ['## Conversation', '| Modèle | Fiabilité |', '|---|---|', ...conversation, '## Demandes complètes', '| Modèle | Réussite |', '|---|---|', ...demands].join('\n')
  const picks = async (scores) => {
    const r = await setup({ vramMib: 24 * 1024, ramGb: 64, scores }).pickBestModelsFromBenchmark()
    return { large: r.models.large, code: r.codeModel }
  }
  const both = ['| qwen3.5:27b | 78/78 |', '| qwen3.8:27b | 78/78 |']
  // Sans demandes complètes : le plus intelligent (qwen3.8:27b, 33,7 contre 22,9).
  assert.equal((await picks(md(both))).large, 'qwen3.8:27b')
  // qwen3.8:27b ne réussit que 10 demandes sur 48 : 33,7 × 0,21 = 7,0 contre 22,9 × 46/48 = 21,9.
  const failing = await picks(md(both, ['| qwen3.5:27b | 46/48 |', '| qwen3.8:27b | 10/48 |']))
  assert.equal(failing.large, 'qwen3.5:27b')
  assert.equal(failing.code, 'qwen3.8:27b', 'le rôle Code ne regarde pas les demandes complètes')
  // Un score d'un ANCIEN test de demandes (autre total) ne compte pas.
  assert.equal((await picks(md(both, ['| qwen3.5:27b | 46/48 |', '| qwen3.8:27b | 10/40 |']))).large, 'qwen3.8:27b')
  // Sans score de demandes, un modèle est estimé par son taux aux 78 questions, jamais compté parfait : 60/78 →
  // 33,7 × 0,27 × 0,77 = 7,0, battu par 22,9 × 17/48 = 8,1 (avec un ×1, il aurait gagné : 9,1).
  assert.equal((await picks(md(['| qwen3.5:27b | 78/78 |', '| qwen3.8:27b | 60/78 |'], ['| qwen3.5:27b | 17/48 |']))).large, 'qwen3.5:27b')
})

/**
 * Étape 161, Léo : « il ne faut pas le plus rapide sans regarder l'intelligence, par exemple un modèle qui a
 * 5 points d'intelligence en plus mais ne perd que 3 points de vitesse ». Exactement le cas de granite4.2:3b
 * face à ministral-3:3b (9 contre 5 d'intelligence, 218 contre 221 de vitesse), rendu fiable ici exprès.
 */
test('Rapide : un modèle nettement plus intelligent et à peine plus lent l’emporte sur le plus rapide', async () => {
  const scores = ['## Conversation', '| Modèle | Fiabilité |', '|---|---|', '| ministral-3:3b | 6/6 |', '| granite4.2:3b | 6/6 |', '| qwen3.5:9b | 6/6 |'].join('\n')
  const r = await setup({ vramMib: 8 * 1024, scores }).pickBestModelsFromBenchmark()
  assert.equal(r.models.flash, 'granite4.2:3b', '+4 d’intelligence pour -3 de vitesse : le plus intelligent doit gagner')
  // qwen3.5:9b (11 d'intelligence) est bien plus lent (56 contre 221) : il ne compte pas comme « rapide ».
  assert.notEqual(r.models.flash, 'qwen3.5:9b')
})

test('Rapide : un modèle plus intelligent mais bien plus lent ne passe JAMAIS devant', async () => {
  const scores = ['## Conversation', '| Modèle | Fiabilité |', '|---|---|', '| ministral-3:3b | 6/6 |', '| qwen3.5:9b | 6/6 |', '| granite4.2:8b | 6/6 |'].join('\n')
  const r = await setup({ vramMib: 8 * 1024, scores }).pickBestModelsFromBenchmark()
  assert.equal(r.models.flash, 'ministral-3:3b')
})

test('Rapide : la fiabilité passe avant tout, même devant un modèle plus rapide ET plus intelligent', async () => {
  const scores = ['## Conversation', '| Modèle | Fiabilité |', '|---|---|', '| ministral-3:3b | 6/6 |', '| granite4.2:3b | 5/6 |'].join('\n')
  const r = await setup({ vramMib: 8 * 1024, scores }).pickBestModelsFromBenchmark()
  assert.equal(r.models.flash, 'ministral-3:3b')
})

test('Rapide et Médium ne débordent JAMAIS sur la RAM, même avec beaucoup de RAM', async () => {
  const scan = setup({ vramMib: 8 * 1024, ramGb: 128 })
  const r = await scan.pickBestModelsFromBenchmark()
  const overview = await scan.getModelOverview()
  const vramOf = (m) => overview.entries.find((e) => e.model === m).vramGb
  assert.ok(vramOf(r.models.flash) <= 7, `Rapide ${r.models.flash} ne tient pas sur la carte`)
  assert.ok(vramOf(r.models.medium) <= 7, `Médium ${r.models.medium} ne tient pas sur la carte`)
  // Étape 166 : granite4.2:8b (17/17) passe devant qwen3.5:9b (16/17) — la fiabilité départage d'abord.
  assert.equal(r.models.medium, 'granite4.2:8b', 'Médium = le plus fiable, puis le plus intelligent, qui tient ENTIÈREMENT sur la carte')
})

test('Médium peut être un « gros » modèle quand la carte le permet (plus de liste réservée)', async () => {
  const picks = await picksFor(24, 64)
  assert.equal(picks.medium, 'qwen3.8:27b', `24 Go : le plus intelligent qui tient sur la carte, obtenu ${picks.medium}`)
})

test('Vision ne choisit QUE parmi les modèles qui lisent une image', async () => {
  const scan = setup({ vramMib: 24 * 1024, ramGb: 64 })
  const r = await scan.pickBestModelsFromBenchmark()
  const overview = await scan.getModelOverview()
  assert.equal(overview.entries.find((e) => e.model === r.visionModel)?.readsImages, true, `${r.visionModel} ne lit pas les images`)
})

test('un 3/3 au test de code vaut un 6/6 au test de conversation (comparés en proportion, pas en nombre brut)', async () => {
  // qwen3.6:35b-a3b a 3/3 au test de code ; en nombre brut, n'importe quel 6/6 l'aurait battu. Seul
  // qwen3.6:35b-a3b est donné ici avec un Intelligence Index plus haut qu'un modèle de conversation à 6/6 :
  // à fiabilité égale (100 % des deux côtés), l'intelligence doit trancher.
  const scores = ['## Conversation', '| Modèle | Fiabilité |', '|---|---|', '| qwen3.5:27b | 6/6 |', '## Code', '| Modèle | Fiabilité |', '|---|---|', '| qwen3.6:35b-a3b | 3/3 |'].join('\n')
  const r = await setup({ vramMib: 24 * 1024, ramGb: 64, scores }).pickBestModelsFromBenchmark()
  // qwen3.5:27b : Intelligence 23 ; qwen3.6:35b-a3b : 18. Même fiabilité (100 %) → le plus intelligent.
  assert.equal(r.codeModel, 'qwen3.5:27b')
  const onlyCode = ['## Code', '| Modèle | Fiabilité |', '|---|---|', '| qwen3.6:35b-a3b | 3/3 |', '| qwen2.5-coder:7b | 2/3 |'].join('\n')
  const r2 = await setup({ vramMib: 24 * 1024, ramGb: 64, scores: onlyCode }).pickBestModelsFromBenchmark()
  assert.equal(r2.codeModel, 'qwen3.6:35b-a3b', 'un 3/3 doit battre un 2/3')
})

test('repli en direct : le modèle choisi est gardé tant qu\'il tient dans la VRAM libre', () => {
  const { pickSafeModel } = setup({ vramMib: 8 * 1024 })
  const installed = ['ministral-3:3b', 'qwen3.5:9b', 'qwen3.5:4b']
  // Rapide (3 Go) tient dans 7 Go libres : jamais remplacé par un plus gros modèle installé (plus lent).
  assert.equal(pickSafeModel(7, installed, 'ministral-3:3b'), 'ministral-3:3b')
  // Médium (6,6 Go) ne tient plus dans 5 Go libres : le plus gros modèle de conversation installé qui tient.
  assert.equal(pickSafeModel(5, installed, 'qwen3.5:9b'), 'qwen3.5:4b')
})

test('« Tous les modèles » : chaque modèle une seule fois, avec son étiquette affichée', async () => {
  const overview = await setup({ vramMib: 8 * 1024 }).getModelOverview()
  const models = overview.entries.map((e) => e.model)
  assert.equal(new Set(models).size, models.length)
  assert.ok(overview.entries.every((e) => ['Rapide', 'Moyen', 'Puissant'].includes(e.category)))
  assert.equal(overview.groups, undefined, 'plus de groupes par palier')
})

// Étape 168 : la liste que teste le bouton « Tester les modèles ». Étape 230 : rôle par rôle, et un score de
// conversation de l'ANCIEN test (sur 17) compte comme à refaire.
test('modèles à tester : tous les modèles de conversation notés à l’ancien test, du plus léger au plus lourd', () => {
  const conversationModels = new Set(
    [...source.matchAll(/const (?:FLASH|MEDIUM|LARGE)_CANDIDATES[\s\S]*?\n\]/g)].flatMap((m) => [...m[0].matchAll(/model: '([^']+)'/g)].map((x) => x[1]))
  )
  const visionOnly = new Set([...source.match(/const VISION_CANDIDATES[\s\S]*?\n\]/)[0].matchAll(/model: '([^']+)'/g)].map((x) => x[1]))
  const codeOnly = new Set([...source.match(/const CODE_CANDIDATES[\s\S]*?\n\]/)[0].matchAll(/model: '([^']+)'/g)].map((x) => x[1]))
  // Scores du dépôt après la campagne de Léo (05/10/2026) puis le test de vision version 4 : tout est noté.
  assert.equal(setup({ vramMib: 8 * 1024 }).getUnscoredModels().length, 0)
  // Sans ces trois nouvelles épreuves (vision, code, demandes complètes), tout repasse.
  const before = REAL_SCORES.replace(/## Vision[\s\S]*$/, '')
  assert.deepEqual(new Set(setup({ vramMib: 8 * 1024, scores: before }).getUnscoredModels()), new Set([...conversationModels, ...visionOnly, ...codeOnly]))
  // Une fois les trois nouvelles épreuves notées, plus rien à tester.
  const table = (heading, models, score) => `\n\n## ${heading}\n\n| Modèle | Score |\n|---|---|\n${[...models].map((m) => `| ${m} | ${score} |`).join('\n')}\n`
  const allNew =
    REAL_SCORES.replace(/## Vision[\s\S]*$/, '') +
    table('Vision — compréhension', visionOnly, '30/34') +
    table('Code — génération', codeOnly, '4/5') +
    table('Demandes complètes', conversationModels, '40/48')
  assert.deepEqual([...setup({ vramMib: 8 * 1024, scores: allNew }).getUnscoredModels()], [])
  // Avec les scores de l'ancien test (sur 17 et sur 3), tout repasse.
  const old = before.replace(/\| (\d+)\/78 \|/g, '| 16/17 |').replace(/\| (\d+)\/18 \|/g, '| 3/3 |')
  const unscored = [...setup({ vramMib: 8 * 1024, scores: old }).getUnscoredModels()]
  assert.equal(conversationModels.size, 30)
  for (const model of conversationModels) assert.ok(unscored.includes(model), `${model} doit repasser le nouveau test`)
  // Étape 230 : le test de vision a changé aussi (6 images × 3, l'ancien était sur 3) — chaque candidat Vision
  // repasse, y compris ceux qui ne servent qu'à la vision (qwen3-vl, GLM-4.6V, gemma4:31b).
  const visionModels = new Set([...source.match(/const VISION_CANDIDATES[\s\S]*?\n\]/)[0].matchAll(/model: '([^']+)'/g)].map((x) => x[1]))
  for (const model of visionModels) assert.ok(unscored.includes(model), `${model} doit repasser le test de vision`)
  // Étape 232 : le test de code a changé aussi (sur 5) — les modèles de code seuls repassent eux aussi.
  assert.equal(unscored.length, new Set([...conversationModels, ...visionModels, ...codeOnly]).size)
})

test('un score de conversation du test actuel (sur 78) dispense du test ; vision et code, rôle par rôle', () => {
  const lines = [
    '## Conversation', '', '| Modèle | Fiabilité |', '|---|---|', '| ministral-3:3b | 70/78 |', '| qwen3:1.7b | 16/17 |', '',
    // Étape 232 : les deux épreuves de conversation comptent.
    '## Demandes complètes', '', '| Modèle | Réussite |', '|---|---|', '| ministral-3:3b | 40/48 |', '| qwen3:1.7b | 40/48 |'
  ]
  const unscored = [...setup({ vramMib: 8 * 1024, scores: lines.join('\n') }).getUnscoredModels()]
  assert.ok(!unscored.includes('ministral-3:3b'), 'score du test actuel : rien à refaire')
  assert.ok(unscored.includes('qwen3:1.7b'), 'score de l’ancien test : à refaire')
  // Sans score de vision, un candidat Vision est à tester même s'il a un score de conversation.
  assert.ok(unscored.includes('qwen3-vl:2b'))
})

// Léo, 04/10/2026 : Rapide 50 %, Médium 20 %, les autres sans minimum. Référence de vitesse : le plus rapide parmi
// les meilleurs aux outils (ici granite4.2:3b, 221) ; plancher de Médium : 44.
test('Médium : les modèles vraiment lents sont écartés (moins de 20 %), Puissant n’a pas de minimum', async () => {
  const scores = ['## Conversation', '| Modèle | Fiabilité |', '|---|---|', '| granite4.2:3b | 78/78 |', '| qwen3.5:4b | 78/78 |'].join('\n')
  const r = await setup({ vramMib: 8 * 1024, scores }).pickBestModelsFromBenchmark()
  // qwen3.5:4b est plus intelligent (13,1 contre 9,1) mais à 22, sous le plancher de 44.
  assert.equal(r.models.medium, 'granite4.2:3b')
  assert.equal(r.models.large, 'qwen3.5:4b')
})

test('Médium : un modèle sans vitesse publiée reste candidat (choix de Léo), contrairement à Rapide', async () => {
  const scores = ['## Conversation', '| Modèle | Fiabilité |', '|---|---|', '| ministral-3:3b | 78/78 |', '| granite4.1:8b | 78/78 |'].join('\n')
  const r = await setup({ vramMib: 8 * 1024, scores }).pickBestModelsFromBenchmark()
  // granite4.1:8b (6,6, aucune vitesse publiée) bat ministral-3:3b (4,8) en Médium, mais ne peut pas être Rapide.
  assert.equal(r.models.medium, 'granite4.1:8b')
  assert.equal(r.models.flash, 'ministral-3:3b')
})

// Léo, 05/10/2026 : « fais-moi le bouton test, pour que je teste les derniers modèles ». Après une campagne, le
// bouton ne propose que ce qui reste à faire d'après le fichier brut — pas les 42 modèles dont les scores ne sont
// pas encore recopiés.
test('modèles à tester après une campagne : seulement les sautés, les délais dépassés et les plantages pas encore rejoués', () => {
  // Scores d'avant la campagne : ni demandes complètes ni code notés, c'est le fichier brut qui décide.
  const scan = setup({ vramMib: 8 * 1024, scores: REAL_SCORES.replace(/## Vision[\s\S]*$/, '') })
  const versions = { conversation: 6, demandes: scan.SCENARIO_TEST_VERSION, vision: scan.VISION_TEST_VERSION, code: scan.CODE_TEST_VERSION }
  const lines = [{ type: 'campagne', versions }]
  const demandes = (model, bad = {}) => {
    for (let i = 0; i < scan.SCENARIO_TEST_TOTAL; i++) lines.push({ type: 'demande', model, id: `d${i % 40}`, pass: i < 40 ? 1 : 2, ok: true, reason: null, ...(i === 0 ? bad : {}) })
  }
  const vision = (model, bad = {}) => {
    for (let i = 0; i < scan.VISION_TEST_TOTAL; i++) lines.push({ type: 'vision', model, kind: 'lecture', file: `f${i % 17}.png`, id: null, pass: i < 17 ? 1 : 2, ok: true, ...(i === 0 ? bad : {}) })
  }
  const code = (model, bad = {}) => {
    for (let i = 0; i < scan.CODE_TEST_TOTAL; i++) lines.push({ type: 'code', model, id: `c${i}`, ok: true, ...(i === 0 ? bad : {}) })
  }
  demandes('granite4.2:8b')
  demandes('granite4.2:30b', { ok: false, reason: 'erreur : délai dépassé', timeout: true })
  demandes('ministral-3:8b', { ok: false, reason: 'erreur : 500 invalid character' })
  vision('ministral-3:8b')
  demandes('qwen3.5:35b', { ok: false, reason: 'erreur : 500 XML' })
  // Plantage déjà rejoué une fois : la ligne de rejeu, qui a replanté, est la dernière — rien de plus à faire.
  lines.push({ type: 'demande', model: 'qwen3.5:35b', id: 'd0', pass: 1, ok: false, reason: 'erreur : 500 XML', replay: true })
  demandes('qwen3:1.7b', { ok: false, reason: 'faux : appel non prévu' })
  vision('gemma4:31b')
  code('qwen3-coder:30b')
  code('qwen2.5-coder:14b', { ok: false, reason: "erreur : Cannot read properties of undefined (reading 'map')" })
  // Une campagne d'une AUTRE version du test ne compte pas.
  lines.push({ type: 'campagne', versions: { ...versions, code: 999 } })
  code('qwen2.5-coder:7b')
  const done = scan.campaignCompletion(lines.map((l) => JSON.stringify(l)).join('\n'))
  assert.deepEqual([...done.scenarios].sort(), ['granite4.2:8b', 'qwen3.5:35b', 'qwen3:1.7b'])
  assert.deepEqual([...done.vision].sort(), ['gemma4:31b', 'ministral-3:8b'])
  assert.deepEqual([...done.code].sort(), ['qwen3-coder:30b'])
  const toTest = scan.getUnscoredModels(done)
  for (const model of ['granite4.2:30b', 'ministral-3:8b', 'qwen2.5-coder:14b', 'qwen2.5-coder:7b']) assert.ok(toTest.includes(model), `${model} reste à faire`)
  for (const model of ['granite4.2:8b', 'qwen3.5:35b', 'qwen3:1.7b', 'gemma4:31b', 'qwen3-coder:30b']) assert.ok(!toTest.includes(model), `${model} est fini`)
})

test('les versions de test connues de Jaris sont celles des scripts', async () => {
  const scan = setup({ vramMib: 8 * 1024 })
  const scenarios = readFileSync(new URL('./benchmark-scenarios.mjs', import.meta.url), 'utf8')
  const vision = readFileSync(new URL('./benchmark-vision.mjs', import.meta.url), 'utf8')
  const code = readFileSync(new URL('./benchmark-code.mjs', import.meta.url), 'utf8')
  assert.equal(Number(scenarios.match(/export const SCENARIO_TEST_VERSION = (\d+)/)[1]), scan.SCENARIO_TEST_VERSION)
  assert.equal(Number(vision.match(/export const VISION_TEST_VERSION = (\d+)/)[1]), scan.VISION_TEST_VERSION)
  assert.equal(Number(code.match(/export const CODE_TEST_VERSION = (\d+)/)[1]), scan.CODE_TEST_VERSION)
})
