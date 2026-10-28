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
 * Étape 355 (Léo : « on vote, à la place d'Artificial Analysis ») : sur les VRAIS scores du dépôt et une machine
 * comme celle de Léo (8 Go, 32 Go), les votes des duels décident du choix des modèles — par catégorie, pour les seuls
 * modèles déjà passés en duel. La source des votes est branchée comme dans main.ts, avec le vrai classement.
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
  if (votes) exports.setDuelStrengthSource((category, prior) => duel.rankDuels(votes.filter((v) => v.category === category), prior))
  return exports
}

let nextId = 0
const wins = (n, winner, loser, category) =>
  Array.from({ length: n }, () => ({ id: `v${nextId++}`, category, at: nextId, sessionId: 's', modelA: winner, modelB: loser, outcome: 'a', prompt: '' }))

test('sans vote : exactement le choix d’avant (aucune source branchée, ou une source vide)', async () => {
  const before = await setup(null).pickBestModelsFromBenchmark()
  const empty = await setup([]).pickBestModelsFromBenchmark()
  assert.deepEqual(JSON.parse(JSON.stringify(empty)), JSON.parse(JSON.stringify(before)))
  assert.equal(before.models.large, LARGE)
  assert.equal(before.voiceModels, undefined, 'la voix et le Chat partagent leurs modèles')
})

test('Conversation : jamais un seul vote, mais des victoires constantes changent le modèle Élevé — pour le Chat ET la voix', async () => {
  assert.equal((await setup(wins(1, CHALLENGER, LARGE, 'conversation')).pickBestModelsFromBenchmark()).models.large, LARGE, 'un seul vote')
  const picks = await setup(wins(4, CHALLENGER, LARGE, 'conversation')).pickBestModelsFromBenchmark()
  assert.equal(picks.models.large, CHALLENGER)
  // La voix suit les votes Conversation tant qu'elle n'a pas les siens (duelPrior) : rien ne la sépare du Chat.
  assert.equal(picks.voiceModels, undefined)
  // Le Code, lui, n'est pas concerné par des votes de Conversation.
  assert.equal(picks.codeModel, LARGE)
})

test('Vocal : ses propres votes séparent la voix du Chat, seulement quand ils mènent ailleurs', async () => {
  const votes = [...wins(4, CHALLENGER, LARGE, 'conversation'), ...wins(5, LARGE, CHALLENGER, 'voice')]
  const picks = await setup(votes).pickBestModelsFromBenchmark()
  assert.equal(picks.models.large, CHALLENGER, 'le Chat suit les votes Conversation')
  assert.equal(picks.voiceModels.large, LARGE, 'la voix suit ses propres votes')
  assert.equal(picks.voiceModels.flash, picks.models.flash)
  // Des votes Vocal qui confirment la Conversation : rien à séparer.
  const agree = await setup([...wins(4, CHALLENGER, LARGE, 'conversation'), ...wins(2, CHALLENGER, LARGE, 'voice')]).pickBestModelsFromBenchmark()
  assert.equal(agree.voiceModels, undefined)
})

test('Code : les votes Code décident du modèle Code, pas des rôles de conversation', async () => {
  const picks = await setup(wins(6, K2_7B, LARGE, 'code')).pickBestModelsFromBenchmark()
  assert.notEqual(picks.codeModel, LARGE, 'six défaites de suite font perdre sa place au modèle Code')
  assert.equal(picks.models.large, LARGE, 'les rôles de conversation ne bougent pas')
})

test('le calcul affiché dit d’où vient la note : les votes (et combien), sinon Artificial Analysis', async () => {
  const m = setup([...wins(4, CHALLENGER, LARGE, 'conversation'), ...wins(5, LARGE, CHALLENGER, 'voice')])
  const profile = {
    models: { flash: 'granite4.2:8b', medium: K2_7B, large: CHALLENGER },
    voiceModels: { flash: 'granite4.2:8b', medium: K2_7B, large: LARGE },
    visionModel: LARGE,
    codeModel: LARGE
  }
  const picks = await m.getMyModelPicks(profile)
  assert.equal(picks.large.note.base.kind, 'duel')
  assert.equal(picks.large.note.base.duels, 4)
  assert.equal(picks.large.note.omniscienceShare, null, 'les votes remplacent toute la note de départ, « n’invente pas » compris')
  // Les rôles de la voix : SES votes (5 duels Vocal), pas les 4 de la Conversation.
  assert.equal(picks.voice.large.model, LARGE)
  assert.deepEqual([picks.voice.large.note.base.kind, picks.voice.large.note.base.duels], ['duel', 5])
  // Jamais en duel : Artificial Analysis, inchangé.
  assert.equal(picks.medium.note.base.kind, 'intelligence')
  assert.equal(picks.code.note.base.kind, 'terminalBench', 'aucun vote Code : le Code garde Terminal-Bench')
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

test('main.ts branche la source des votes, et le classement de l’écran part de la même note que le choix', () => {
  const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8')
  assert.match(main, /setDuelStrengthSource\(\(category: DuelCategory, prior\) => \{/)
  const session = readFileSync(new URL('../electron/services/duelSession.ts', import.meta.url), 'utf8')
  assert.match(session, /rankDuels\(votes, duelPrior\(category\)\)/)
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
