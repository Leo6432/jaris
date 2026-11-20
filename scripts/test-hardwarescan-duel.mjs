import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { promisify } from 'node:util'
import ts from 'typescript'
import { withI18n } from './i18n-test-module.mjs'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Étape 355 (Léo : « on vote, à la place d'Artificial Analysis »), puis étape 358 (« fais comme Arena, au début tous
 * les modèles vont être à 0 ») : sur les VRAIS scores du dépôt et une machine comme celle de Léo (8 Go, 32 Go), seuls
 * les votes des duels donnent leur force aux modèles de Faible, Moyen, Élevé et Code — 0 point pour tous sans vote.
 * La source des votes est branchée comme dans main.ts, avec le vrai classement.
 */
const nodeRequire = createRequire(import.meta.url)
const source = ts.transpileModule(readFileSync(new URL('../electron/services/hardwareScan.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const REAL_SCORES = readFileSync(new URL('./verified-tool-scores.md', import.meta.url), 'utf8')
const duel = loadTsModule('shared/duel.ts')

const LARGE = 'qwen3.8:27b'
const CHALLENGER = 'qwen3.6:27b'
const K2_7B = 'hf.co/IFM/K2-Horizon-7B-GGUF:Q4_K_M'
// Étape 471 : le Moyen de Léo avec la mémoire réelle à 16 384 (K2 Horizon 7B, 8,3 Go chargé, ne tient plus sur 8 Go).
const K2_37B = 'hf.co/IFM/K2-Horizon-3.7B-GGUF:Q4_K_M'

function setup(votes, { vramMib = 8 * 1024, ramGb = 32 } = {}) {
  const exec = (_cmd, opts, cb) => (typeof opts === 'function' ? opts : cb)(null, `Fake GPU, ${vramMib}\n`, '')
  exec[promisify.custom] = () => Promise.resolve({ stdout: `Fake GPU, ${vramMib}\n`, stderr: '' })
  const modules = {
    child_process: { exec },
    fs: {
      readFileSync: (path) => {
        if (String(path).includes('verified-tool-scores.md')) return REAL_SCORES
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
  vm.runInNewContext(source, { exports, module: { exports }, require: withI18n((name) => modules[name] ?? nodeRequire(name)) })
  exports.setOllamaVersionSource(() => '0.40.10')
  // Comme main.ts (étape 504) : un rôle lit les votes de SON groupe — Moyen et Élevé : Discussion ET Agentique.
  if (votes) exports.setDuelStrengthSource((pool) => duel.rankDuels(votes.filter((v) => duel.inDuelPool(v.category, pool))))
  exports.setDuelProbability((pool, c, i) => (votes ? duel.switchProbability(votes.filter((v) => duel.inDuelPool(v.category, pool)), c, i) : null))
  return exports
}

let nextId = 0
const wins = (n, winner, loser, category) =>
  Array.from({ length: n }, () => ({ id: `v${nextId++}`, category, at: nextId, sessionId: 's', modelA: winner, modelB: loser, outcome: 'a', prompt: '' }))

test('sans vote (étape 358) : tous à 0 point, le choix ne dépend plus d’Artificial Analysis mais de la fiabilité', async () => {
  const none = await setup(null).pickBestModelsFromBenchmark()
  const empty = await setup([]).pickBestModelsFromBenchmark()
  assert.deepEqual(JSON.parse(JSON.stringify(empty)), JSON.parse(JSON.stringify(none)))
  // Machine de Léo, avec les vrais scores : ce que Jaris choisit quand personne n'a encore voté (calculé, pas deviné).
  // Étape 471 : avec la mémoire réelle à 16 384, granite4.2:8b (8,3 Go chargé) ne tient plus sur les 7 Go utiles.
  // Étape 497 : LFM3 1.7B dépasse qwen3.5:4b — mais il exige Ollama 0.40.13 (étape 501) et ce test simule 0.40.10, comme
  // chez Léo : il n'est jamais choisi (sans vitesse mesurée, Faible = le meilleur des « petits », LFM2.5).
  // Étape 498 : à note égale (78/78, 48/48), qwen3.6:27b passe devant qwen3.5:27b — l'Intelligence Index d'Artificial
  // Analysis ne départage plus (retiré) ; étape 499 : MMLU-Pro non plus — le plus gros.
  assert.deepEqual(JSON.parse(JSON.stringify(none.models)), { flash: 'hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M', medium: 'qwen3.5:4b', large: 'qwen3.6:27b' })
  assert.equal(none.codeModel, 'ornith-1.5:35b')
  // Étape 475 : Vision a ses duels ; sans vote, sa fiabilité au test de vision départage (0 point pour tous).
  assert.equal(none.visionModel, LARGE)
  assert.equal(none.voiceModels, undefined, 'la voix et le Chat partagent leurs modèles')
})

test('Discussion : sans modèle en service, les votes décident tout de suite (la voix utilise les modèles du Chat)', async () => {
  const picks = await setup(wins(8, LARGE, 'qwen3.5:27b', 'conversation')).pickBestModelsFromBenchmark()
  assert.equal(picks.models.large, LARGE)
  assert.equal(picks.voiceModels, undefined, 'étape 504 : plus de modèles « Vocal » à part')
  // Le Code, lui, n'est pas concerné par des votes de Conversation.
  assert.equal(picks.codeModel, 'ornith-1.5:35b')
})

test('modèle en service (étape 360) : remplacé seulement s’il est PROUVÉ meilleur (5 duels, plus de 95 %, note devant)', async () => {
  const inService = { models: { flash: 'granite4.2:8b', medium: 'granite4.2:8b', large: 'qwen3.5:27b' }, codeModel: 'ornith-1.5:35b' }
  const pick = async (votes) => (await setup(votes).pickBestModelsFromBenchmark(new Set(), inService)).models.large
  // Aucun vote : le modèle en service reste (il est déjà le meilleur choix).
  assert.equal(await pick([]), 'qwen3.5:27b')
  // Trois victoires : devant, mais pas prouvé — rien ne change.
  assert.equal(await pick(wins(3, LARGE, 'qwen3.5:27b', 'conversation')), 'qwen3.5:27b')
  // Victoires et défaites presque égales : jamais un changement entre deux modèles presque équivalents.
  assert.equal(await pick([...wins(7, LARGE, 'qwen3.5:27b', 'conversation'), ...wins(6, 'qwen3.5:27b', LARGE, 'conversation')]), 'qwen3.5:27b')
  // Neuf duels, devant (7 victoires, 2 défaites) mais 90 % seulement (étape 361) : pas assez sûr, le modèle reste.
  assert.equal(await pick([...wins(7, LARGE, 'qwen3.5:27b', 'conversation'), ...wins(2, 'qwen3.5:27b', LARGE, 'conversation')]), 'qwen3.5:27b')
  // Étape 361, a priori prudent de 150 points : 5 sur 5 donne 93,7 % (gardé), 6 sur 6 donne 95,9 % (remplacé).
  assert.equal(await pick(wins(5, LARGE, 'qwen3.5:27b', 'conversation')), 'qwen3.5:27b')
  assert.equal(await pick(wins(6, LARGE, 'qwen3.5:27b', 'conversation')), LARGE)
  // 5 victoires et 3 égalités : 91 %, gardé (une égalité n'est pas une preuve).
  const ties = Array.from({ length: 3 }, () => ({ ...wins(1, LARGE, 'qwen3.5:27b', 'conversation')[0], outcome: 'tie' }))
  assert.equal(await pick([...wins(5, LARGE, 'qwen3.5:27b', 'conversation'), ...ties]), 'qwen3.5:27b')
  // Assez de victoires : prouvé, le modèle change.
  assert.equal(await pick(wins(8, LARGE, 'qwen3.5:27b', 'conversation')), LARGE)
  // Le même modèle en service pour le Code : des victoires Code tout juste ne suffisent pas non plus.
  const code = async (n) => (await setup(wins(n, LARGE, 'ornith-1.5:35b', 'code')).pickBestModelsFromBenchmark(new Set(), inService)).codeModel
  assert.equal(await code(3), 'ornith-1.5:35b')
  assert.equal(await code(8), LARGE)
})

test('étape 504 : modèle en service, Agentique — la preuve se calcule sur Discussion ET Agentique ensemble', async () => {
  const inService = { models: { flash: 'granite4.2:8b', medium: 'granite4.2:8b', large: 'qwen3.5:27b' }, codeModel: 'ornith-1.5:35b' }
  const pick = async (votes) => (await setup(votes).pickBestModelsFromBenchmark(new Set(), inService)).models.large
  // 8 victoires Agentique : prouvé pour Élevé, comme 8 victoires Discussion.
  assert.equal(await pick(wins(8, LARGE, 'qwen3.5:27b', 'agent')), LARGE)
  // 4 + 4 : aucune des deux catégories seule ne prouve rien, ensemble elles prouvent.
  assert.equal(await pick(wins(4, LARGE, 'qwen3.5:27b', 'agent')), 'qwen3.5:27b')
  assert.equal(await pick([...wins(4, LARGE, 'qwen3.5:27b', 'agent'), ...wins(4, LARGE, 'qwen3.5:27b', 'conversation')]), LARGE)
  // Des votes Code ne comptent jamais pour Élevé.
  assert.equal(await pick(wins(8, LARGE, 'qwen3.5:27b', 'code')), 'qwen3.5:27b')
})

test('modèle en service : moins de 5 duels ne suffit jamais, même avec une probabilité donnée à 99 %', async () => {
  const m = setup(wins(4, LARGE, 'qwen3.5:27b', 'conversation'))
  m.setDuelProbability(() => 0.99)
  const inService = { models: { flash: 'granite4.2:8b', medium: 'granite4.2:8b', large: 'qwen3.5:27b' }, codeModel: 'ornith-1.5:35b' }
  assert.equal((await m.pickBestModelsFromBenchmark(new Set(), inService)).models.large, 'qwen3.5:27b')
})

test('modèle en service : prouvé meilleur en duel mais à peine devant une fois la fiabilité comptée, il reste', async () => {
  // Force donnée à la main : on cherche la plus petite force de qwen3.8:27b qui le fait choisir sans modèle en service.
  const m = setup(null)
  m.setDuelProbability(() => 0.99)
  const withStrength = (x) =>
    m.setDuelStrengthSource((pool) => new Map(pool === 'actions' ? [[LARGE, { strength: x, duels: 20 }], [CHALLENGER, { strength: 1, duels: 20 }]] : []))
  let threshold = null
  for (let x = 1; x <= 4 && threshold === null; x += 0.01) {
    withStrength(x)
    if ((await m.pickBestModelsFromBenchmark()).models.large === LARGE) threshold = x
  }
  assert.ok(threshold !== null)
  // Juste au-dessus : choisi d'emblée, mais il ne remplace pas le modèle en service (gain de moins de 5 %).
  withStrength(threshold * 1.02)
  const inService = { models: { flash: 'granite4.2:8b', medium: 'granite4.2:8b', large: CHALLENGER }, codeModel: 'ornith-1.5:35b' }
  assert.equal((await m.pickBestModelsFromBenchmark()).models.large, LARGE)
  assert.equal((await m.pickBestModelsFromBenchmark(new Set(), inService)).models.large, CHALLENGER)
  // Nettement devant : il le remplace.
  withStrength(threshold * 1.2)
  assert.equal((await m.pickBestModelsFromBenchmark(new Set(), inService)).models.large, LARGE)
})

test('modèle en service : sans la probabilité branchée, rien n’est jamais remplacé', async () => {
  const m = setup(wins(20, LARGE, 'qwen3.5:27b', 'conversation'))
  m.setDuelProbability(null)
  const inService = { models: { flash: 'granite4.2:8b', medium: 'granite4.2:8b', large: 'qwen3.5:27b' }, codeModel: 'ornith-1.5:35b' }
  assert.equal((await m.pickBestModelsFromBenchmark(new Set(), inService)).models.large, 'qwen3.5:27b')
})

// Étape 504 (Léo : « Discussion plus Agentique ») : Faible répond vite à des demandes simples — seuls les votes
// Discussion le choisissent ; Moyen et Élevé font les vraies tâches — votes Discussion ET Agentique.
test('étape 504 : les votes Agentique choisissent Moyen et Élevé, jamais Faible', async () => {
  const LFM = 'hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M'
  const none = (await setup([]).pickBestModelsFromBenchmark()).models
  assert.equal(none.flash, LFM)
  // Agentique : K2 Horizon 3.7B bat qwen3.5:4b — Moyen et Élevé changent, Faible ne bouge pas.
  const agent = (await setup(wins(8, K2_37B, 'qwen3.5:4b', 'agent')).pickBestModelsFromBenchmark()).models
  assert.deepEqual([agent.flash, agent.medium, agent.large], [LFM, K2_37B, K2_37B])
  // Faible : des défaites de LFM2.5 en Agentique ne le touchent pas ; les mêmes en Discussion, si.
  assert.equal((await setup(wins(8, 'qwen3.5:4b', LFM, 'agent')).pickBestModelsFromBenchmark()).models.flash, LFM)
  assert.notEqual((await setup(wins(8, 'qwen3.5:4b', LFM, 'conversation')).pickBestModelsFromBenchmark()).models.flash, LFM)
})

test('Code : les votes Code décident du modèle Code, pas des rôles de conversation', async () => {
  const picks = await setup(wins(8, LARGE, 'ornith-1.5:35b', 'code')).pickBestModelsFromBenchmark()
  assert.equal(picks.codeModel, LARGE)
  assert.equal(picks.models.large, 'qwen3.6:27b', 'les rôles de conversation ne bougent pas')
})

// Étape 475 (Léo : « ajoute un Duel Vision ») : les votes Vision décident du modèle Vision, et de lui seul.
test('étape 475 : les votes Vision choisissent le modèle Vision ; seuls les modèles qui lisent une image y entrent', async () => {
  const VL = 'qwen3-vl:4b'
  const voted = await setup(wins(8, VL, LARGE, 'vision')).pickBestModelsFromBenchmark()
  assert.equal(voted.visionModel, VL, '8 victoires en Vision : il prend le rôle Vision')
  assert.equal(voted.models.large, 'qwen3.6:27b', 'les rôles de conversation ne bougent pas')
  // Des votes d'une AUTRE catégorie ne touchent pas à la Vision.
  assert.equal((await setup(wins(8, VL, LARGE, 'conversation')).pickBestModelsFromBenchmark()).visionModel, LARGE)
  // Le Duel Vision ne met face à face que des modèles qui lisent une image.
  const m = setup([])
  const readers = new Set((await m.getModelOverview()).entries.filter((e) => e.readsImages).map((e) => e.model))
  const candidates = await m.getDuelCandidates('vision', { visionModel: LARGE })
  assert.ok(candidates.length >= 4, `assez de modèles pour une session (${candidates.length})`)
  for (const c of candidates) assert.ok(readers.has(c.model), `${c.model} ne lit pas les images`)
  assert.equal(candidates.find((c) => c.model === LARGE)?.inUse, true, 'le modèle Vision en service est marqué')
  assert.ok((await m.getDuelModelList('vision')).every((o) => readers.has(o.model)), 'la liste à cocher aussi')
})

test('le calcul affiché dit d’où vient la note : les duels (points et nombre de votes), 0 point sans vote', async () => {
  const m = setup([...wins(8, CHALLENGER, LARGE, 'conversation'), ...wins(9, CHALLENGER, LARGE, 'agent')])
  const profile = {
    models: { flash: 'granite4.2:8b', medium: K2_7B, large: CHALLENGER },
    visionModel: LARGE,
    codeModel: LARGE
  }
  const picks = await m.getMyModelPicks(profile)
  assert.equal(picks.large.note.base.kind, 'duel')
  // Étape 504 : Élevé compte ses duels Discussion (8) ET Agentique (9).
  assert.equal(picks.large.note.base.duels, 17)
  assert.ok(picks.large.note.base.points > 0)
  assert.equal('omniscienceShare' in picks.large.note, false, 'étape 498 : plus de part « n’invente pas » (Artificial Analysis)')
  assert.equal('voice' in picks, false, 'étape 504 : plus de lignes « voix » à part')
  // Jamais en duel : 0 point, force 1 — plus d'Artificial Analysis ni de Terminal-Bench pour ces rôles.
  assert.deepEqual([picks.medium.note.base.kind, picks.medium.note.base.value, picks.medium.note.base.points], ['duel', 1, 0])
  assert.deepEqual([picks.code.note.base.kind, picks.code.note.base.duels], ['duel', 0])
  // Étape 475 : Vision a désormais ses duels — sans vote Vision, 0 point aussi (plus d'Artificial Analysis).
  assert.deepEqual([picks.vision.note.base.kind, picks.vision.note.base.duels, picks.vision.note.base.points], ['duel', 0, 0])
  // Le produit des parts affichées fait toujours la note.
  const note = picks.large.note
  assert.ok(Math.abs(note.base.value * note.toolsShare * (note.demandsShare ?? 1) - note.total) < 1e-9)
})

test('candidats d’une session : ceux qui tiennent sur CE PC, Ollama capable, quel que soit le test d’outils, et les deux groupes', async () => {
  const m = setup([])
  const profile = { models: { flash: 'granite4.2:3b', medium: K2_37B, large: LARGE }, codeModel: LARGE, blockedModels: { 'gemma4:e4b': 'bloqué' } }
  const candidates = await m.getDuelCandidates('conversation', profile)
  const byModel = new Map(candidates.map((c) => [c.model, c]))
  assert.ok(candidates.length >= 8)
  // Étape 471 : « tient » se juge sur la mémoire réelle chargée (contexte 16 384), celle de « Tous les modèles » ;
  // `vramGb` d'un candidat reste la taille du fichier (téléchargement).
  const memory = new Map((await m.getModelOverview()).entries.map((e) => [e.model, e.vramGb]))
  for (const c of candidates) {
    const need = memory.get(c.model)
    assert.ok(c.group === 'card' ? need <= 7 : c.group === 'ram' && need > 7, `${c.model} : groupe ${c.group} pour ${need} Go`)
    assert.ok(need <= 7 + (32 - 16), `${c.model} ne tient pas sur ce PC`)
  }
  assert.equal(byModel.has(K2_7B), false, 'K2 Horizon 7B (8,3 Go chargé) ne tient pas sur la carte et ne peut pas déborder')
  assert.equal(byModel.get(LARGE).inUse, true)
  assert.equal(byModel.get(K2_37B).inUse, true)
  assert.equal(byModel.has('gemma4:e4b'), false, 'un modèle bloqué au téléchargement n’est jamais proposé')
  // Étape 376 : le test d'appel d'outils ne filtre plus les duels — un score faible (phi4-mini, 7/78) ou aucun score
  // de conversation (un modèle de code) n'empêche pas d'entrer en duel.
  assert.ok(byModel.has('phi4-mini'), 'phi4-mini (7/78) entre en duel')
  assert.ok(byModel.has('qwen2.5-coder:7b'), 'un modèle de code sans score de conversation entre en duel')
  // Une version d'Ollama trop ancienne écarte les modèles qu'elle ne sait pas charger (K2 Horizon, étape 312).
  m.setOllamaVersionSource(() => '0.40.3')
  assert.equal((await m.getDuelCandidates('conversation', profile)).some((c) => c.model.includes('K2-Horizon')), false)
  // Code : un seul groupe, et c'est le modèle Code qui est « utilisé ».
  m.setOllamaVersionSource(() => '0.40.10')
  const code = await m.getDuelCandidates('code', profile)
  assert.ok(code.every((c) => c.group === 'code'))
  // (une chaîne : les tableaux d'un vm.runInNewContext ne sont jamais deepEqual à ceux du test, piège de l'étape 32)
  assert.equal(code.filter((c) => c.inUse).map((c) => c.model).join(), LARGE)
})

test('une session sur la machine de Léo : les modèles déjà utilisés, puis un challenger qui déborde et un qui tient sur la carte', async () => {
  const m = setup([])
  const profile = { models: { flash: 'granite4.2:3b', medium: K2_37B, large: LARGE }, codeModel: LARGE }
  const chosen = duel.selectDuelModels(await m.getDuelCandidates('conversation', profile), 5)
  assert.deepEqual(chosen.slice(0, 3).sort(), [K2_37B, 'granite4.2:3b', LARGE].sort())
  const sizes = new Map((await m.getModelOverview()).entries.map((e) => [e.model, e.vramGb]))
  assert.ok(sizes.get(chosen[3]) > 7 !== sizes.get(chosen[4]) > 7, `un gros et un petit challenger : ${chosen.slice(3)}`)
})

test('main.ts branche la source des votes, et le classement de l’écran est celui du choix (tous partent de 0)', () => {
  const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8')
  // Étape 504 : par GROUPE de votes (Moyen et Élevé : Discussion + Agentique), le même filtre que ce test.
  assert.match(main, /setDuelStrengthSource\(\(pool: DuelPool\) => \{/)
  assert.match(main, /rankDuels\(votes\.filter\(\(v\) => inDuelPool\(v\.category, pool\)\)\)/)
  assert.match(main, /setDuelProbability\(\(pool, challenger, incumbent\) => \{/)
  assert.match(main, /switchProbability\(votes\.filter\(\(v\) => inDuelPool\(v\.category, pool\)\), challenger, incumbent\)/)
  const session = readFileSync(new URL('../electron/services/duelSession.ts', import.meta.url), 'utf8')
  assert.match(session, /rankDuels\(votes\)/)
})

test('sans carte graphique détectée : les modèles tournent dans la RAM, le Duel a de quoi faire (petits et gros)', async () => {
  const m = setup([], { vramMib: 'x', ramGb: 32 })
  const candidates = await m.getDuelCandidates('conversation', null)
  assert.ok(candidates.length >= 10, `seulement ${candidates.length} modèles`)
  assert.ok(candidates.some((c) => c.group === 'card') && candidates.some((c) => c.group === 'ram'))
  const chosen = duel.selectDuelModels(candidates, 4)
  const sizes = new Map(candidates.map((c) => [c.model, c.vramGb]))
  assert.ok(chosen.some((model) => sizes.get(model) <= 6), `que des gros modèles : ${chosen}`)
  assert.deepEqual(JSON.parse(JSON.stringify(await m.duelMachine())), { vramGb: null, ramGb: 32 })
})

test('sans carte graphique et 16 Go de RAM (étape 357) : assez de petits modèles pour un duel', async () => {
  const m = setup([], { vramMib: 'x', ramGb: 16 })
  const candidates = await m.getDuelCandidates('conversation', null)
  assert.ok(candidates.length >= 4, `seulement ${candidates.length} modèles : ${candidates.map((c) => c.model)}`)
  assert.ok(candidates.every((c) => c.vramGb <= 16 - 6), 'jamais un modèle qui prendrait la RAM de Windows')
  assert.ok(duel.selectDuelModels(candidates, 4).length >= 2)
  for (const category of ['code', 'agent']) assert.ok((await m.getDuelCandidates(category, null)).length >= 2, category)
})

test('étape 363 : la liste à cocher montre TOUS les modèles de Jaris ; disponibles = exactement les candidats du hasard', async () => {
  const m = setup([])
  const profile = { models: { flash: 'granite4.2:8b', medium: K2_7B, large: LARGE }, codeModel: LARGE, blockedModels: { 'gemma4:e4b': 'bloqué' } }
  m.setOllamaVersionSource(() => '0.40.3')
  const list = await m.getDuelModelList('conversation', profile)
  const all = (await m.getModelOverview()).entries.map((e) => e.model)
  // Tous les modèles de Jaris, chacun une fois (une chaîne : piège des tableaux d'un autre contexte vm).
  assert.equal([...new Set(list.map((o) => o.model))].sort().join(), [...new Set(all)].sort().join())
  const candidates = await m.getDuelCandidates('conversation', profile)
  assert.equal(list.filter((o) => o.reason === null).map((o) => o.model).sort().join(), candidates.map((c) => c.model).sort().join())
  // Disponibles d'abord : aucun modèle grisé avant un modèle disponible.
  const firstGrey = list.findIndex((o) => o.reason !== null)
  assert.ok(firstGrey > 0 && list.slice(firstGrey).every((o) => o.reason !== null))
  const reason = (model) => list.find((o) => o.model === model)?.reason
  assert.equal(reason('gemma4:e4b').kind, 'blocked')
  const k2 = list.find((o) => o.model.includes('K2-Horizon'))
  assert.equal(k2.reason.kind, 'ollama')
  assert.match(k2.reason.version, /^0\.40\.\d+$/)
  const big = list.find((o) => o.reason?.kind === 'tooBig')
  assert.ok(big && big.reason.needGb > big.reason.budgetGb, 'un modèle trop gros dit combien il lui faut')
  // Étape 376 : ni un score d'appel d'outils faible ni l'absence de test n'empêchent un duel.
  const reasons = new Set(list.map((o) => o.reason?.kind).filter(Boolean))
  assert.ok(!reasons.has('tools') && !reasons.has('untested'), [...reasons].join())
  assert.equal(reason('phi4-mini'), null, 'phi4-mini (7/78) entre en duel')
  assert.equal(reason('qwen2.5-coder:7b'), null, 'un modèle de code sans score de conversation entre en duel Conversation')
  m.setOllamaVersionSource(() => '0.40.10')
})

test('étape 377 : les modèles sur une autre machine (B300 louée) — SA carte, SA RAM, SON Ollama, jamais ceux de ce PC', async () => {
  // Ce PC : 8 Go, 32 Go. L'autre machine : 288 Go de carte, 188 Go de RAM, Ollama récent.
  const scan = setup(null)
  const away = { vramGb: 288, ramGb: 188, ollamaVersion: '0.40.10' }
  const here = await scan.getDuelModelList('conversation', null)
  const there = await scan.getDuelModelList('conversation', null, away)
  assert.ok(here.some((m) => m.reason?.kind === 'tooBig'), 'sur ce PC, des modèles sont trop gros')
  assert.ok(!there.some((m) => m.reason?.kind === 'tooBig'), 'sur la B300, tout tient')
  assert.deepEqual(JSON.parse(JSON.stringify(await scan.duelMachine(away))), { vramGb: 288, ramGb: 188 })
  // Un modèle qui exige un Ollama récent dépend de la version de L'AUTRE machine (inconnue = prudence).
  const old = await scan.getDuelModelList('conversation', null, { ...away, ollamaVersion: null })
  assert.ok(old.some((m) => m.reason?.kind === 'ollama'))
  // Un téléchargement bloqué sur CE PC ne bloque rien là-bas.
  const blockedModel = there[0].model
  const blocked = await scan.getDuelModelList('conversation', { name: 'Léo', blockedModels: { [blockedModel]: 'x' } }, away)
  assert.equal(blocked.find((m) => m.model === blockedModel).reason, null)
  // Une autre machine sans carte : c'est SA RAM qui compte (20 Go là-bas, 32 Go sur ce PC).
  const cardless = await scan.getDuelModelList('conversation', null, { vramGb: null, ramGb: 20, ollamaVersion: '0.40.10' })
  assert.ok(cardless.some((m) => m.reason?.kind === 'tooBig' && m.reason.budgetGb === 14))
  const candidates = await scan.getDuelCandidates('conversation', null, away)
  assert.equal(candidates.length, there.filter((m) => m.reason === null).length)
})

// Étape 485 (capture de Léo : colonne « Duels Vision » du tableau des modèles vide malgré 12 votes Vision).
test('étape 485 : le tableau des modèles montre les points de duel Vision, comme les autres catégories', async () => {
  const votes = [...wins(3, 'qwen3.5:4b', 'qwen3-vl:4b', 'vision'), ...wins(2, 'qwen3.5:4b', 'qwen3-vl:4b', 'code')]
  const entries = new Map((await setup(votes).getModelOverview()).entries.map((e) => [e.model, e]))
  const winner = entries.get('qwen3.5:4b')
  const loser = entries.get('qwen3-vl:4b')
  assert.equal(winner.duels.vision.duels, 3)
  assert.ok(winner.duels.vision.points > 0, 'gagnant : points positifs')
  assert.ok(loser.duels.vision.points < 0, 'perdant : points négatifs')
  assert.equal(winner.duels.code.duels, 2, 'les autres catégories ne changent pas')
  assert.equal(entries.get('granite4.2:8b')?.duels?.vision, undefined, 'sans duel Vision : rien (« – » à l’écran)')
})

// Étape 486 (Léo : « mets en bas tous les duels de Code, tous les duels de Vision, et tous les duels en tout »).
test('étape 486 : le nombre de duels votés par catégorie — chaque duel compté une fois, pas deux', async () => {
  const votes = [...wins(3, 'qwen3.5:4b', 'qwen3-vl:4b', 'vision'), ...wins(2, 'qwen3.5:4b', 'gemma4:e4b', 'code'), ...wins(1, 'gemma4:e4b', 'qwen3.5:4b', 'code')]
  // Copie JSON : l'objet vient d'un autre contexte (vm), que deepEqual ne compare pas directement.
  const plain = async (v) => JSON.parse(JSON.stringify((await setup(v).getModelOverview()).duelTotals))
  assert.deepEqual(await plain(votes), { conversation: 0, agent: 0, code: 3, vision: 3 })
  assert.deepEqual(await plain([]), { conversation: 0, agent: 0, code: 0, vision: 0 })
})
