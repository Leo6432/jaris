import { spawn } from 'child_process'
import { join } from 'path'
import { config } from '../config'
import { deleteModel, listInstalledModels, pullModelIfMissing, ModelTooLargeError, DiskFullError } from './ollama'
import { getAllCandidateModelIds, getCodeCandidateModelIds, parseLocalBenchmark, pickBestModelsFromBenchmark } from './hardwareScan'
import { CODE_MODEL_FAST, CODE_MODEL_QUALITY } from './codeGenerator'
import { getProfile, saveProfile } from './profileStore'
import type { AnalysisScope, CapacityScanResult } from '../../shared/ipc'

/**
 * Chemin rapide de l'écran d'accueil (CapacityScan.tsx) : contrairement à runModelAnalysis ci-dessous, ne
 * lance JAMAIS scripts/benchmark-models.mjs (donc jamais des dizaines de modèles téléchargés juste pour
 * comparer) — pickBestModelsFromBenchmark (hardwareScan.ts) répond déjà instantanément dès qu'un candidat
 * vérifié (verified-tool-scores.md) couvre le budget de la machine, ce qui est maintenant le cas pour la
 * quasi-totalité des configurations courantes. Ne télécharge QUE les modèles réellement choisis (jusqu'à 5 :
 * rapide/médium/puissant, souvent les mêmes sur une machine contrainte, + vision + le modèle Code rapide),
 * jamais les candidats perdants. `runModelAnalysis` (le vrai test comparatif complet) reste disponible à la
 * main depuis Options → Modèles pour qui veut vérifier/affiner au-delà de ce que verified-tool-scores.md
 * couvre déjà.
 */
export async function runQuickSetup(onLine: (line: string) => void): Promise<CapacityScanResult> {
  onLine('Détection du matériel...')
  const picked = await pickBestModelsFromBenchmark()
  onLine(
    `Carte détectée : ${picked.gpuName ?? 'inconnue'}${picked.vramGb !== null ? ` (${picked.vramGb} Go de VRAM)` : ''}.`
  )

  const modelsToInstall = new Set([picked.models.flash, picked.models.medium, picked.models.large, picked.visionModel])
  // Mode Code (codeGenerator.ts) : le modèle qualité (35 Md, plusieurs dizaines de Go) reste un choix
  // conscient (`ollama pull` manuel, jamais forcé ici), mais le modèle rapide (~4,7 Go) doit être prêt
  // d'avance comme les autres paliers plutôt que de surprendre l'utilisateur en pleine génération de code —
  // sauf si le modèle qualité est déjà installé, auquel cas resolveCodeModel l'utilisera de toute façon et
  // le rapide ne sert à rien.
  const installed = await listInstalledModels().catch(() => [] as string[])
  if (!installed.includes(CODE_MODEL_QUALITY)) modelsToInstall.add(CODE_MODEL_FAST)
  for (const model of modelsToInstall) {
    try {
      await pullModelIfMissing(model, onLine)
    } catch (err) {
      if (err instanceof ModelTooLargeError || err instanceof DiskFullError) {
        onLine(`Modèle ${model} ignoré : ${err.message}`)
      } else {
        throw err
      }
    }
  }

  const profile = await getProfile()
  if (profile) {
    await saveProfile({
      ...profile,
      models: picked.models,
      visionModel: picked.visionModel,
      capacityScanDone: true,
      knownModelCandidates: getAllCandidateModelIds()
    })
  }

  return picked
}

/**
 * Lance scripts/benchmark-models.mjs comme un vrai process Node, en streamant chaque ligne de sa sortie
 * via `onLine` au fur et à mesure — plutôt que d'attendre la fin complète (le benchmark peut prendre
 * 20-40+ minutes avec plusieurs modèles à charger un par un). Réutilise le script tel quel (pas de logique
 * dupliquée) : ce n'est possible que dans un checkout source (le script n'est jamais packagé), mais
 * l'onglet Modèles qui l'appelle est lui-même un outil de dev, pas une fonctionnalité pour un build final.
 *
 * `scope` passé en variable d'environnement (JARIS_ANALYSIS_SCOPE) : le script lit lui-même cette variable
 * pour ne tester que les candidats du palier demandé (voir son commentaire sur SCOPE) — jamais interprété
 * ici, seulement transmis tel quel.
 */
function spawnBenchmarkScript(onLine: (line: string) => void, scope: AnalysisScope): Promise<void> {
  return new Promise((resolve, reject) => {
    const scriptPath = join(process.cwd(), 'scripts', 'benchmark-models.mjs')
    const proc = spawn('node', [scriptPath], {
      windowsHide: true,
      env: { ...process.env, OLLAMA_HOST: config.ollama.host, JARIS_ANALYSIS_SCOPE: scope }
    })

    let buffer = ''
    const handleChunk = (chunk: Buffer): void => {
      buffer += chunk.toString()
      let newlineIndex: number
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        onLine(buffer.slice(0, newlineIndex))
        buffer = buffer.slice(newlineIndex + 1)
      }
    }

    proc.stdout.on('data', handleChunk)
    proc.stderr.on('data', handleChunk)
    proc.on('error', (err) => reject(new Error(`Impossible de lancer le benchmark : ${err.message}`)))
    proc.on('close', (code) => {
      if (buffer.trim()) onLine(buffer)
      if (code === 0) resolve()
      else reject(new Error(`Le benchmark s'est arrêté avec le code ${code ?? '?'}`))
    })
  })
}

