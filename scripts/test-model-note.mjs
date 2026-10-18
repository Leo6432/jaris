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
  const picks = await setup({ vramMib: 8 * 1024 }).getMyModelPicks(null)
  const large = picks.large
  assert.equal(large.model, 'qwen3.8:27b')
  assert.deepEqual(JSON.parse(JSON.stringify(large.note.base)), { kind: 'intelligence', value: 33.7 })
  close(large.note.omniscienceShare, (100 - 10) / 200, 'Élevé : part gardée par AA-Omniscience (-10)')
  close(large.note.toolsShare, Math.pow(77 / 78, 5), 'Élevé : 77/78, sur 5 actions de suite')
  close(large.note.demandsShare, 47 / 48, 'Élevé : demandes complètes 47/48')
  assert.equal(large.note.demandsEstimated, false)
  close(large.note.total, 33.7 * 0.45 * Math.pow(77 / 78, 5) * (47 / 48), 'Élevé : la note')

  // Code : Terminal-Bench 2.1 et le score de conversation (qwen3.8:27b n'a jamais passé le test de code) — ni
  // l'intelligence générale, ni l'Omniscience, ni les demandes.
  const code = picks.code
  assert.equal(code.model, 'qwen3.8:27b')
  assert.deepEqual(JSON.parse(JSON.stringify(code.note.base)), { kind: 'terminalBench', value: 79.8 })
  assert.equal(code.note.omniscienceShare, null)
  assert.equal(code.note.demandsShare, null)
  close(code.note.total, 79.8 * Math.pow(77 / 78, 5), 'Code : la note')
  assert.equal(code.terminalBench, 79.8)
  assert.equal(code.omniscience, -10)

  // Vision : une seule lecture par demande (chaîne de 1).
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
  // qwen2.5-coder:14b : rien de publié par Artificial Analysis pour lui.
  const unpublished = noteBreakdown('qwen2.5-coder:14b', 'code', '5/5', null)
  assert.equal(unpublished.base, null)
  assert.equal(unpublished.total, null)
  // Sans score de demandes du test actuel : la part est estimée sur le test d'outils (jamais 1), et dite estimée.
  const estimated = noteBreakdown('granite4.2:8b', 'conversation', '70/78', null)
  assert.equal(estimated.demandsEstimated, true)
  close(estimated.demandsShare, 70 / 78, 'demandes estimées sur les questions')
  // Un score de demandes d'un ancien test (autre total) ne compte pas : estimé aussi.
  assert.equal(noteBreakdown('granite4.2:8b', 'conversation', '70/78', '10/17').demandsEstimated, true)
  // Terminal-Bench à 0 % : le plancher d'une tâche sur 89, comme dans le choix (codeStrength).
  close(noteBreakdown('qwen3.5:0.8b', 'code', '3/5', null).base.value, 100 / 89, 'plancher de Terminal-Bench')
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
})
