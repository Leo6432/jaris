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
  if (votes) exports.setDuelStrengthSource((category) => duel.rankDuels(votes.filter((v) => v.category === category)))
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
  assert.deepEqual(JSON.parse(JSON.stringify(none.models)), { flash: 'granite4.2:8b', medium: 'granite4.2:8b', large: 'qwen3.5:27b' })
  assert.equal(none.codeModel, 'ornith-1.5:35b')
  assert.equal(none.visionModel, LARGE, 'Vision n’a pas de duel : elle garde Artificial Analysis')
  assert.equal(none.voiceModels, undefined, 'la voix et le Chat partagent leurs modèles')
})

test('Conversation : des victoires font passer un modèle devant une fois SÛR (étape 359), pour le Chat ET la voix', async () => {
  // Trois victoires de suite : pas encore sûr, rien ne change.
  assert.equal((await setup(wins(3, LARGE, 'qwen3.5:27b', 'conversation')).pickBestModelsFromBenchmark()).models.large, 'qwen3.5:27b')
  const picks = await setup(wins(8, LARGE, 'qwen3.5:27b', 'conversation')).pickBestModelsFromBenchmark()
  assert.equal(picks.models.large, LARGE)
  // La voix suit les votes Conversation tant qu'elle n'a pas les siens : rien ne la sépare du Chat.
  assert.equal(picks.voiceModels, undefined)
  // Le Code, lui, n'est pas concerné par des votes de Conversation.
  assert.equal(picks.codeModel, 'ornith-1.5:35b')
})

test('Vocal : ses propres votes séparent la voix du Chat, seulement quand ils mènent ailleurs', async () => {
  const votes = [...wins(8, CHALLENGER, LARGE, 'conversation'), ...wins(9, LARGE, CHALLENGER, 'voice')]
  const picks = await setup(votes).pickBestModelsFromBenchmark()
  assert.equal(picks.models.large, CHALLENGER, 'le Chat suit les votes Conversation')
  assert.equal(picks.voiceModels.large, LARGE, 'la voix suit ses propres votes')
  assert.equal(picks.voiceModels.flash, picks.models.flash)
  // Des votes Vocal qui confirment la Conversation : rien à séparer.
  const agree = await setup([...wins(8, CHALLENGER, LARGE, 'conversation'), ...wins(2, CHALLENGER, LARGE, 'voice')]).pickBestModelsFromBenchmark()
  assert.equal(agree.voiceModels, undefined)
})

test('Code : les votes Code décident du modèle Code, pas des rôles de conversation', async () => {
  const picks = await setup(wins(8, LARGE, 'ornith-1.5:35b', 'code')).pickBestModelsFromBenchmark()
  assert.equal(picks.codeModel, LARGE)
  assert.equal(picks.models.large, 'qwen3.5:27b', 'les rôles de conversation ne bougent pas')
})

test('le calcul affiché dit d’où vient la note : les duels (points et nombre de votes), 0 point sans vote', async () => {
  const m = setup([...wins(8, CHALLENGER, LARGE, 'conversation'), ...wins(9, LARGE, CHALLENGER, 'voice')])
  const profile = {
    models: { flash: 'granite4.2:8b', medium: K2_7B, large: CHALLENGER },
    voiceModels: { flash: 'granite4.2:8b', medium: K2_7B, large: LARGE },
    visionModel: LARGE,
    codeModel: LARGE
  }
  const picks = await m.getMyModelPicks(profile)
  assert.equal(picks.large.note.base.kind, 'duel')
  assert.equal(picks.large.note.base.duels, 8)
  assert.ok(picks.large.note.base.points > 0)
  assert.equal(picks.large.note.omniscienceShare, null, 'les duels remplacent toute la note de départ, « n’invente pas » compris')
  // Les rôles de la voix : SES votes (9 duels Vocal), pas les 8 de la Conversation.
  assert.equal(picks.voice.large.model, LARGE)
  assert.deepEqual([picks.voice.large.note.base.kind, picks.voice.large.note.base.duels], ['duel', 9])
  // Jamais en duel : 0 point, force 1 — plus d'Artificial Analysis ni de Terminal-Bench pour ces rôles.
  assert.deepEqual([picks.medium.note.base.kind, picks.medium.note.base.value, picks.medium.note.base.points], ['duel', 1, 0])
  assert.deepEqual([picks.code.note.base.kind, picks.code.note.base.duels], ['duel', 0])
  // Vision n'a pas de duel : elle garde l'intelligence d'Artificial Analysis.
  assert.equal(picks.vision.note.base.kind, 'intelligence')
  // Le produit des parts affichées fait toujours la note.
  const note = picks.large.note
  assert.ok(Math.abs(note.base.value * note.toolsShare * (note.demandsShare ?? 1) - note.total) < 1e-9)
})

test('candidats d’une session : ceux qui tiennent sur CE PC, Ollama capable, test d’outils réussi, et les deux groupes', async () => {
  const m = setup([])
  const profile = { models: { flash: 'granite4.2:8b', medium: K2_7B, large: LARGE }, codeModel: LARGE, blockedModels: { 'gemma4:e4b': 'bloqué' } }
  const candidates = await m.getDuelCandidates('conversation', profile)
  const byModel = new Map(candidates.map((c) => [c.model, c]))
  assert.ok(candidates.length >= 8)
  for (const c of candidates) {
    assert.ok(c.group === 'card' ? c.vramGb <= 7 : c.group === 'ram' && c.vramGb > 7, `${c.model} : groupe ${c.group} pour ${c.vramGb} Go`)
    assert.ok(c.vramGb <= 7 + (32 - 16), `${c.model} ne tient pas sur ce PC`)
  }
  assert.equal(byModel.get(LARGE).inUse, true)
  assert.equal(byModel.get(K2_7B).inUse, true)
  assert.equal(byModel.has('gemma4:e4b'), false, 'un modèle bloqué au téléchargement n’est jamais proposé')
  // Le test d'appel d'outils reste le filtre de base : jamais un modèle sous 75 % aux 78 questions.
  const scores = REAL_SCORES.split('\n')
  for (const c of candidates) {
    const row = scores.find((line) => line.startsWith(`| ${c.model} |`) && /\/78/.test(line))
    const ok = Number(row.match(/(\d+)\/78/)[1])
    assert.ok(ok / 78 >= 0.75, `${c.model} : ${ok}/78`)
  }
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
  const profile = { models: { flash: 'granite4.2:8b', medium: K2_7B, large: LARGE }, codeModel: LARGE }
  const chosen = duel.selectDuelModels(await m.getDuelCandidates('conversation', profile), 5)
  assert.deepEqual(chosen.slice(0, 3).sort(), [K2_7B, 'granite4.2:8b', LARGE].sort())
  const sizes = new Map((await m.getModelOverview()).entries.map((e) => [e.model, e.vramGb]))
  assert.ok(sizes.get(chosen[3]) > 7 !== sizes.get(chosen[4]) > 7, `un gros et un petit challenger : ${chosen.slice(3)}`)
})

test('main.ts branche la source des votes, et le classement de l’écran est celui du choix (tous partent de 0)', () => {
  const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8')
  assert.match(main, /setDuelStrengthSource\(\(category: DuelCategory\) => \{/)
  assert.match(main, /rankDuels\(votes\.filter\(\(v\) => v\.category === category\)\)/)
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
  for (const category of ['code', 'voice']) assert.ok((await m.getDuelCandidates(category, null)).length >= 2, category)
})