/**
 * Supprime (via l'API Ollama) tout modèle testé par le dernier run — d'après
 * scripts/benchmark-results.md, voir parseLocalBenchmark — qui n'est PAS actuellement retenu par le
 * profil (rapide/médium/puissant/vision) : le benchmark installe tout ce qui manque pour tester à fond,
 * mais rien n'a de raison de rester sur le disque une fois le gagnant de chaque palier connu. Ne touche
 * jamais à un modèle absent de ce fichier (jamais testé par ce script) : uniquement le ménage de ce que le
 * benchmark lui-même a pu faire installer.
 */
async function cleanupUnselectedModels(onLine: (line: string) => void): Promise<void> {
  const tested = [...parseLocalBenchmark().keys()]
  if (!tested.length) return

  const profile = await getProfile()
  const keep = new Set<string>()
  if (profile?.models?.flash) keep.add(profile.models.flash)
  if (profile?.models?.medium) keep.add(profile.models.medium)
  if (profile?.models?.large) keep.add(profile.models.large)
  if (profile?.visionModel) keep.add(profile.visionModel)
  // Le palier Code n'a pas UN choix stocké dans le profil (resolveCodeModel décide dynamiquement selon ce
  // qui est installé, voir codeGenerator.ts) : sans cette exemption, un modèle Code fraîchement testé
  // (potentiellement des dizaines de Go) était supprimé juste après le test, alors que rien ne l'avait
  // "remplacé" — c'est ce que Léo a vu (qwen2.5-coder:7b réinstallé au premier prompt du mode Code).
  for (const model of getCodeCandidateModelIds()) keep.add(model)

  const toRemove = tested.filter((model) => !keep.has(model))
  if (!toRemove.length) {
    onLine('Rien à supprimer : tous les modèles testés sont retenus par le profil actuel.')
    return
  }

  onLine(`Suppression de ${toRemove.length} modèle(s) testé(s) non retenu(s) par le profil actuel...`)
  for (const model of toRemove) {
    try {
      await deleteModel(model)
      onLine(`  Supprimé : ${model}`)
    } catch (err) {
      onLine(`  Échec de la suppression de ${model} : ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/**
 * Lance le benchmark (installation des modèles manquants, tests), choisit le meilleur modèle de chaque
 * palier d'après les vrais résultats (pickBestModelsFromBenchmark), l'enregistre dans le profil, supprime
 * les anciens modèles remplacés, puis fait le ménage de tout ce qui a été testé mais n'est finalement
 * retenu par aucun palier (cleanupUnselectedModels) — un seul geste ("Tester tous les modèles et choisir
 * les meilleurs" dans l'onglet Modèles) au lieu d'un scan par taille puis un benchmark séparé qui ne
 * changeait rien aux modèles réellement utilisés.
 *
 * `scope` ('all' par défaut) limite le test à un seul palier — bien plus rapide pour re-tester juste "Puissant"
 * après un changement qui ne concerne que lui, par exemple. Les résultats des autres paliers, déjà connus
 * (scripts/benchmark-results.md), sont conservés tels quels par le script — jamais effacés par un run ciblé,
 * donc pickBestModelsFromBenchmark garde les mêmes choix pour les paliers non re-testés.
 */
export async function runModelAnalysis(onLine: (line: string) => void, scope: AnalysisScope = 'all'): Promise<CapacityScanResult> {
  const before = await getProfile()

  await spawnBenchmarkScript(onLine, scope)
  onLine('')

  onLine("Sélection du meilleur modèle pour chaque palier, d'après les résultats du benchmark…")
  const picked = await pickBestModelsFromBenchmark()
  // Seul le modèle vision n'est jamais installé par le benchmark (pas testé) : les modèles texte/tool-
  // calling retenus, eux, ont forcément déjà été téléchargés pour être testés (donc déjà passés par ce
  // même filet de sécurité). Si même le vision le plus léger ne rentre pas, on continue sans lui plutôt que
  // de faire échouer toute l'analyse pour une fonctionnalité annexe (voir look_at_screen) — texte/outils
  // restent utilisables.
  try {
    await pullModelIfMissing(picked.visionModel, onLine)
  } catch (err) {
    if (err instanceof ModelTooLargeError || err instanceof DiskFullError) {
      onLine(`Modèle vision ${picked.visionModel} ignoré : ${err.message}`)
    } else {
      throw err
    }
  }

  // Les anciens modèles texte/tool-calling remplacés sont nettoyés juste en dessous par
  // cleanupUnselectedModels (ils ont forcément été testés par ce run, donc suivis par parseLocalBenchmark).
  // Vision n'a pas de résultat de benchmark (jamais testé) : géré ici à part, seulement s'il a changé —
  // sinon un ancien modèle vision resterait installé indéfiniment sans jamais être nettoyé.
  if (before?.visionModel && before.visionModel !== picked.visionModel) {
    try {
      await deleteModel(before.visionModel)
      onLine(`Ancien modèle vision ${before.visionModel} supprimé (remplacé par un meilleur choix).`)
    } catch (err) {
      onLine(`Échec de la suppression de l'ancien modèle vision ${before.visionModel} : ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const profile = await getProfile()
  if (profile) {
    await saveProfile({
      ...profile,
      models: picked.models,
      visionModel: picked.visionModel,
      capacityScanDone: true,
      // Resynchronise la veille de l'étape 29 au passage : ce run vient de tester tout ce que Jaris connaît.
      knownModelCandidates: getAllCandidateModelIds()
    })
  }

  onLine('')
  await cleanupUnselectedModels(onLine)

  return picked
}
