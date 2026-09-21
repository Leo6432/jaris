import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * electron/services/benchmarkRunner.ts — runQuickSetup, le chemin RAPIDE de "Retester la configuration"
 * (Options → Modèles) et de l'écran d'accueil, quand verified-tool-scores.md connaît déjà le gagnant.
 *
 * Étape 133, Léo : "pour mon palier on a changer de model comment on fait ça me réinstalle pas les nouveaux
 * model direct et désinstalle l'ancien". Avant ce correctif, runQuickSetup téléchargeait bien les nouveaux
 * modèles choisis, mais ne supprimait JAMAIS les anciens qu'ils remplacent — contrairement à
 * runModelAnalysis (l'analyse comparative complète), qui a toujours eu ce nettoyage. Les tests ci-dessous
 * exercent runQuickSetup avec un `deleteModel`/`pullModelIfMissing` simulés (aucun vrai réseau, aucun vrai
 * Ollama) pour vérifier QUELS modèles sont réellement supprimés, sans jamais toucher au disque ou au réseau.
 */
function loadModule(relativePath, requireShim) {
  const source = ts.transpileModule(readFileSync(new URL(relativePath, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const exports = {}
  vm.runInThisContext(`(function (exports, module, require) { ${source} })`)(exports, { exports }, requireShim)
  return exports
}

/**
 * @param {{ flash: string, medium: string, large: string, visionModel: string, codeModel: string }} picked
 * @param {{ models?: any, visionModel?: string, codeModel?: string } | null} initialProfile
 * @param {Set<string>} [skippedRoles] rôles ('flash'/'medium'/'large'/'vision'/'code') dont le pull doit échouer
 *   avec ModelTooLargeError, pour simuler un modèle ignoré faute de VRAM/disque.
 */
function setup(picked, initialProfile, skippedRoles = new Set(), failDeleteFor = new Set()) {
  const deletedModels = []
  const pulledModels = []
  let profile = initialProfile ? { ...initialProfile } : null
  const lines = []

  const ollamaModule = {
    // Reproduit `instanceof` correctement : la classe elle-même doit être la même référence que celle
    // utilisée par benchmarkRunner.ts (importée du même module simulé), pas une classe recréée à part.
    ModelTooLargeError: class ModelTooLargeError extends Error {},
    DiskFullError: class DiskFullError extends Error {}
  }
  // pullModelIfMissing doit lever une VRAIE instance de ModelTooLargeError pour que le `catch` de
  // runQuickSetup (err instanceof ModelTooLargeError) la reconnaisse.
  ollamaModule.pullModelIfMissing = async (model) => {
    if (skippedRoles.has(model)) throw new ollamaModule.ModelTooLargeError(`${model} trop gros pour cette configuration`)
    pulledModels.push(model)
  }
  ollamaModule.deleteModel = async (model) => {
    if (failDeleteFor.has(model)) throw new Error(`Échec de la suppression de ${model} (Ollama a répondu 500)`)
    deletedModels.push(model)
  }

  const hardwareScanModule = {
    getAllCandidateModelIds: () => ['ignoré-dans-ce-test'],
    parseLocalBenchmark: () => ({ conversation: new Map(), vision: new Map(), code: new Map() }),
    pickBestModelsFromBenchmark: async () => ({
      gpuName: 'GPU de test',
      vramGb: 8,
      models: { flash: picked.flash, medium: picked.medium, large: picked.large },
      visionModel: picked.visionModel,
      codeModel: picked.codeModel
    })
  }

  const profileStoreModule = {
    getProfile: async () => profile,
    saveProfile: async (next) => {
      profile = next
    }
  }

  const { runQuickSetup } = loadModule('../electron/services/benchmarkRunner.ts', (id) => {
    if (id === 'child_process') return { spawn: () => { throw new Error('spawn ne doit jamais être appelé par runQuickSetup') } }
    if (id === 'path') return { join: (...parts) => parts.join('/') }
    if (id.endsWith('config')) return { config: {} }
    if (id === './ollama') return ollamaModule
    if (id === './hardwareScan') return hardwareScanModule
    if (id === './profileStore') return profileStoreModule
    if (id.endsWith('paths')) return { resourcesRoot: () => '.' }
    throw new Error(`module non simulé dans le test : ${id}`)
  })

  return {
    run: () => runQuickSetup((line) => lines.push(line)),
    deletedModels,
    pulledModels,
    lines,
    getProfile: () => profile
  }
}

test("un changement de palier supprime l'ancien modèle remplacé", async () => {
  const picked = { flash: 'hf.co/bartowski/ai9stars_G9v3-3B-GGUF', medium: 'qwen3.5:9b', large: 'qwen3.5:27b', visionModel: 'qwen3-vl:4b', codeModel: 'qwen2.5-coder:7b' }
  const before = {
    models: { flash: 'ministral-3:3b', medium: 'qwen3.5:9b', large: 'qwen3.5:27b' },
    visionModel: 'qwen3-vl:4b',
    codeModel: 'qwen2.5-coder:7b'
  }
  const t = setup(picked, before)
  await t.run()
  assert.deepEqual(t.deletedModels, ['ministral-3:3b'], `seul l'ancien modèle Rapide (remplacé) doit être supprimé : ${t.deletedModels.join(', ')}`)
  assert.equal(t.getProfile().models.flash, picked.flash, 'le profil doit refléter le nouveau choix')
})

test('un modèle encore utilisé par un autre rôle ne doit JAMAIS être supprimé', async () => {
  // qwen3.5:9b était Médium ET Puissant avant ce run (repli identique sur les deux rôles) ; le nouveau
  // choix Puissant change, mais qwen3.5:9b reste utilisé comme Médium : il ne doit pas disparaître du disque.
  const picked = { flash: 'ministral-3:3b', medium: 'qwen3.5:9b', large: 'qwen3.5:35b', visionModel: 'qwen3-vl:4b', codeModel: 'qwen2.5-coder:7b' }
  const before = {
    models: { flash: 'ministral-3:3b', medium: 'qwen3.5:9b', large: 'qwen3.5:9b' },
    visionModel: 'qwen3-vl:4b',
    codeModel: 'qwen2.5-coder:7b'
  }
  const t = setup(picked, before)
  await t.run()
  assert.deepEqual(t.deletedModels, [], `qwen3.5:9b est encore utilisé (Médium) : rien ne doit être supprimé, obtenu : ${t.deletedModels.join(', ')}`)
})

test("un nouveau modèle ignoré (trop gros) garde l'ancien modèle du rôle, jamais supprimé", async () => {
  const picked = { flash: 'ministral-3:3b', medium: 'qwen3.5:9b', large: 'qwen3.5:35b', visionModel: 'qwen3-vl:4b', codeModel: 'qwen2.5-coder:7b' }
  const before = {
    models: { flash: 'ministral-3:3b', medium: 'qwen3.5:9b', large: 'qwen3.5:27b' },
    visionModel: 'qwen3-vl:4b',
    codeModel: 'qwen2.5-coder:7b'
  }
  // qwen3.5:35b (le nouveau choix Puissant) ne rentre pas sur cette machine simulée.
  const t = setup(picked, before, new Set(['qwen3.5:35b']))
  const result = await t.run()
  assert.deepEqual(t.deletedModels, [], `l'ancien modèle Puissant (qwen3.5:27b) doit rester sur le disque puisque le nouveau a échoué : ${t.deletedModels.join(', ')}`)
  assert.equal(result.skippedModels?.[0]?.model, 'qwen3.5:35b')
})

test('aucun profil existant (tout premier lancement) : aucune tentative de suppression', async () => {
  const picked = { flash: 'ministral-3:3b', medium: 'qwen3.5:9b', large: 'qwen3.5:27b', visionModel: 'qwen3-vl:4b', codeModel: 'qwen2.5-coder:7b' }
  const t = setup(picked, null)
  await t.run()
  assert.deepEqual(t.deletedModels, [], 'rien à supprimer sans profil antérieur')
})

test('un échec de suppression est journalisé mais ne fait jamais échouer tout le run', async () => {
  const picked = { flash: 'hf.co/bartowski/ai9stars_G9v3-3B-GGUF', medium: 'qwen3.5:9b', large: 'qwen3.5:27b', visionModel: 'qwen3-vl:4b', codeModel: 'qwen2.5-coder:7b' }
  const before = {
    models: { flash: 'ministral-3:3b', medium: 'qwen3.5:9b', large: 'qwen3.5:27b' },
    visionModel: 'qwen3-vl:4b',
    codeModel: 'qwen2.5-coder:7b'
  }
  const t = setup(picked, before, new Set(), new Set(['ministral-3:3b']))
  const result = await t.run()
  assert.deepEqual(t.deletedModels, [], "deleteModel a échoué : l'ancien modèle n'apparaît pas dans la liste des VRAIMENT supprimés")
  assert.ok(
    t.lines.some((l) => l.includes('Échec de la suppression') && l.includes('ministral-3:3b')),
    `l'échec doit être journalisé lisiblement pour Léo : ${JSON.stringify(t.lines)}`
  )
  assert.equal(result.models?.flash ?? t.getProfile().models.flash, picked.flash, "le run continue normalement malgré l'échec de nettoyage")
})
