import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { promisify } from 'node:util'
import ts from 'typescript'

/**
 * Reproduit la demande de Léo ("je veux que tout le monde ait le même model dans palier 1 et 2 et 3" ->
 * clarifié en "ajoute 10 palier, mais les 10 palier doivent etre exact pour tout le monde") : les 3 anciens
 * points fixes de previewHardwareTiers (6/12/24 Go, "Petite/Moyenne/Grande") pouvaient regrouper sous une
 * même étiquette deux machines qui obtiennent en réalité des modèles différents (une vraie frontière de
 * pickBestFrom tombant entre les deux). previewVramSteps remplace ces 3 points fixes par les VRAIES
 * frontières (une par candidat benchmarké) : ce test vérifie que deux VRAM TOTALES tombant dans le même
 * intervalle entre deux frontières obtiennent garanti le même modèle, et que le nombre de lignes correspond
 * exactement au nombre de frontières réelles connues (pas un chiffre arbitraire). Mêmes mocks no-op
 * qu'ailleurs pour fs/child_process/systemResources (pas de vraie machine dans ce test).
 */
const nodeRequire = createRequire(import.meta.url)
const source = ts.transpileModule(readFileSync(new URL('../electron/services/hardwareScan.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

function setup({ verifiedToolScoresMd = '', vramMib, ramGb = 32 } = {}) {
  // Voir le même commentaire dans test-hardwarescan-tiebreak.mjs : execAsync = promisify(exec) a besoin de la
  // marque [util.promisify.custom] pour résoudre vers {stdout, stderr} plutôt qu'un tableau positionnel —
  // sans elle, detectGpu() retombe silencieusement sur {name: null, vramGb: null} et ignore vramMib.
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
    // Curseur de longueur de contexte : hardwareScan.ts importe désormais ces deux fonctions d'ollama.ts,
    // jamais appelées par les tests de ce fichier (aucune assertion ici ne porte dessus) — sans ce stub,
    // le require shim ne trouve pas './ollama' et fait échouer tout le module à charger.
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

// qwen3.5:4b (3,4 Go) et qwen3.5:9b (6,6 Go) sont tous deux candidats Médium (MEDIUM_CANDIDATES,
// hardwareScan.ts) : leurs frontières de VRAM TOTALE réelle sont 3,4+4,5=7,9 Go et 6,6+4,5=11,1 Go
// (STT_RESERVED_GB=4,5 dans le vrai fichier). Aucun candidat Rapide/Puissant n'a de score connu dans ce
// test (verified-tool-scores.md mocké ne mentionne que ces deux) : previewVramSteps ne doit donc dériver
// EXACTEMENT que ces 2 frontières, pas plus.
const VERIFIED_MD = ['## Conversation', '| Modèle | Fiabilité |', '| --- | --- |', '| qwen3.5:4b | 6/6 |', '| qwen3.5:9b | 6/6 |'].join('\n')

test('previewVramSteps ne dérive que les frontières réellement connues (pas un chiffre arbitraire)', async () => {
  const { previewHardwareTiers } = setup({ verifiedToolScoresMd: VERIFIED_MD, vramMib: 20 * 1024 })
  const tiers = await previewHardwareTiers()
  assert.equal(tiers.length, 2)
  // 3,4 Go (poids du modèle) + 4,5 Go (STT_RESERVED_GB) = 7,9 Go de VRAM TOTALE minimale.
  assert.ok(Math.abs(tiers[0].vramGb - 7.9) < 1e-9, `attendu ~7.9, reçu ${tiers[0].vramGb}`)
  assert.ok(Math.abs(tiers[1].vramGb - 11.1) < 1e-9, `attendu ~11.1, reçu ${tiers[1].vramGb}`)
})

test('deux VRAM TOTALES dans le même intervalle obtiennent garanti le même modèle Médium', async () => {
  // 8 Go et 10 Go tombent tous deux entre les frontières 7,9 et 11,1 Go : les deux machines doivent recevoir
  // EXACTEMENT le même modèle Médium (qwen3.5:4b), pas un choix qui varie avec l'écart de VRAM entre elles.
  const { pickBestModelsFromBenchmark: pick8 } = setup({ verifiedToolScoresMd: VERIFIED_MD, vramMib: 8 * 1024 })
  const { pickBestModelsFromBenchmark: pick10 } = setup({ verifiedToolScoresMd: VERIFIED_MD, vramMib: 10 * 1024 })
  const result8 = await pick8()
  const result10 = await pick10()
  assert.equal(result8.models.medium, 'qwen3.5:4b')
  assert.equal(result10.models.medium, 'qwen3.5:4b')
  assert.equal(result8.models.medium, result10.models.medium)
})

test('une VRAM au-delà de la 2e frontière obtient le modèle Médium suivant (qwen3.5:9b)', async () => {
  const { pickBestModelsFromBenchmark } = setup({ verifiedToolScoresMd: VERIFIED_MD, vramMib: 12 * 1024 })
  const result = await pickBestModelsFromBenchmark()
  assert.equal(result.models.medium, 'qwen3.5:9b')
})

test('"ta configuration" (current) coïncide avec la ligne fixe correspondante, jamais entre deux lignes', async () => {
  const { previewHardwareTiers } = setup({ verifiedToolScoresMd: VERIFIED_MD, vramMib: 9 * 1024 })
  const tiers = await previewHardwareTiers()
  const current = tiers.find((t) => t.current)
  assert.ok(current, 'une ligne doit être marquée "current"')
  // 9 Go de VRAM totale tombe dans l'intervalle [7.9, 11.1) : la ligne "current" doit être la première
  // (7.9 Go), pas la seconde — et son modèle Médium doit être identique à celui de cette ligne fixe.
  assert.ok(Math.abs(current.vramGb - 7.9) < 1e-9)
  assert.equal(current.medium.model, 'qwen3.5:4b')
})

// Léo, capture d'écran à l'appui : "regarde les palier tout le monde a les meme model pour les palier...
// pour le palier 4 par exemple" — plusieurs paliers consécutifs affichaient exactement les 5 mêmes modèles.
// Reproduit ici avec le cas le plus simple et le plus réel : qwen3.5:35b (24 Go, tolère de déborder sur la
// RAM — LARGE_RAM_OFFLOAD_MODELS) devient atteignable dès 0 Go de VRAM totale une fois assez de RAM
// disponible (24 - (40-4) + 4,5 = -7,5, plafonné à 0) ; qwen3.5:0.8b (1 Go, Rapide ET Médium) devient
// RÉELLEMENT atteignable à 5,5 Go (1,0+4,5) — mais ni l'un ni l'autre ne change ce qui s'affiche : Puissant
// montre déjà qwen3.5:35b dès 0 Go, et Rapide/Médium montrent déjà qwen3.5:0.8b par repli ("aucun candidat
// ne rentre encore") AVANT MÊME sa propre frontière réelle. Les 2 frontières (0 et 5,5) sont réelles et
// distinctes, mais les 5 modèles affichés sont RIGOUREUSEMENT identiques sur les deux paliers : un seul doit
// rester à l'écran, pas deux.
const VERIFIED_MD_DUP = ['## Conversation', '| Modèle | Fiabilité |', '| --- | --- |', '| qwen3.5:35b | 6/6 |', '| qwen3.5:0.8b | 6/6 |'].join(
  '\n'
)

test('deux frontières réelles mais un résultat identique se fusionnent en un seul palier', async () => {
  const { previewHardwareTiers } = setup({ verifiedToolScoresMd: VERIFIED_MD_DUP, vramMib: 0, ramGb: 40 })
  const tiers = await previewHardwareTiers()
  assert.equal(tiers.length, 1, `paliers identiques non fusionnés : ${JSON.stringify(tiers.map((t) => t.vramGb))}`)
  assert.ok(Math.abs(tiers[0].vramGb - 0) < 1e-9)
  assert.equal(tiers[0].large.model, 'qwen3.5:35b')
  assert.equal(tiers[0].medium.model, 'qwen3.5:0.8b')
  assert.equal(tiers[0].flash.model, 'qwen3.5:0.8b')
  assert.ok(tiers[0].current, 'le seul palier restant doit rester marqué "ta configuration"')
})
