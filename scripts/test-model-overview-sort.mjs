import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { promisify } from 'node:util'
import ts from 'typescript'
import { withI18n } from './i18n-test-module.mjs'

/**
 * Léo, sur la page "Tous les modèles" (Options → Modèles) : "fait pour rapide etc... celui qui faut le moin
 * de ram avec le plus pour tout" — clarifié ensuite (AskUserQuestion) en un simple tri d'affichage : chaque
 * palier de `getModelOverview()` doit lister ses candidats par VRAM CROISSANTE, le moins gourmand en
 * premier. Vérifié ici directement sur le VRAI `getModelOverview()` (hardwareScan.ts), pas sur un mock de la
 * page — les tableaux sources (`TIER_CANDIDATES`/`VISION_CANDIDATES`/`CODE_CANDIDATES`) restent en ordre
 * DÉCROISSANT (l'ordre dont `pickBestFrom` a besoin pour choisir le vrai modèle de Jaris) : ce test confirme
 * aussi que ce tri d'affichage ne les modifie pas en place. Mêmes mocks no-op qu'ailleurs pour
 * fs/child_process/systemResources (pas de vraie machine dans ce test).
 */
const nodeRequire = createRequire(import.meta.url)
const source = ts.transpileModule(readFileSync(new URL('../electron/services/hardwareScan.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

function setup({ verifiedToolScoresMd = '', vramMib = 30 * 1024, ramGb = 32 } = {}) {
  // Voir le même commentaire dans test-hardwarescan-tiebreak.mjs : execAsync = promisify(exec) a besoin de la
  // marque [util.promisify.custom] pour résoudre vers {stdout, stderr} plutôt qu'un tableau positionnel.
  const exec = (_cmd, opts, cb) => {
    const callback = typeof opts === 'function' ? opts : cb
    callback(null, `Fake GPU, ${vramMib}\n`, '')
  }
  exec[promisify.custom] = () => Promise.resolve({ stdout: `Fake GPU, ${vramMib}\n`, stderr: '' })

  const modules = {
    child_process: { exec },
    fs: {
      readFileSync: (path) => {
        if (String(path).includes('verified-tool-scores.md')) return verifiedToolScoresMd
        const err = new Error('ENOENT')
        err.code = 'ENOENT'
        throw err
      }
    },
    '../paths': { resourcesRoot: () => '/fake/resources' },
    './systemResources': { RESOURCE_SAFETY_MARGIN_GB: 4, detectRamGb: () => ramGb },
    './ollama': { getModelInfo: async () => null, getInstalledModelSizeBytes: async () => null }
  }
  const exports = {}
  vm.runInNewContext(source, {
    exports,
    module: { exports },
    require: withI18n((name) => modules[name] ?? nodeRequire(name))
  })
  return exports
}

test('"Tous les modèles" : une seule liste, triée par VRAM croissante, le moins gourmand en premier', async () => {
  const { getModelOverview } = setup()
  const overview = await getModelOverview()
  assert.ok(overview.entries.length > 30, 'tous les modèles du catalogue attendus')
  for (let i = 1; i < overview.entries.length; i++) {
    assert.ok(overview.entries[i - 1].vramGb <= overview.entries[i].vramGb, `pas trié : ${overview.entries[i].model}`)
  }
  // Étape 312 : K2 Horizon 0.9B (0,7 Go) passe devant qwen3.5:0.8b (1 Go).
  // Étape 471 : la colonne montre la mémoire réelle chargée (contexte 16 384) : Qwen3.5-0.8B corrigé (1,4 Go) passe
  // devant K2 Horizon 0.9B (1,7 Go : son contexte, sans attention économe, pèse plus que ses poids).
  assert.equal(overview.entries[0].model, 'hf.co/mradermacher/Qwen3.5-0.8B-weight-space-programming-GGUF:Q8_0')
  assert.equal(overview.entries[0].vramGb, 1.4)
  assert.equal(overview.entries.find((e) => e.model === 'granite4.2:8b').vramGb, 8.3, 'mémoire chargée, pas la taille du fichier (5,3 Go)')
})

test('chaque modèle n\'apparaît qu\'une fois, avec son étiquette Rapide/Moyen/Puissant (repère affiché)', async () => {
  const { getModelOverview } = setup()
  const overview = await getModelOverview()
  const models = overview.entries.map((e) => e.model)
  assert.equal(new Set(models).size, models.length, 'un modèle en double dans la liste unique')
  const category = (m) => overview.entries.find((e) => e.model === m).category
  assert.equal(category('qwen3.5:0.8b'), 'Rapide')
  assert.equal(category('qwen3.5:9b'), 'Moyen')
  assert.equal(category('qwen3.8:27b'), 'Puissant')
})

test('le tri d\'affichage ne modifie pas la liste dont le choix des modèles a besoin', async () => {
  const scan = setup()
  const first = await scan.getModelOverview()
  const before = await scan.pickBestModelsFromBenchmark()
  const second = await scan.getModelOverview()
  const after = await scan.pickBestModelsFromBenchmark()
  assert.deepEqual(second.entries.map((e) => e.model), first.entries.map((e) => e.model))
  assert.equal(JSON.stringify(after), JSON.stringify(before), 'le choix des modèles ne doit pas dépendre de l\'affichage')
})

// Étape 471 : la mémoire réelle chargée (contexte 16 384) sert à l'affichage ET au choix des modèles. Un modèle ajouté
// sans mesure retomberait en silence sur la taille de son fichier : chaque modèle doit avoir la sienne
// (scripts/measure-model-memory.py), toujours au moins la taille de ses poids.
test('étape 471 : chaque modèle a sa mémoire chargée mesurée (contexte 16 384)', async () => {
  const scan = setup()
  const overview = await scan.getModelOverview()
  const missing = overview.entries.map((e) => e.model).filter((m) => !(m in scan.MODEL_MEMORY_16K_GB))
  assert.equal(missing.join(', '), '', 'modèles sans mémoire mesurée')
  for (const e of overview.entries) {
    assert.ok(scan.MODEL_MEMORY_16K_GB[e.model] >= scan.modelSizeGb(e.model) * 0.9, `${e.model} : ${scan.MODEL_MEMORY_16K_GB[e.model]} Go pour un fichier de ${scan.modelSizeGb(e.model)} Go`)
  }
})
