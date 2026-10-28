import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { promisify } from 'node:util'
import ts from 'typescript'
import { withI18n } from './i18n-test-module.mjs'
import { EXPOSE_AA_TABLES, useAaAsDuels } from './aa-as-duels.mjs'

/**
 * Étape 318, Léo (« oui » à « prendre le meilleur des petits modèles au lieu du plus léger ») : sur une petite
 * machine, Jaris prenait le PLUS LÉGER des modèles notés sans regarder sa note — K2 Horizon 0.9B (0/48 aux demandes
 * complètes, 1/5 en code) partout sans carte graphique, et en Rapide sur une carte de 2 Go. Vrais scores du dépôt.
 */
const nodeRequire = createRequire(import.meta.url)
const source = ts.transpileModule(readFileSync(new URL('../electron/services/hardwareScan.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText + EXPOSE_AA_TABLES
const REAL_SCORES = readFileSync(new URL('./verified-tool-scores.md', import.meta.url), 'utf8')

function setup({ scores, vramMib, ramGb = 32, ollamaVersion }) {
  // Même marque que les autres tests de ce module : sans elle, promisify(exec) résout vers un tableau et la VRAM
  // simulée est ignorée en silence.
  const exec = (_cmd, opts, cb) => (typeof opts === 'function' ? opts : cb)(null, `Fake GPU, ${vramMib}\n`, '')
  exec[promisify.custom] = () => Promise.resolve({ stdout: `Fake GPU, ${vramMib}\n`, stderr: '' })
  const modules = {
    child_process: { exec },
    fs: {
      readFileSync: (path) => {
        if (String(path).includes('verified-tool-scores.md')) return scores
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
    },
    '../paths': { resourcesRoot: () => '/fake/resources' },
    './dataLocation': { getDataRoot: () => '/fake/data' },
    './systemResources': { RESOURCE_SAFETY_MARGIN_GB: 16, detectRamGb: () => ramGb },
    './ollama': { getModelInfo: async () => null, getInstalledModelSizeBytes: async () => null, listInstalledModels: async () => [] }
  }
  const exports = {}
  vm.runInNewContext(source, { exports, module: { exports }, require: withI18n((name) => modules[name] ?? nodeRequire(name)) })
  if (ollamaVersion !== undefined) exports.setOllamaVersionSource(() => ollamaVersion)
  // Étape 358 : les exemples réels de ce fichier testent la mécanique du choix avec les anciennes notes publiées.
  return useAaAsDuels(exports)
}

const TINY_K2 = 'hf.co/IFM/K2-Horizon-0.9B-GGUF:Q4_K_M'
const picks = async (vramMib, ramGb) => {
  const { pickBestModelsFromBenchmark } = setup({ scores: REAL_SCORES, vramMib, ramGb, ollamaVersion: '0.40.5' })
  const result = await pickBestModelsFromBenchmark()
  return { flash: result.models.flash, medium: result.models.medium, large: result.models.large, vision: result.visionModel, code: result.codeModel }
}

test('sans carte graphique : jamais le modèle qui rate toutes les demandes complètes, le meilleur des petits', async () => {
  assert.match(REAL_SCORES, /\| hf\.co\/IFM\/K2-Horizon-0\.9B-GGUF:Q4_K_M \| 0\/48 \|/, 'la 0.9B rate bien toutes les demandes')
  for (const ramGb of [8, 16]) {
    const chosen = await picks(0, ramGb)
    for (const role of ['flash', 'medium', 'large', 'code']) {
      assert.notEqual(chosen[role], TINY_K2, `${role} avec ${ramGb} Go de RAM`)
      // Étape 332 : avec sa vraie taille (1,4 Go et non 2), qwen3:1.7b (28/48) entre dans le gabarit des petits et
      // passe devant qwen3.5:0.8b (13/48) pour la conversation ; le Code reste à qwen3.5:0.8b.
      assert.equal(chosen[role], role === 'code' ? 'qwen3.5:0.8b' : 'qwen3:1.7b', `${role} avec ${ramGb} Go de RAM`)
    }
  }
})

test('petite carte (1 à 2 Go) : Rapide prend la meilleure note, plus le plus léger des plus fiables aux questions', async () => {
  // Étape 332 : sur 2 Go, seule K2 Horizon 0.9B (0/48) tient ; le gabarit des petits est appliqué quand même.
  for (const vramMib of [1024, 2048]) assert.equal((await picks(vramMib, 8)).flash, 'qwen3:1.7b', `${vramMib} Mo`)
  // 3 Go : MiniCPM5-2B (37/48, plus léger) plutôt que qwen3:1.7b (28/48), qui avait seulement le meilleur score aux questions.
  assert.equal((await picks(3072, 16)).flash, 'hf.co/openbmb/MiniCPM5-2B-GGUF:Q4_K_M')
})

test('le gabarit « deux fois le plus léger » ne sert QUE quand rien ne tient : une carte de 6 Go garde K2 Horizon 3.7B', async () => {
  const chosen = await picks(6144, 16)
  assert.equal(chosen.flash, 'hf.co/IFM/K2-Horizon-3.7B-GGUF:Q4_K_M')
  assert.equal(chosen.medium, 'hf.co/IFM/K2-Horizon-3.7B-GGUF:Q4_K_M')
})

test('la machine de Léo (8 Go de VRAM, 63 Go de RAM) : modèles attendus', async () => {
  assert.deepEqual(await picks(8192, 63), {
    // Étape 340 : granite4.2:8b → qwen3.5:9b en Faible ; étape 348 : retour à granite4.2:8b (sa vitesse publiée est
    // passée de 47,1 à 97,3 tokens/s le 23/10/2026).
    flash: 'granite4.2:8b',
    medium: 'hf.co/IFM/K2-Horizon-7B-GGUF:Q4_K_M',
    large: 'qwen3.8:27b',
    vision: 'qwen3.8:27b',
    code: 'qwen3.8:27b'
  })
})

test('étape 332 : sans carte graphique mais avec beaucoup de RAM, Élevé et Code gardent un vrai modèle (pas le gabarit des petits)', async () => {
  const chosen = await picks(0, 32)
  assert.equal(chosen.flash, 'qwen3:1.7b')
  assert.equal(chosen.large, 'gpt-oss:20b')
  assert.equal(chosen.code, 'devstral-small-2:24b')
})

// Étape 346 : « Retester la configuration » choisissait d'autres modèles quand la version d'Ollama n'était pas encore
// connue (démarrage en cours) — K2 Horizon 0.9B, écarté faute de version, changeait le gabarit des « petits ».
test('petite machine : même choix que la version d’Ollama soit connue ou pas encore', async () => {
  const pick = async (vramMib, ramGb, ollamaVersion) => {
    const { pickBestModelsFromBenchmark } = setup({ scores: REAL_SCORES, vramMib, ramGb, ollamaVersion })
    const r = await pickBestModelsFromBenchmark()
    return [r.models.flash, r.models.medium, r.models.large, r.visionModel, r.codeModel].join(' | ')
  }
  for (const [vramMib, ramGb] of [[0, 8], [0, 16], [1024, 16], [2048, 16], [3072, 16], [4096, 16]]) {
    assert.equal(await pick(vramMib, ramGb, null), await pick(vramMib, ramGb, '0.40.5'), `${vramMib / 1024} Go de carte, ${ramGb} Go de RAM`)
  }
})
