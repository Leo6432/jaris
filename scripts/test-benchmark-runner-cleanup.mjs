import { withI18n } from './i18n-test-module.mjs'
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
 * modèles choisis, mais ne supprimait JAMAIS les anciens qu'ils remplacent. Les tests ci-dessous
 * exercent runQuickSetup avec un `deleteModel`/`pullModelIfMissing` simulés (aucun vrai réseau, aucun vrai
 * Ollama) pour vérifier QUELS modèles sont réellement supprimés, sans jamais toucher au disque ou au réseau.
 */
import realZlib from 'node:zlib'
const writtenAtomic = []

// Étape 437 : la machine louée connectée (aucune par défaut ; un test la connecte pour vérifier où part l'analyse).
let connectedForTest = null
const remoteMachineModule = { connectedMachine: () => connectedForTest, MACHINE_DISK_RESERVED_GB: 10 }

function loadModule(relativePath, requireShim) {
  const source = ts.transpileModule(readFileSync(new URL(relativePath, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const exports = {}
  vm.runInThisContext(`(function (exports, module, require) { ${source} })`)(exports, { exports }, withI18n(requireShim))
  return exports
}

/**
 * @param {{ flash: string, medium: string, large: string, visionModel: string, codeModel: string }} picked
 * @param {{ models?: any, visionModel?: string, codeModel?: string } | null} initialProfile
 * @param {Set<string>} [skippedRoles] rôles ('flash'/'medium'/'large'/'vision'/'code') dont le pull doit échouer
 *   avec ModelTooLargeError, pour simuler un modèle ignoré faute de VRAM/disque.
 */
function setup(picked, initialProfile, skippedRoles = new Set(), failDeleteFor = new Set(), { pullErrorFor = new Set(), repick, vramGb = 8, ramGb = 32, imageInstallError = null, videoInstalled = false, whileDeleting } = {}) {
  const imageInstalls = []
  const videoChecks = []
  // Le 3e argument de pullModelIfMissing (avancement du téléchargement, pour la barre de l'écran de configuration).
  const progressListeners = []
  const deletedModels = []
  const pulledModels = []
  const pickCalls = []
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
  ollamaModule.pullModelIfMissing = async (model, _onStatus, onProgress) => {
    progressListeners.push(onProgress)
    if (skippedRoles.has(model)) throw new ollamaModule.ModelTooLargeError(`${model} trop gros pour cette configuration`)
    // Reproduit l'erreur réelle d'Ollama 0.34.2 sur un import Hugging Face (github.com/ollama/ollama/issues/18526).
    if (pullErrorFor.has(model)) throw new Error('pull model manifest: blocked redirect to a different host')
    pulledModels.push(model)
  }
  ollamaModule.deleteModel = async (model) => {
    if (failDeleteFor.has(model)) throw new Error(`Échec de la suppression de ${model} (Ollama a répondu 500)`)
    deletedModels.push(model)
    // Pendant ce temps, Léo change un réglage ailleurs (Options, micro…) : écrit dans le profil, comme le vrai.
    if (whileDeleting && profile) profile = { ...profile, ...whileDeleting(profile) }
  }

  const hardwareScanModule = {
    getAllCandidateModelIds: () => ['ignoré-dans-ce-test'],
    pickBestModelsFromBenchmark: async (exclude = new Set()) => {
      pickCalls.push([...exclude])
      const p = exclude.size && repick ? repick(exclude) : picked
      return {
        gpuName: 'GPU de test',
        vramGb,
        models: { flash: p.flash, medium: p.medium, large: p.large },
        visionModel: p.visionModel,
        codeModel: p.codeModel
      }
    }
  }

  // Comme le vrai profileStore.ts : patchProfile change seulement les champs donnés, sur le profil relu à ce moment-là.
  const profileStoreModule = {
    getProfile: async () => profile,
    saveProfile: async (next) => {
      profile = next
    },
    patchProfile: async (change) => {
      if (!profile) return null
      profile = { ...profile, ...(typeof change === 'function' ? change(profile) : change) }
      return profile
    }
  }

  const { runQuickSetup } = loadModule('../electron/services/benchmarkRunner.ts', (id) => {
    if (id === 'child_process') return { spawn: () => { throw new Error('spawn ne doit jamais être appelé par runQuickSetup') } }
    if (id === 'zlib') return realZlib
    if (id === './atomicFile') return { writeFileAtomic: async (file, content) => writtenAtomic.push([file, content]) }
    if (id === 'fs') return { readFileSync: () => { throw new Error('ENOENT') } }
    if (id === 'path') return { join: (...parts) => parts.join('/') }
    if (id.endsWith('config')) return { config: {}, runWithLocalOllama: (fn) => fn() }
    if (id === './remoteMachine') return remoteMachineModule
    if (id === './ollama') return ollamaModule
    if (id === './hardwareScan') return hardwareScanModule
    if (id === './profileStore') return profileStoreModule
    if (id.endsWith('paths')) return { resourcesRoot: () => '.' }
    if (id === './dataLocation') return { getDataRoot: () => '/fake/data' }
    // Étape 175 : le modèle d'image s'installe dans le même passage que les modèles Ollama.
    if (id === './imageGenerator') {
      return {
        installImageModel: async () => {
          imageInstalls.push('FLUX.2 klein 4B')
          if (imageInstallError) throw new Error(imageInstallError)
        }
      }
    }
    if (id === './systemResources') return { detectRamGb: () => ramGb }
    if (id === 'electron') return { app: { getVersion: () => '0.0.0-test' } }
    if (id === '../../shared/imageModel') return loadModule('../shared/imageModel.ts', () => ({}))
    if (id === '../../shared/pilotModel') return loadModule('../shared/pilotModel.ts', () => ({}))
    // Le modèle vidéo du résumé de fin : même décision (pickVideoModel) que la carte des modèles.
    if (id === '../../shared/videoModel') return loadModule('../shared/videoModel.ts', () => ({}))
    if (id === './videoGenerator') {
      return {
        isVideoQualityInstalled: async (quality) => {
          videoChecks.push(quality)
          return videoInstalled
        }
      }
    }
    throw new Error(`module non simulé dans le test : ${id}`)
  })

  return {
    run: (onProgress) => runQuickSetup((line) => lines.push(line), onProgress),
    videoChecks,
    progressListeners,
    deletedModels,
    pulledModels,
    pickCalls,
    lines,
    imageInstalls,
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

// Relecture croisée : la configuration lisait le profil, téléchargeait et supprimait des modèles (plusieurs minutes),
// puis réécrivait le profil ENTIER lu au début : un micro choisi entre-temps revenait à l'ancien.
test('un réglage changé pendant la configuration n’est pas effacé par elle', async () => {
  const picked = { flash: 'qwen3.5:4b', medium: 'qwen3.5:9b', large: 'qwen3.5:27b', visionModel: 'qwen3-vl:4b', codeModel: 'qwen2.5-coder:7b' }
  const before = {
    name: 'Léo',
    models: { flash: 'ministral-3:3b', medium: 'qwen3.5:9b', large: 'qwen3.5:27b' },
    visionModel: 'qwen3-vl:4b',
    codeModel: 'qwen2.5-coder:7b',
    audioInputDeviceName: 'Micro intégré',
    blockedModels: { 'vieux:1b': 'bloqué' }
  }
  const t = setup(picked, before, new Set(), new Set(), {
    whileDeleting: (current) => ({ audioInputDeviceName: 'Micro USB', blockedModels: { ...current.blockedModels, 'autre:2b': 'bloqué aussi' } })
  })
  await t.run()
  assert.deepEqual(t.deletedModels, ['ministral-3:3b'])
  assert.equal(t.getProfile().audioInputDeviceName, 'Micro USB', 'le micro choisi pendant la configuration a été effacé')
  assert.deepEqual(Object.keys(t.getProfile().blockedModels).sort(), ['autre:2b', 'vieux:1b'])
  assert.equal(t.getProfile().models.flash, 'qwen3.5:4b')
  assert.equal(t.getProfile().capacityScanDone, true)
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

test('étape 346 : un modèle trop gros est remplacé par le meilleur suivant, et le profil ne garde jamais un modèle absent', async () => {
  const picked = { flash: 'ministral-3:3b', medium: 'qwen3.5:9b', large: 'qwen3.5:35b', visionModel: 'qwen3-vl:4b', codeModel: 'qwen2.5-coder:7b' }
  const before = { models: { flash: 'ministral-3:3b', medium: 'qwen3.5:9b', large: 'qwen3.5:27b' }, visionModel: 'qwen3-vl:4b', codeModel: 'qwen2.5-coder:7b' }
  const repick = (exclude) => ({ ...picked, large: exclude.has('qwen3.5:35b') ? 'granite4.2:30b' : picked.large })
  const t = setup(picked, before, new Set(['qwen3.5:35b']), new Set(), { repick })
  await t.run()
  assert.deepEqual(t.pickCalls.at(-1), ['qwen3.5:35b'], 'le modèle trop gros est écarté du nouveau choix')
  assert.ok(t.pulledModels.includes('granite4.2:30b'), 'le remplaçant est téléchargé')
  assert.equal(t.getProfile().models.large, 'granite4.2:30b')

  // Pas de remplaçant possible : le profil garde l'ancien modèle du rôle, celui qui est réellement installé.
  const stuck = setup(picked, before, new Set(['qwen3.5:35b']))
  await stuck.run()
  assert.equal(stuck.getProfile().models.large, 'qwen3.5:27b', 'jamais un modèle choisi mais absent du disque')
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

// Étape 136 : bug Ollama 0.34.2 ("blocked redirect to a different host") sur tout import hf.co/. Avant, cette
// erreur faisait échouer TOUT « Retester la configuration » dès que G9v3-3B était choisi.
const G9 = 'hf.co/bartowski/ai9stars_G9v3-3B-GGUF'
const GLM = 'hf.co/ggml-org/GLM-4.6V-Flash-GGUF:Q4_K_M'

test('un import Hugging Face qui échoue retombe sur le meilleur modèle suivant, sans faire échouer le retest', async () => {
  const picked = { flash: G9, medium: G9, large: 'qwen3.8:27b', visionModel: GLM, codeModel: 'qwen2.5-coder:7b' }
  const before = { models: { flash: 'ministral-3:3b', medium: 'qwen3.5:4b', large: 'qwen3.8:27b' }, visionModel: 'qwen3-vl:4b', codeModel: 'qwen2.5-coder:7b' }
  const repick = (exclude) => ({
    flash: exclude.has(G9) ? 'ministral-3:3b' : G9,
    medium: exclude.has(G9) ? 'qwen3.5:4b' : G9,
    large: 'qwen3.8:27b',
    visionModel: exclude.has(GLM) ? 'qwen3-vl:4b' : GLM,
    codeModel: 'qwen2.5-coder:7b'
  })
  const t = setup(picked, before, new Set(), new Set(), { pullErrorFor: new Set([G9, GLM]), repick })
  const result = await t.run()
  assert.deepEqual([...t.pickCalls.at(-1)].sort(), [G9, GLM].sort(), 'le nouveau choix doit exclure les deux imports en échec')
  assert.equal(result.models.flash, 'ministral-3:3b')
  assert.equal(result.visionModel, 'qwen3-vl:4b')
  assert.equal(t.getProfile().models.flash, 'ministral-3:3b', "le profil ne doit jamais enregistrer un modèle jamais téléchargé")
  assert.deepEqual(t.deletedModels, [], "aucun ancien modèle supprimé : les modèles de repli sont ceux déjà en place")
  assert.ok(t.lines.some((l) => l.includes('bug connu') && l.includes('Ollama')), `l'échec doit être expliqué à Léo : ${JSON.stringify(t.lines)}`)
})

test("une erreur sur un tag de la bibliothèque Ollama n'est JAMAIS masquée par le repli", async () => {
  const picked = { flash: 'ministral-3:3b', medium: 'qwen3.5:4b', large: 'qwen3.8:27b', visionModel: 'qwen3-vl:4b', codeModel: 'qwen2.5-coder:7b' }
  const t = setup(picked, null, new Set(), new Set(), { pullErrorFor: new Set(['qwen3.5:4b']) })
  await assert.rejects(t.run(), /blocked redirect/)
})

// Étape 138 : le blocage doit être MÉMORISÉ (pour que la carte d'Options l'explique) et oublié dès que le
// même modèle finit par se télécharger (Ollama corrigé).
test('un import Hugging Face bloqué est mémorisé dans le profil, puis oublié quand il se télécharge', async () => {
  const picked = { flash: G9, medium: 'qwen3.5:4b', large: 'qwen3.8:27b', visionModel: 'qwen3-vl:4b', codeModel: 'qwen2.5-coder:7b' }
  const before = { models: { flash: 'ministral-3:3b', medium: 'qwen3.5:4b', large: 'qwen3.8:27b' }, visionModel: 'qwen3-vl:4b', codeModel: 'qwen2.5-coder:7b' }
  const repick = () => ({ ...picked, flash: 'ministral-3:3b' })
  const blocked = setup(picked, before, new Set(), new Set(), { pullErrorFor: new Set([G9]), repick })
  const result = await blocked.run()
  assert.equal(result.blockedModels?.[0]?.model, G9, 'le résultat doit remonter le modèle bloqué')
  assert.match(blocked.getProfile().blockedModels?.[G9] ?? '', /Ollama/, 'la raison doit être mémorisée dans le profil')

  const later = setup(picked, blocked.getProfile())
  await later.run()
  assert.equal(later.getProfile().blockedModels?.[G9], undefined, 'une fois téléchargé, le blocage doit être oublié')
  assert.equal(later.getProfile().models.flash, G9)
})

test('étape 141 : un modèle choisi à la main dans Chat/Code/Vocal n’est jamais supprimé par le retest', async () => {
  const picked = { flash: 'hf.co/bartowski/ai9stars_G9v3-3B-GGUF', medium: 'qwen3.5:9b', large: 'qwen3.5:27b', visionModel: 'qwen3-vl:4b', codeModel: 'qwen2.5-coder:7b' }
  const before = {
    models: { flash: 'ministral-3:3b', medium: 'qwen3.5:9b', large: 'qwen3.5:27b' },
    visionModel: 'qwen3-vl:4b',
    codeModel: 'qwen2.5-coder:7b',
    modelChoices: { voice: 'ministral-3:3b' }
  }
  const t = setup(picked, before)
  await t.run()
  assert.deepEqual(t.deletedModels, [], `ministral-3:3b est choisi à la main pour la voix : obtenu ${t.deletedModels.join(', ')}`)
  assert.equal(t.getProfile().modelChoices?.voice, 'ministral-3:3b', 'le choix à la main survit au retest')
})

// --- Étape 175 : le modèle d'image s'installe ICI (page Modèles / écran d'accueil), jamais au premier dessin ---

const IMAGE_PICKED = { flash: 'a', medium: 'b', large: 'c', visionModel: 'v', codeModel: 'k' }

test('machine assez puissante : le modèle d’image est installé avec les autres, et annoncé dans le résultat', async () => {
  const t = setup(IMAGE_PICKED, null)
  const result = await t.run()
  assert.deepEqual(t.imageInstalls, ['FLUX.2 klein 4B'])
  assert.equal(result.image.model, 'FLUX.2 klein 4B')
  assert.equal(result.image.installed, true)
})

test('pas assez de puissance : rien n’est téléchargé, « aucun modèle » avec la raison', async () => {
  const t = setup(IMAGE_PICKED, null, new Set(), new Set(), { vramGb: 4 })
  const result = await t.run()
  assert.deepEqual(t.imageInstalls, [])
  assert.equal(result.image.model, null)
  assert.match(t.lines.join('\n'), /Pas de modèle d'image : carte graphique trop petite/)
})

test('échec du modèle d’image : les autres modèles restent configurés, l’erreur est rapportée telle quelle', async () => {
  const t = setup(IMAGE_PICKED, { models: {} }, new Set(), new Set(), { imageInstallError: 'Pas assez de place sur le disque.' })
  const result = await t.run()
  // Étape 231 : la carte de 8 Go du test reçoit aussi le modèle de pilotage d'écran.
  assert.deepEqual(t.pulledModels.sort(), ['a', 'b', 'c', PILOT, 'k', 'v'].sort())
  assert.equal(t.getProfile().capacityScanDone, true)
  assert.equal(result.image.installed, false)
  assert.equal(result.image.error, 'Pas assez de place sur le disque.')
})

// --- Étape 231 : le modèle de pilotage d'écran, « comme image vidéo », seulement si la carte le fait tourner ---

const PILOT = 'hf.co/mradermacher/MAI-UI-8B-GGUF:Q4_K_M'
const OLD_PILOT = 'hf.co/mradermacher/UI-TARS-1.5-7B-GGUF:Q4_K_M'

test('étape 251 : un PC qui avait UI-TARS reçoit MAI-UI, et UI-TARS est supprimé avec la bonne raison', async () => {
  const t = setup(IMAGE_PICKED, { models: {}, pilotModel: OLD_PILOT })
  await t.run()
  assert.ok(t.pulledModels.includes(PILOT))
  assert.equal(t.getProfile().pilotModel, PILOT)
  assert.ok(t.deletedModels.includes(OLD_PILOT))
  assert.match(t.lines.join('\n'), /Ancien modèle de pilotage d'écran hf\.co\/mradermacher\/UI-TARS-1\.5-7B-GGUF:Q4_K_M supprimé \(remplacé par MAI-UI 8B\)/)
})

test('carte de 8 Go : le modèle de pilotage est installé et enregistré comme rôle', async () => {
  const t = setup(IMAGE_PICKED, { models: {} })
  const result = await t.run()
  assert.ok(t.pulledModels.includes(PILOT))
  assert.equal(t.getProfile().pilotModel, PILOT)
  assert.equal(result.pilot.installed, true)
})

test('carte trop petite : pas de rôle, rien téléchargé, et un ancien modèle de pilotage est supprimé', async () => {
  const t = setup(IMAGE_PICKED, { models: {}, pilotModel: PILOT }, new Set(), new Set(), { vramGb: 6 })
  const result = await t.run()
  assert.ok(!t.pulledModels.includes(PILOT))
  assert.equal(t.getProfile().pilotModel, undefined)
  assert.equal(result.pilot.model, null)
  assert.ok(t.deletedModels.includes(PILOT))
  assert.match(t.lines.join('\n'), /Pas de modèle de pilotage d'écran : carte graphique trop petite.*modèle de vision pilote/i)
})

test('téléchargement raté : le reste est configuré, l’ancien modèle de pilotage est gardé et jamais supprimé', async () => {
  const t = setup(IMAGE_PICKED, { models: {}, pilotModel: PILOT }, new Set(), new Set(), { pullErrorFor: new Set([PILOT]) })
  const result = await t.run()
  assert.equal(t.getProfile().capacityScanDone, true)
  assert.equal(t.getProfile().pilotModel, PILOT)
  assert.ok(!t.deletedModels.includes(PILOT))
  assert.equal(result.pilot.installed, false)
  assert.match(result.pilot.error, /blocked redirect/)
})

// Écran « Configuration terminée » : le résumé oubliait la ligne Vidéo. Même décision que la carte des modèles
// (pickVideoModel), jamais téléchargé pendant la configuration — le résultat dit s'il est déjà là.
test('le résultat donne le modèle vidéo choisi pour la machine, et s’il est déjà téléchargé', async () => {
  const t = setup(IMAGE_PICKED, { models: {} })
  const result = await t.run()
  assert.equal(result.video.model, 'FastWan 2.2 TI2V 5B')
  assert.equal(result.video.quality, 'q6', '8 Go de carte et 32 Go de RAM : la qualité Moyen')
  assert.equal(result.video.installed, false)
  assert.deepEqual(t.videoChecks, ['q6'])
  assert.ok(!t.pulledModels.some((m) => /wan/i.test(m)), 'le modèle vidéo ne se télécharge jamais pendant la configuration')

  const installed = await setup(IMAGE_PICKED, { models: {} }, new Set(), new Set(), { videoInstalled: true }).run()
  assert.equal(installed.video.installed, true)
})

test('carte trop petite pour la vidéo : aucun modèle, avec la raison, sans rien vérifier sur le disque', async () => {
  const t = setup(IMAGE_PICKED, { models: {} }, new Set(), new Set(), { vramGb: 6 })
  const result = await t.run()
  assert.equal(result.video.model, null)
  assert.ok(result.video.reason, 'la raison est donnée')
  assert.deepEqual(t.videoChecks, [])
})

test('l’avancement des téléchargements est transmis à chaque modèle (barre de l’écran de configuration)', async () => {
  const t = setup(IMAGE_PICKED, { models: {} })
  const onProgress = () => {}
  await t.run(onProgress)
  assert.ok(t.progressListeners.length >= 6, `modèles des rôles + pilotage : ${t.progressListeners.length}`)
  assert.ok(t.progressListeners.every((listener) => listener === onProgress))
})

// Étape 236 : le test de modèles dure 1,5 à 3 jours sans surveillance. Sans blocage, la veille de Windows le
// suspendait ; au réveil, une requête coupée passait pour un modèle figé ou un Ollama arrêté.
test('le PC ne se met pas en veille pendant le test de modèles, et seulement pendant', async () => {
  const { EventEmitter } = await import('node:events')
  const events = []
  let started = 0
  const active = new Set()
  const powerSaveBlocker = {
    start: (type) => {
      events.push(`start ${type}`)
      active.add(++started)
      return started
    },
    isStarted: (id) => active.has(id),
    stop: (id) => {
      events.push('stop')
      active.delete(id)
    }
  }
  const procs = []
  const fakeSpawn = (_command, _args, options) => {
    const proc = new EventEmitter()
    proc.env = options?.env ?? {}
    proc.stdout = Object.assign(new EventEmitter(), { setEncoding() {} })
    proc.stderr = Object.assign(new EventEmitter(), { setEncoding() {} })
    proc.kill = () => proc.emit('close', null)
    procs.push(proc)
    return proc
  }
  const { testUnscoredModels, stopModelTest, stopModelTestByUser, runQuickSetup } = loadModule('../electron/services/benchmarkRunner.ts', (id) => {
    if (id === 'child_process') return { spawn: fakeSpawn }
    if (id === 'zlib') return realZlib
    if (id === './atomicFile') return { writeFileAtomic: async (file, content) => writtenAtomic.push([file, content]) }
    if (id === 'path') return { join: (...parts) => parts.join('/') }
    if (id.endsWith('config')) return { config: { ollama: { host: 'http://10.0.0.5:11434', localHost: 'http://127.0.0.1:11434' } }, runWithLocalOllama: (fn) => { events.push('local-scope'); return fn() } }
    if (id === './remoteMachine') return remoteMachineModule
    if (id === './ollama')
      return {
        ModelTooLargeError: class extends Error {},
        DiskFullError: class extends Error {},
        // Étape 313 : la vue d'Ollama est vérifiée AVANT le lancement du script.
        repairModelsViewIfNeeded: async () => {
          events.push(`repair (${procs.length} lancé)`)
          return false
        }
      }
    if (id === './hardwareScan') return { getUnscoredModels: () => ['qwen3.5:9b', 'granite4.2:8b'], describeModelsToTest: () => [{ model: 'qwen3.5:9b', needs: [{ test: 'tools', reason: 'missing' }] }], campaignCompletion: () => ({ scenarios: new Set(), vision: new Set(), code: new Set() }) }
    if (id === 'fs') return { readFileSync: () => { throw new Error('ENOENT') } }
    if (id === './profileStore') return {}
    if (id.endsWith('paths')) return { resourcesRoot: () => '.' }
    if (id === './dataLocation') return { getDataRoot: () => '/fake/data' }
    if (id === './imageGenerator') return {}
    if (id === './systemResources') return {}
    if (id === 'electron') return { app: { getVersion: () => '0.0.0-test' }, powerSaveBlocker }
    if (id === '../../shared/imageModel' || id === '../../shared/pilotModel' || id === '../../shared/videoModel') return {}
    if (id === './videoGenerator') return {}
    throw new Error(`module non simulé dans le test : ${id}`)
  })

  // Test terminé normalement : veille bloquée pendant, rétablie à la fin.
  const done = testUnscoredModels(() => {})
  // Un second clic pendant la vérification d'Ollama ne lance pas un second test.
  await assert.rejects(testUnscoredModels(() => {}))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(events, ['repair (0 lancé)', 'start prevent-app-suspension'])
  procs[0].emit('close', 0)
  await done
  assert.deepEqual(events, ['repair (0 lancé)', 'start prevent-app-suspension', 'stop'])
  assert.equal(active.size, 0)

  // Test arrêté (Jaris fermé) : la veille est rétablie aussi.
  const stopped = testUnscoredModels(() => {}).catch(() => {})
  await new Promise((resolve) => setImmediate(resolve))
  stopModelTest()
  await stopped
  assert.equal(active.size, 0, 'aucun blocage ne doit survivre au test')
  assert.equal(events.filter((e) => e === 'stop').length, 2)

  // Étape 441 (Léo : « ajoute pouvoir arrêter les tests, là je dois quitter l'application ») : le bouton finit le test
  // sur « arrêté » (pas une panne), la veille est rétablie ; demandé pendant la vérification d'Ollama, rien ne démarre.
  // Relecture croisée : « arrêté » est un champ du résultat, plus une phrase traduite que l'écran comparait à la sienne
  // (la langue changée entre-temps, l'arrêt s'affichait comme une panne).
  const byUser = testUnscoredModels(() => {})
  await new Promise((resolve) => setImmediate(resolve))
  const launched = procs.length
  await stopModelTestByUser()
  const stoppedResult = await byUser
  assert.equal(stoppedResult.stopped, true, 'arrêté par le bouton : le résultat le dit, sans passer par une phrase')
  assert.equal(stoppedResult.resultsPath, '/fake/data/benchmark-nouveaux-modeles.md')
  assert.equal(active.size, 0)
  const early = testUnscoredModels(() => {})
  await stopModelTestByUser()
  assert.equal((await early).stopped, true)
  assert.equal(procs.length, launched, 'arrêté avant le lancement : le script ne démarre pas')
  await stopModelTestByUser() // plus rien à arrêter : sans effet
  // Le test suivant n'hérite pas de l'arrêt : il se termine normalement.
  const after = testUnscoredModels(() => {})
  await new Promise((resolve) => setImmediate(resolve))
  procs.at(-1).emit('close', 0)
  assert.equal((await after).stopped, undefined, 'un test fini normalement n’est pas « arrêté »')

  // « Déplacer » copie puis efface les résultats du test juste après l'avoir arrêté : l'arrêt attend sa vraie sortie.
  const third = testUnscoredModels(() => {}).catch(() => {})
  await new Promise((resolve) => setImmediate(resolve))
  const slow = procs.at(-1)
  let exited = false
  slow.kill = () =>
    setTimeout(() => {
      exited = true
      slow.emit('close', null)
    }, 30)
  await stopModelTest()
  assert.equal(exited, true, 'stopModelTest() doit attendre que le test soit vraiment sorti')
  await third

  // Étape 436 : « Tout tester » envoie tous les modèles à tester ; « Choisir » seulement ceux cochés — et jamais un nom
  // venu de l'écran qui n'est pas à tester.
  assert.equal(procs[0].env.JARIS_ONLY_MODELS, 'qwen3.5:9b,granite4.2:8b')
  const chosen = testUnscoredModels(() => {}, ['granite4.2:8b', 'inconnu:1b'])
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(procs.at(-1).env.JARIS_ONLY_MODELS, 'granite4.2:8b')
  procs.at(-1).emit('close', 0)
  assert.deepEqual((await chosen).models, ['granite4.2:8b'])
  const before = procs.length
  assert.deepEqual((await testUnscoredModels(() => {}, ['inconnu:1b'])).models, [], 'rien de valable : rien n’est lancé')
  assert.equal(procs.length, before)

  // Étape 437 : machine louée connectée — le test lui donne sa mémoire et son disque, et ne répare jamais le dossier de
  // modèles de CE PC (réparation inutile, et sur le mauvais Ollama).
  connectedForTest = { host: 'http://10.0.0.5:11434', vramGb: 80, ramGb: 64, diskGb: 100 }
  try {
    const repairsBefore = events.filter((e) => e.startsWith('repair')).length
    const onMachine = testUnscoredModels(() => {})
    await new Promise((resolve) => setImmediate(resolve))
    const env = procs.at(-1).env
    assert.equal(env.JARIS_MACHINE, 'http://10.0.0.5:11434')
    assert.deepEqual([env.JARIS_MACHINE_VRAM_GB, env.JARIS_MACHINE_RAM_GB, env.JARIS_MACHINE_DISK_GB, env.JARIS_RAM_SAFETY_MARGIN_GB], ['80', '64', '100', '4'])
    assert.equal(events.filter((e) => e.startsWith('repair')).length, repairsBefore, 'pas de réparation du dossier de ce PC')
    procs.at(-1).emit('close', 0)
    await onMachine
    // Étape 439 : la configuration de ce PC se reteste aussi machine connectée — toujours sur l'Ollama de ce PC.
    const scopesBefore = events.filter((e) => e === 'local-scope').length
    await runQuickSetup(() => {}).catch((err) => assert.doesNotMatch(String(err), /déconnecte-la/))
    assert.equal(events.filter((e) => e === 'local-scope').length, scopesBefore + 1, 'dans la portée de ce PC')
  } finally {
    connectedForTest = null
  }
})

// Étape 438 (Léo : « je dois diviser le fichier, trop lourd ; garde seulement ce qui n'est pas encore sur le tableau ») :
// l'extrait à m'envoyer — seulement après le dernier envoi, sans les messages ni la liste des outils, compressé.
test('étape 438 : l’extrait des résultats ne garde que le nouveau, chaque résultat entier (question comprise), compressé', () => {
  const { buildTestResultsExport } = loadModule('../electron/services/benchmarkRunner.ts', (id) => {
    if (id === 'zlib') return realZlib
    if (id === 'path') return { join: (...parts) => parts.join('/') }
    if (id === 'fs') return { readFileSync: () => { throw new Error('ENOENT') } }
    return new Proxy({}, { get: () => () => {} })
  })
  const big = 'x'.repeat(5000)
  const question = [{ role: 'system', ref: 'abc123' }, { role: 'user', content: 'Ouvre le bloc-notes.' }]
  const traces = [
    { type: 'campagne', versions: { conversation: 6 }, tools: [{ name: 'open_app', description: big }] },
    { type: 'question', model: 'old:1b', at: '2026-11-06T10:00:00.000Z', ok: true, messages: question, response: { content: 'ancien' } },
    { type: 'campagne', versions: { conversation: 6 }, tools: [{ name: 'open_app', description: big }] },
    { type: 'demande-requete', model: 'granite4.2:8b', at: '2026-11-07T12:49:00.000Z', messages: [{ role: 'user', content: big }] },
    { type: 'question', model: 'granite4.2:8b', at: '2026-11-07T12:50:00.000Z', ok: true, replay: true, messages: question, response: { content: 'refait' } },
    { type: 'code', model: 'qwen2.5-coder:7b', at: '2026-11-07T12:54:00.000Z', ok: false, prompt: 'Un compteur', html: '<p>app</p>' }
  ].map((r) => JSON.stringify(r)).join('\n')
  const first = buildTestResultsExport(traces, null)
  assert.equal(first.rows, 3, 'la première fois : tout (sauf le suivi en cours)')
  const since = buildTestResultsExport(traces, '2026-11-06T23:59:00.000Z')
  assert.equal(since.rows, 2)
  assert.deepEqual(since.models, ['granite4.2:8b', 'qwen2.5-coder:7b'])
  assert.equal(since.lastAt, '2026-11-07T12:54:00.000Z')
  const lines = realZlib.gunzipSync(since.data).toString('utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(lines.map((l) => l.type), ['campagne', 'question', 'code'], 'l’en-tête de SA campagne, puis ses lignes, sans le suivi')
  assert.equal('tools' in lines[0], false, 'la liste des outils se relit dans le code')
  // Léo : « tu as bien le prompt pour vérifier la réponse ? » — la question, la réponse et le reste, intacts.
  assert.equal(lines[1].messages.at(-1).content, 'Ouvre le bloc-notes.')
  assert.equal(lines[1].response.content, 'refait')
  assert.equal(lines[2].prompt, 'Un compteur')
  assert.equal(lines[2].html, '<p>app</p>')
  assert.ok(since.data.length < 1000, `bien plus petit que le fichier brut (${since.data.length} octets)`)
  assert.equal(buildTestResultsExport(traces, '2026-11-07T12:54:00.000Z').rows, 0, 'rien de nouveau : rien à envoyer')
})
