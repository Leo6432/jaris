import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { promisify } from 'node:util'
import ts from 'typescript'
import { withI18n } from './i18n-test-module.mjs'

/**
 * Étape 329, Léo : « il y a pas écrit le score Terminal-Bench, et ça utilise combien de pourcentage, Artificial
 * Analysis combien, appel d'outils… ». getMyModelPicks joint à chaque rôle le calcul de sa note (noteBreakdown,
 * hardwareScan.ts) : la mesure de départ et la part que garde chaque mesure. Ce fichier vérifie, sur les VRAIS
 * scores du dépôt, que ce calcul affiché est bien celui qui choisit les modèles — jamais un second calcul refait à
 * côté, qui pourrait un jour montrer autre chose que ce que Jaris a réellement fait.
 */
const nodeRequire = createRequire(import.meta.url)
const source = ts.transpileModule(readFileSync(new URL('../electron/services/hardwareScan.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const REAL_SCORES = readFileSync(new URL('./verified-tool-scores.md', import.meta.url), 'utf8')

function setup({ vramMib, ramGb = 32 } = {}) {
  // Marque [util.promisify.custom] indispensable (voir test-hardwarescan-tiebreak.mjs).
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
  return exports
}

const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message} : ${actual} au lieu de ${expected}`)
const ROLES = ['flash', 'medium', 'large', 'vision', 'code']
/** Le produit des parts affichées, tel que l'écran l'écrit (« Note = base × parts »). */
const product = (note) => note.base.value * (note.omniscienceShare ?? 1) * note.toolsShare * (note.demandsShare ?? 1)

test('machine de Léo (8 Go, 32 Go) : chaque mesure du calcul vient de la bonne source, et le produit fait la note', async () => {
  // Étape 358 : sans vote de duel, Faible, Moyen, Élevé et Code partent tous de 0 point (force 1) — plus
  // d'Artificial Analysis ni de Terminal-Bench ; seule la fiabilité les sépare. Vision garde l'intelligence publiée.
  const picks = await setup({ vramMib: 8 * 1024 }).getMyModelPicks(null)
  const large = picks.large
  assert.equal(large.model, 'qwen3.5:27b')
  assert.deepEqual(JSON.parse(JSON.stringify(large.note.base)), { kind: 'duel', value: 1, duels: 0, points: 0 })
  assert.equal(large.note.omniscienceShare, null, 'les duels remplacent toute la note de départ')
  close(large.note.toolsShare, Math.pow(78 / 78, 5), 'Élevé : 78/78, sur 5 actions de suite')
  assert.equal(large.note.demandsEstimated, false)

  // Code : 0 point aussi, et le score de code (ou de conversation) — jamais les demandes.
  const code = picks.code
  assert.deepEqual([code.note.base.kind, code.note.base.value], ['duel', 1])
  assert.equal(code.note.omniscienceShare, null)
  assert.equal(code.note.demandsShare, null)

  // Vision : l'intelligence d'Artificial Analysis, une seule lecture par demande (chaîne de 1).
  assert.equal(picks.vision.note.base.kind, 'intelligence')
  assert.equal(picks.vision.note.chain, 1)
  close(picks.vision.note.toolsShare, 1, 'Vision : 34/34')

  for (const role of ROLES) close(picks[role].note.total, product(picks[role].note), `${role} : le produit des parts affichées`)
})

test('le calcul affiché classe les modèles comme le choix réel : aucun modèle qui tient sur la carte ne bat Élevé', async () => {
  // Élevé : la meilleure note parmi TOUS les modèles qui tiennent (bestNote), rien d'autre ne départage. Tout modèle
  // qui tient entièrement sur la carte tient aussi pour Élevé : aucun ne doit avoir une meilleure note AFFICHÉE.
  for (const [vram, ram] of [[8, 32], [12, 32], [24, 64]]) {
    const m = setup({ vramMib: vram * 1024, ramGb: ram })
    m.setOllamaVersionSource(() => '0.40.5')
    const winner = (await m.getMyModelPicks(null)).large
    const onCard = (await m.getModelOverview()).entries.filter((entry) => entry.vramGb <= vram - 1 && entry.toolCalling?.endsWith('/78'))
    assert.ok(onCard.length >= 5, `${vram} Go : trop peu de modèles comparés (${onCard.length}) pour que le test serve`)
    for (const entry of onCard) {
      const other = m.noteBreakdown(entry.model, 'conversation', entry.toolCalling, entry.demands ?? null)
      if (other.total === null) continue
      assert.ok(winner.note.total >= other.total - 1e-9, `${vram} Go : ${entry.model} (${other.total}) bat ${winner.model} (${winner.note.total})`)
    }
  }
})

test('cas sans note : jamais testé, mesure non publiée — jamais un zéro ; demandes estimées signalées comme telles', () => {
  const { noteBreakdown } = setup({ vramMib: 8 * 1024 })
  const untested = noteBreakdown('granite4.2:8b', 'conversation', null, null)
  assert.equal(untested.toolsShare, null)
  assert.equal(untested.total, null, 'un modèle jamais testé n’a pas de note (pickRole l’écarte), pas 0')
  // Étape 358 : un modèle sans rien de publié (qwen2.5-coder:14b) a quand même sa note : 0 point de duel, force 1.
  const unpublished = noteBreakdown('qwen2.5-coder:14b', 'code', '5/5', null)
  assert.deepEqual([unpublished.base.kind, unpublished.base.value], ['duel', 1])
  close(unpublished.total, 1, 'force 1 × 5/5')
  // Vision sans intelligence publiée : toujours pas de note, jamais un zéro.
  assert.equal(noteBreakdown('qwen2.5-coder:14b', 'vision', '5/5', null).total, null)
  // Sans score de demandes du test actuel : la part est estimée sur le test d'outils (jamais 1), et dite estimée.
  const estimated = noteBreakdown('granite4.2:8b', 'conversation', '70/78', null)
  assert.equal(estimated.demandsEstimated, true)
  close(estimated.demandsShare, 70 / 78, 'demandes estimées sur les questions')
  // Un score de demandes d'un ancien test (autre total) ne compte pas : estimé aussi.
  assert.equal(noteBreakdown('granite4.2:8b', 'conversation', '70/78', '10/17').demandsEstimated, true)
})

test('une seule formule : la note du choix (noteOf) et celle du calcul affiché passent par modelNote', () => {
  const file = readFileSync(new URL('../electron/services/hardwareScan.ts', import.meta.url), 'utf8')
  assert.match(file, /const noteOf = \(c: Scored, chain: number\): number \| null => modelNote\(c\.strength, c\.result\.toolCalling, chain, c\.demands\)/)
  assert.match(file, /total: rate >= 0 \? modelNote\(strength, toolCalling, chain, demands\?\.value\) : null/)
  assert.equal((file.match(/Math\.pow\(Math\.max\(0, parseToolScore\(/g) ?? []).length, 1, 'la formule n’est écrite qu’une fois')
})

test('« Tous les modèles » : Omniscience et Terminal-Bench publiés pour chaque modèle qui en a, `null` sinon', async () => {
  const overview = await setup({ vramMib: 8 * 1024 }).getModelOverview()
  const byModel = new Map(overview.entries.map((entry) => [entry.model, entry]))
  assert.equal(byModel.get('qwen3.8:27b').omniscience, -10)
  assert.equal(byModel.get('qwen3.8:27b').terminalBench, 79.8)
  assert.equal(byModel.get('ministral-3:3b').terminalBench, 0, 'un 0 % publié reste 0, pas null')
  assert.equal(byModel.get('qwen2.5-coder:14b').omniscience, null)
  assert.equal(byModel.get('qwen2.5-coder:14b').terminalBench, null)
  // Étape 330 : K2-Horizon-32B en Terminal-Bench 2.1 (fiche d'IFM) ; jamais un chiffre de Terminal-Bench 2.0, même
  // publié par le créateur (Qwen : 41,6 % pour qwen3.5:27b, 40,5 % pour qwen3.5:35b) — une autre version du test.
  assert.equal(byModel.get('hf.co/IFM/K2-Horizon-32B-GGUF:Q4_K_M').terminalBench, 62.6)
  assert.equal(byModel.get('qwen3.5:27b').terminalBench, null)
  assert.equal(byModel.get('qwen3.5:35b').terminalBench, null)
})

test('étape 331 : chaque modèle de Jaris a sa version compressée, et « Tous les modèles » l\'affiche', async () => {
  const m = setup({ vramMib: 8 * 1024 })
  const overview = await m.getModelOverview()
  const byModel = new Map(overview.entries.map((entry) => [entry.model, entry]))
  // Un modèle ajouté plus tard sans sa version ferait échouer ce test, au lieu d'afficher un badge vide.
  for (const model of m.getAllCandidateModelIds()) {
    assert.match(m.MODEL_QUANTIZATION[model] ?? '', /^(Q4_K_M|Q8_0|MXFP4)$/, `${model} : version manquante`)
    assert.equal(byModel.get(model)?.quantization, m.MODEL_QUANTIZATION[model], `${model} : version absente de l'écran`)
  }
  // Relevé du registre le 19/10/2026 : les seules exceptions au Q4_K_M.
  assert.equal(m.MODEL_QUANTIZATION['qwen3.5:0.8b'], 'Q8_0')
  assert.equal(m.MODEL_QUANTIZATION['qwen3.5:2b'], 'Q8_0')
  assert.equal(m.MODEL_QUANTIZATION['gpt-oss:20b'], 'MXFP4')
  assert.equal(m.MODEL_QUANTIZATION['hf.co/bartowski/ai9stars_G9v3-3B-GGUF'], 'Q4_K_M')
})
