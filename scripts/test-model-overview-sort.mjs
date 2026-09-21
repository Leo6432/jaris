import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { promisify } from 'node:util'
import ts from 'typescript'

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
        if (String(path).includes('benchmark-results.md')) {
          const err = new Error('ENOENT')
          err.code = 'ENOENT'
          throw err
        }
        const err = new Error('ENOENT')
        err.code = 'ENOENT'
        throw err
      }
    },
    '../paths': { resourcesRoot: () => '/fake/resources' },
    './systemResources': { RESOURCE_SAFETY_MARGIN_GB: 4, detectRamGb: () => ramGb },
    './ollama': { getModelInfo: async () => null, getInstalledModelSizeBytes: async () => null },
    './externalScoresStore': { getExternalScoreOverrides: async () => ({}) }
  }
  const exports = {}
  vm.runInNewContext(source, {
    exports,
    module: { exports },
    require: (name) => modules[name] ?? nodeRequire(name)
  })
  return exports
}

test('"Tous les modèles" liste chaque palier par VRAM croissante, le moins gourmand en premier', async () => {
  const { getModelOverview } = setup()
  const overview = await getModelOverview()
  assert.ok(overview.groups.length > 0, 'au moins un palier attendu')
  for (const group of overview.groups) {
    for (let i = 1; i < group.entries.length; i++) {
      assert.ok(
        group.entries[i - 1].vramGb <= group.entries[i].vramGb,
        `palier ${group.tier} pas trié par VRAM croissante : ${group.entries.map((e) => `${e.model}(${e.vramGb})`).join(', ')}`
      )
    }
  }
})

test('le palier Rapide place bien le modèle le moins gourmand en tête (pas juste "déjà dans cet ordre")', async () => {
  const { getModelOverview } = setup()
  const overview = await getModelOverview()
  const flash = overview.groups.find((g) => g.tier === 'Rapide')
  assert.ok(flash, 'palier Rapide introuvable')
  // Source (FLASH_CANDIDATES) volontairement en ordre DÉCROISSANT (ministral-3:3b, 3,0 Go, en tête) — si le
  // tri ne faisait rien, ce serait encore ministral-3:3b en première position ici, pas qwen3.5:0.8b (1 Go).
  assert.equal(flash.entries[0].model, 'qwen3.5:0.8b', `premier modèle attendu (le moins gourmand) : ${flash.entries[0].model}`)
})

test('le tri d\'affichage ne modifie pas les tableaux sources dont pickBestFrom a besoin (toujours décroissants)', async () => {
  const scan = setup()
  // Deux appels successifs à getModelOverview() : si le tri mutait TIER_CANDIDATES en place (un tableau
  // partagé au niveau module), le second appel afficherait un résultat différent du premier.
  const first = await scan.getModelOverview()
  const second = await scan.getModelOverview()
  const flashFirst = first.groups.find((g) => g.tier === 'Rapide').entries.map((e) => e.model)
  const flashSecond = second.groups.find((g) => g.tier === 'Rapide').entries.map((e) => e.model)
  assert.deepEqual(flashSecond, flashFirst, 'deux appels successifs doivent donner le même ordre trié')
  // pickBestFrom (via pickBestModelsFromBenchmark) doit toujours choisir sur la base du VRAI budget, sans être
  // perturbé par le tri d'affichage exercé juste avant par getModelOverview() dans ce même test.
  const picked = await scan.pickBestModelsFromBenchmark()
  assert.ok(picked.models.flash, 'pickBestModelsFromBenchmark doit toujours renvoyer un modèle Rapide après ce tri')
})
