import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { promisify } from 'node:util'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * Étape 234 (bêta de Jaris) : le choix des modèles (hardwareScan.ts) et le filet de téléchargement
 * (getDownloadBudgetGb, systemResources.ts) ne doivent jamais se contredire. Vu en vrai sur un PC sans carte
 * NVIDIA avec 16 Go de mémoire : Jaris choisissait qwen3.5:0.8b, puis refusait de le télécharger (« au-delà
 * des 0.0 Go disponibles ») — aucun modèle installable, Jaris inutilisable. Ici, toutes les configurations
 * courantes : chaque modèle choisi doit passer le filet.
 */
const nodeRequire = createRequire(import.meta.url)
const transpile = (path) =>
  ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText

function load(path, modules) {
  const exports = {}
  vm.runInThisContext(`(function (exports, require, module) {\n${transpile(path)}\n})`)(exports, (name) => modules[name] ?? nodeRequire(name), { exports })
  return exports
}

const resources = load('electron/services/systemResources.ts', {})
const scores = readFileSync(new URL('./verified-tool-scores.md', import.meta.url), 'utf8')

function scanFor(vramGb, ramGb) {
  const answer = vramGb === null ? null : `Fake GPU, ${vramGb * 1024}\n`
  const exec = (_cmd, opts, cb) => (typeof opts === 'function' ? opts : cb)(answer ? null : new Error('pas de nvidia-smi'), answer ?? '', '')
  exec[promisify.custom] = () => (answer ? Promise.resolve({ stdout: answer, stderr: '' }) : Promise.reject(new Error('pas de nvidia-smi')))
  return load('electron/services/hardwareScan.ts', {
    child_process: { exec },
    fs: {
      readFileSync: (path) => {
        if (String(path).includes('verified-tool-scores.md')) return scores
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
    },
    '../paths': { resourcesRoot: () => '/fake/resources' },
    './dataLocation': { getDataRoot: () => '/fake/data' },
    './systemResources': { RESOURCE_SAFETY_MARGIN_GB: resources.RESOURCE_SAFETY_MARGIN_GB, detectRamGb: () => ramGb },
    './ollama': { getModelInfo: async () => null, getInstalledModelSizeBytes: async () => null, listInstalledModels: async () => [] }
  })
}

const MACHINES = [null, 4, 6, 8, 12, 16, 24].flatMap((vram) => [8, 16, 32, 64].map((ram) => [vram, ram]))

test('chaque modèle que Jaris choisit pour une machine peut aussi y être téléchargé', async () => {
  for (const [vram, ram] of MACHINES) {
    const picks = await scanFor(vram, ram).getMyModelPicks(null)
    const budget = resources.downloadBudgetGb(vram, ram)
    for (const role of ['flash', 'medium', 'large', 'vision', 'code']) {
      const entry = picks[role]
      if (!entry?.model) continue
      assert.ok(entry.vramGb <= budget, `${vram ?? 'sans carte NVIDIA'} Go / ${ram} Go de RAM : ${role} = ${entry.model} (${entry.vramGb} Go) refusé au téléchargement (budget ${budget} Go)`)
    }
  }
})

test('le filet de téléchargement ne garde que le minimum pour Windows, pas la marge de confort du choix', () => {
  assert.ok(resources.FEASIBILITY_MARGIN_GB < resources.RESOURCE_SAFETY_MARGIN_GB)
  assert.equal(resources.downloadBudgetGb(null, 16), 12)
  assert.equal(resources.downloadBudgetGb(8, 32), 36)
  assert.equal(resources.downloadBudgetGb(null, 2), 0)
})
