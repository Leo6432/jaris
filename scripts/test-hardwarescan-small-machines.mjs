import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { promisify } from 'node:util'
import ts from 'typescript'
import { withI18n } from './i18n-test-module.mjs'

/**
 * Étape 318, Léo (« oui » à « prendre le meilleur des petits modèles au lieu du plus léger ») : sur une petite
 * machine, Jaris prenait le PLUS LÉGER des modèles notés sans regarder sa note — K2 Horizon 0.9B (0/48 aux demandes
 * complètes, 1/5 en code) partout sans carte graphique, et en Rapide sur une carte de 2 Go. Vrais scores du dépôt.
 */
const nodeRequire = createRequire(import.meta.url)
const source = ts.transpileModule(readFileSync(new URL('../electron/services/hardwareScan.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
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
  return exports
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
      assert.equal(chosen[role], 'qwen3.5:0.8b', `${role} avec ${ramGb} Go de RAM`)
    }
  }
})

test('petite carte (1 à 2 Go) : Rapide prend la meilleure note, plus le plus léger des plus fiables aux questions', async () => {
  for (const vramMib of [1024, 2048]) assert.equal((await picks(vramMib, 8)).flash, 'qwen3.5:0.8b', `${vramMib} Mo`)
  // 3 Go : MiniCPM5-2B (37/48, plus léger) plutôt que qwen3:1.7b (28/48), qui avait seulement le meilleur score aux questions.
  assert.equal((await picks(3072, 16)).flash, 'hf.co/openbmb/MiniCPM5-2B-GGUF:Q4_K_M')
})

test('le gabarit « deux fois le plus léger » ne sert QUE quand rien ne tient : une carte de 6 Go garde K2 Horizon 3.7B', async () => {
  const chosen = await picks(6144, 16)
  assert.equal(chosen.flash, 'hf.co/IFM/K2-Horizon-3.7B-GGUF:Q4_K_M')
  assert.equal(chosen.medium, 'hf.co/IFM/K2-Horizon-3.7B-GGUF:Q4_K_M')
})

test('la machine de Léo (8 Go de VRAM, 63 Go de RAM) ne change pas', async () => {
  assert.deepEqual(await picks(8192, 63), {
    flash: 'granite4.2:8b',
    medium: 'hf.co/IFM/K2-Horizon-7B-GGUF:Q4_K_M',
    large: 'qwen3.8:27b',
    vision: 'qwen3.8:27b',
    code: 'qwen3.8:27b'
  })
})
