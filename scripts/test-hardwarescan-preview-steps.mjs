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
 *
 * Étape 135, Léo (deux fois de suite, la première réponse n'avait pas compris la vraie demande) : "je veut
 * que les models soit pareil pour le palier 1, je veut pas des model différent entre un palier 1 et un
 * palier 1" — le tableau lui-même utilise maintenant une RAM de RÉFÉRENCE FIXE (RESOURCE_SAFETY_MARGIN_GB),
 * jamais la vraie RAM de la machine qui regarde (voir le commentaire de previewHardwareTiers) : "Palier 1"
 * doit afficher exactement les mêmes 5 modèles sur n'importe quelle machine. `ramGb` dans `setup()` reste
 * utile pour les tests de `pickBestModelsFromBenchmark` plus bas (le chemin de TÉLÉCHARGEMENT réel, resté
 * volontairement adapté à la vraie RAM de chacun) — mais n'a plus AUCUN effet sur `previewHardwareTiers`.
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
    './ollama': { getModelInfo: async () => null, getInstalledModelSizeBytes: async () => null }
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
// Reproduit ici avec un cas RAM-INDÉPENDANT (depuis l'étape 135, previewHardwareTiers ne dépend plus de la
// RAM de la machine — voir le test dédié plus bas) : qwen3.5:0.8b (6/6) et qwen3.5:2b (5/6, score plus
// faible) ont chacun leur propre frontière VRAM réelle (5,5 et 7,2 Go), mais qwen3.5:0.8b GARDE la main sur
// les DEUX lignes (meilleur score l'emporte toujours sur qwen3.5:2b, même une fois ce dernier atteignable) —
// et aucun autre candidat (Vision/Code/Puissant, tous sans score connu ici, donc en repli constant) ne
// change entre ces deux frontières. Les 2 frontières sont réelles et distinctes, mais les 5 modèles affichés
// sont RIGOUREUSEMENT identiques sur les deux paliers : un seul doit rester à l'écran, pas deux.
const VERIFIED_MD_DUP = ['## Conversation', '| Modèle | Fiabilité |', '| --- | --- |', '| qwen3.5:0.8b | 6/6 |', '| qwen3.5:2b | 5/6 |'].join(
  '\n'
)

test('deux frontières réelles mais un résultat identique se fusionnent en un seul palier', async () => {
  const { previewHardwareTiers } = setup({ verifiedToolScoresMd: VERIFIED_MD_DUP, vramMib: 0 })
  const tiers = await previewHardwareTiers()
  assert.equal(tiers.length, 1, `paliers identiques non fusionnés : ${JSON.stringify(tiers.map((t) => t.vramGb))}`)
  // Garde la frontière du PREMIER palier du groupe fusionné (5,5 Go, celle de qwen3.5:0.8b), jamais 7,2.
  assert.ok(Math.abs(tiers[0].vramGb - 5.5) < 1e-9, `attendu ~5.5, reçu ${tiers[0].vramGb}`)
  assert.equal(tiers[0].flash.model, 'qwen3.5:0.8b')
  assert.equal(tiers[0].medium.model, 'qwen3.5:0.8b')
  assert.ok(tiers[0].current, 'le seul palier restant doit rester marqué "ta configuration"')
})

// Étape 135 : la VRAIE garantie que demande Léo. Deux machines identiques en VRAM mais TRÈS différentes en
// RAM (16 Go vs 64 Go) doivent voir EXACTEMENT le même tableau de paliers — y compris pour Puissant/Code,
// les deux seuls rôles qui ont le droit de déborder sur la RAM (LARGE_RAM_OFFLOAD_MODELS) : sans la RAM de
// référence fixe, une machine à 64 Go affichait un Puissant bien plus fort qu'une machine à 16 Go à VRAM
// identique — la vraie cause du "palier 1 différent d'un PC à l'autre" repérée par Léo.
const VERIFIED_MD_OFFLOAD = ['## Conversation', '| Modèle | Fiabilité |', '| --- | --- |', '| qwen3.5:35b | 6/6 |', '| qwen3.5:0.8b | 6/6 |'].join(
  '\n'
)

test("previewHardwareTiers ne dépend plus de la RAM de la machine qui regarde (étape 135)", async () => {
  const { previewHardwareTiers: withLittleRam } = setup({ verifiedToolScoresMd: VERIFIED_MD_OFFLOAD, vramMib: 0, ramGb: 16 })
  const { previewHardwareTiers: withLotsOfRam } = setup({ verifiedToolScoresMd: VERIFIED_MD_OFFLOAD, vramMib: 0, ramGb: 64 })
  const little = await withLittleRam()
  const lots = await withLotsOfRam()
  const project = (rows) => JSON.stringify(rows.map((t) => ({ vramGb: t.vramGb, flash: t.flash.model, medium: t.medium.model, large: t.large.model })))
  // `vm.runInNewContext` (setup(), plus haut) crée des objets d'un realm DIFFÉRENT de celui de ce test :
  // assert.deepEqual y échoue avec "Values have same structure but are not reference-equal" même sur un
  // contenu identique (piège déjà documenté ailleurs dans ce dépôt pour la même raison). Comparer des
  // chaînes JSON contourne le problème sans changer le mécanisme de chargement du module.
  assert.equal(project(little), project(lots), '16 Go et 64 Go de RAM doivent produire un tableau RIGOUREUSEMENT identique, y compris pour Puissant')
})
