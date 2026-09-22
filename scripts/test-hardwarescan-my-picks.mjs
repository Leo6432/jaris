import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { promisify } from 'node:util'
import ts from 'typescript'

/**
 * Choix des modèles pour la machine RÉELLE (hardwareScan.ts).
 *
 * Étape 137, Léo : "a la place de plalier 1 2 3 on vas faire un palier personnaliser a chacun, il ya plus de
 * palier". Les paliers de comparaison (previewHardwareTiers/previewVramSteps) ont disparu : getMyModelPicks
 * renvoie, pour la VRAM ET la RAM détectées, le modèle choisi pour chaque rôle — le même calcul que ce qui
 * est téléchargé (pickBestModelsFromBenchmark). Ce fichier vérifie que les deux ne divergent jamais, que la
 * vraie RAM compte (un choix personnalisé, contrairement aux anciens paliers identiques pour tous), et que
 * deux machines de VRAM proche obtiennent le même modèle tant qu'aucun seuil réel ne les sépare.
 */
const nodeRequire = createRequire(import.meta.url)
const source = ts.transpileModule(readFileSync(new URL('../electron/services/hardwareScan.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

function setup({ verifiedToolScoresMd = '', vramMib, ramGb = 32, installed = null } = {}) {
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
    './ollama': {
      getModelInfo: async () => null,
      getInstalledModelSizeBytes: async () => null,
      // `null` = Ollama injoignable (la vérification ne doit alors rien prétendre).
      listInstalledModels: async () => {
        if (installed === null) throw new Error('Ollama injoignable')
        return installed
      }
    }
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
// hardwareScan.ts) : ils deviennent atteignables à 3,4+4,5=7,9 Go et 6,6+4,5=11,1 Go de VRAM totale
// (STT_RESERVED_GB=4,5 dans le vrai fichier).
const VERIFIED_MD = ['## Conversation', '| Modèle | Fiabilité |', '| --- | --- |', '| qwen3.5:4b | 6/6 |', '| qwen3.5:9b | 6/6 |'].join('\n')

test('deux VRAM TOTALES dans le même intervalle obtiennent garanti le même modèle Médium', async () => {
  const { pickBestModelsFromBenchmark: pick8 } = setup({ verifiedToolScoresMd: VERIFIED_MD, vramMib: 8 * 1024 })
  const { pickBestModelsFromBenchmark: pick10 } = setup({ verifiedToolScoresMd: VERIFIED_MD, vramMib: 10 * 1024 })
  const result8 = await pick8()
  const result10 = await pick10()
  assert.equal(result8.models.medium, 'qwen3.5:4b')
  assert.equal(result10.models.medium, 'qwen3.5:4b')
})

test('une VRAM au-delà du seuil suivant obtient le modèle Médium suivant (qwen3.5:9b)', async () => {
  const { pickBestModelsFromBenchmark } = setup({ verifiedToolScoresMd: VERIFIED_MD, vramMib: 12 * 1024 })
  const result = await pickBestModelsFromBenchmark()
  assert.equal(result.models.medium, 'qwen3.5:9b')
})

test('ce qui est affiché (getMyModelPicks) est exactement ce qui est téléchargé (pickBestModelsFromBenchmark)', async () => {
  for (const vramMib of [6 * 1024, 9 * 1024, 12 * 1024]) {
    const { getMyModelPicks, pickBestModelsFromBenchmark } = setup({ verifiedToolScoresMd: VERIFIED_MD, vramMib })
    const shown = await getMyModelPicks()
    const installed = await pickBestModelsFromBenchmark()
    assert.equal(shown.flash.model, installed.models.flash)
    assert.equal(shown.medium.model, installed.models.medium)
    assert.equal(shown.large.model, installed.models.large)
    assert.equal(shown.vision.model, installed.visionModel)
    assert.equal(shown.code.model, installed.codeModel)
  }
})

test('getMyModelPicks renvoie le matériel réellement détecté, jamais une valeur inventée', async () => {
  const { getMyModelPicks } = setup({ verifiedToolScoresMd: VERIFIED_MD, vramMib: 8 * 1024, ramGb: 32 })
  const picks = await getMyModelPicks()
  assert.equal(picks.gpuName, 'Fake GPU')
  assert.equal(picks.vramGb, 8)
  assert.equal(picks.ramGb, 32)
})

// Choix PERSONNALISÉ : contrairement aux anciens paliers (étape 135, RAM de référence fixe pour que "Palier
// 1" soit identique partout), la vraie RAM compte — Puissant a le droit de déborder sur la RAM
// (LARGE_RAM_OFFLOAD_MODELS), donc à VRAM égale, plus de RAM peut donner un Puissant plus fort.
const VERIFIED_MD_OFFLOAD = ['## Conversation', '| Modèle | Fiabilité |', '| --- | --- |', '| qwen3.5:35b | 6/6 |', '| qwen3.5:0.8b | 6/6 |'].join('\n')

test('la vraie RAM de la machine compte pour Puissant (choix personnalisé)', async () => {
  const { getMyModelPicks: littleRam } = setup({ verifiedToolScoresMd: VERIFIED_MD_OFFLOAD, vramMib: 8 * 1024, ramGb: 8 })
  const { getMyModelPicks: lotsOfRam } = setup({ verifiedToolScoresMd: VERIFIED_MD_OFFLOAD, vramMib: 8 * 1024, ramGb: 64 })
  assert.equal((await littleRam()).large.model, 'qwen3.5:0.8b', '8 Go de RAM : pas assez pour faire déborder un modèle de 24 Go')
  assert.equal((await lotsOfRam()).large.model, 'qwen3.5:35b', '64 Go de RAM : le gros modèle Puissant devient atteignable')
})

// Étape 138, Léo : "dans le palier rapide j'ai G9v3-3B mais il utilise pas G9v3-3B ça a rien telecharger".
// La carte affichait le modèle IDÉAL, pas celui du profil (celui que Jaris utilise vraiment).
test('la carte montre le modèle RÉELLEMENT utilisé (profil), et le meilleur à part s\'il diffère', async () => {
  const { getMyModelPicks } = setup({ verifiedToolScoresMd: VERIFIED_MD, vramMib: 12 * 1024 })
  const picks = await getMyModelPicks({ name: 'Léo', models: { flash: 'qwen3.5:4b', medium: 'qwen3.5:4b', large: 'qwen3.5:4b' } })
  assert.equal(picks.medium.model, 'qwen3.5:4b', 'la ligne Médium doit montrer le modèle utilisé, pas l\'idéal')
  assert.equal(picks.upgrades.medium?.model, 'qwen3.5:9b', 'le meilleur choix (qwen3.5:9b) doit être signalé à part')
  assert.equal(picks.upgrades.medium?.blockedReason, null, 'pas bloqué : il suffit de retester')
})

test('un meilleur modèle bloqué au téléchargement est signalé avec sa raison', async () => {
  const { getMyModelPicks } = setup({ verifiedToolScoresMd: VERIFIED_MD, vramMib: 12 * 1024 })
  const picks = await getMyModelPicks({
    name: 'Léo',
    models: { flash: 'qwen3.5:4b', medium: 'qwen3.5:4b', large: 'qwen3.5:4b' },
    blockedModels: { 'qwen3.5:9b': 'bloqué par ta version d\'Ollama' }
  })
  assert.equal(picks.upgrades.medium?.blockedReason, 'bloqué par ta version d\'Ollama')
})

test('sans profil (écran d\'accueil) ou profil déjà à jour : aucun meilleur choix signalé', async () => {
  const { getMyModelPicks } = setup({ verifiedToolScoresMd: VERIFIED_MD, vramMib: 12 * 1024 })
  const fresh = await getMyModelPicks()
  assert.equal(Object.keys(fresh.upgrades).length, 0)
  const upToDate = await getMyModelPicks({
    name: 'Léo',
    models: { flash: fresh.flash.model, medium: fresh.medium.model, large: fresh.large.model },
    visionModel: fresh.vision.model,
    codeModel: fresh.code.model
  })
  assert.equal(Object.keys(upToDate.upgrades).length, 0)
})

// Étape 140, Léo : "je veut etre sur que les model visbile sont réel et pas un autre model". La carte
// compare ce qu'elle affiche à la liste RÉELLE d'Ollama (/api/tags), au lieu de le supposer.
const PROFILE = { name: 'Léo', models: { flash: 'qwen3.5:4b', medium: 'qwen3.5:4b', large: 'qwen3.5:9b' }, visionModel: 'qwen3-vl:4b', codeModel: 'qwen2.5-coder:7b' }

test('tout est installé : aucun rôle signalé, et les modèles en trop sont listés', async () => {
  const { getMyModelPicks } = setup({
    verifiedToolScoresMd: VERIFIED_MD,
    vramMib: 12 * 1024,
    installed: ['qwen3.5:4b', 'qwen3.5:9b', 'qwen3-vl:4b', 'qwen2.5-coder:7b', 'ministral-3:3b', 'hf.co/bartowski/ai9stars_G9v3-3B-GGUF:latest']
  })
  const picks = await getMyModelPicks(PROFILE)
  assert.deepEqual([...picks.installCheck.notInstalled], [])
  assert.deepEqual([...picks.installCheck.otherInstalled], ['ministral-3:3b', 'hf.co/bartowski/ai9stars_G9v3-3B-GGUF:latest'])
})

test('un modèle affiché mais absent du disque est signalé', async () => {
  const { getMyModelPicks } = setup({ verifiedToolScoresMd: VERIFIED_MD, vramMib: 12 * 1024, installed: ['qwen3.5:4b', 'qwen3-vl:4b', 'qwen2.5-coder:7b'] })
  const picks = await getMyModelPicks(PROFILE)
  assert.deepEqual([...picks.installCheck.notInstalled], ['large'])
})

test('un modèle sans tag est reconnu sous son nom ":latest" (comme Ollama le liste)', async () => {
  const profile = { ...PROFILE, models: { ...PROFILE.models, flash: 'hf.co/bartowski/ai9stars_G9v3-3B-GGUF' } }
  const { getMyModelPicks } = setup({
    verifiedToolScoresMd: VERIFIED_MD,
    vramMib: 12 * 1024,
    installed: ['hf.co/bartowski/ai9stars_G9v3-3B-GGUF:latest', 'qwen3.5:4b', 'qwen3.5:9b', 'qwen3-vl:4b', 'qwen2.5-coder:7b']
  })
  const picks = await getMyModelPicks(profile)
  assert.deepEqual([...picks.installCheck.notInstalled], [])
  assert.deepEqual([...picks.installCheck.otherInstalled], [])
})

test("Ollama injoignable : la vérification ne prétend rien (null), jamais \"tout est installé\"", async () => {
  const { getMyModelPicks } = setup({ verifiedToolScoresMd: VERIFIED_MD, vramMib: 12 * 1024, installed: null })
  const picks = await getMyModelPicks(PROFILE)
  assert.equal(picks.installCheck, null)
})

test("seul un modèle installé ET inutilisé peut être supprimé", async () => {
  const { isUnusedInstalledModel } = setup({ verifiedToolScoresMd: VERIFIED_MD, vramMib: 12 * 1024, installed: ['qwen3.5:4b', 'qwen3.5:9b', 'ministral-3:3b'] })
  assert.equal(await isUnusedInstalledModel('ministral-3:3b', PROFILE), true)
  assert.equal(await isUnusedInstalledModel('qwen3.5:4b', PROFILE), false, 'utilisé par Rapide/Médium : jamais supprimable')
  assert.equal(await isUnusedInstalledModel('llama3:8b', PROFILE), false, 'pas installé : rien à supprimer')
})
