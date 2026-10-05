import { spawn, type ChildProcess } from 'child_process'
import { readFileSync } from 'fs'
import { app, powerSaveBlocker } from 'electron'
import { join } from 'path'
import { config } from '../config'
import { resourcesRoot } from '../paths'
import { getDataRoot } from './dataLocation'
import { deleteModel, pullModelIfMissing, ModelTooLargeError, DiskFullError } from './ollama'
import { campaignCompletion, getAllCandidateModelIds, getUnscoredModels, pickBestModelsFromBenchmark } from './hardwareScan'
import { getProfile, saveProfile } from './profileStore'
import type { CapacityScanResult } from '../../shared/ipc'
import { installImageModel } from './imageGenerator'
import { detectRamGb } from './systemResources'
import { pickImageModel } from '../../shared/imageModel'
import { pickPilotModel } from '../../shared/pilotModel'

/**
 * Configuration de l'écran d'accueil (CapacityScan.tsx) et de « Retester la configuration » : ne lance JAMAIS
 * de test de modèles — pickBestModelsFromBenchmark (hardwareScan.ts) choisit instantanément d'après les
 * scores mesurés par Léo (verified-tool-scores.md, seule source depuis que l'analyse a été retirée de
 * l'application, étape 166). Ne télécharge QUE les modèles réellement choisis (jusqu'à 5 :
 * rapide/médium/puissant, souvent les mêmes sur une machine contrainte, + vision + code), jamais les
 * candidats perdants.
 */
export async function runQuickSetup(onLine: (line: string) => void): Promise<CapacityScanResult> {
  onLine('Détection du matériel...')
  let picked = await pickBestModelsFromBenchmark()
  onLine(
    `Carte détectée : ${picked.gpuName ?? 'inconnue'}${picked.vramGb !== null ? ` (${picked.vramGb} Go de VRAM)` : ''}.`
  )

  // Un modèle ignoré (trop gros pour VRAM+RAM, ou pas assez de disque) ne doit jamais rendre la
  // configuration silencieusement "réussie" : sans ce suivi, capacityScanDone passait quand même à `true`
  // ci-dessous alors qu'un palier entier (ex: le modèle "puissant") n'était en réalité jamais installé —
  // CapacityScan.tsx affichait "Configuration terminée" avec un modèle listé qui n'existe pourtant pas sur
  // le disque, jusqu'à ce que Jaris échoue à l'utiliser bien plus tard, loin du vrai moment de la cause.
  const skippedModels = new Map<string, string>()
  // Étape 136, Léo : "Rajoute les 2 model" (G9v3-3B et GLM-4.6V-Flash, retirés par une autre IA à cause
  // d'un bug RÉEL d'Ollama 0.34.2 : "blocked redirect to a different host" sur TOUT import hf.co/ —
  // github.com/ollama/ollama/issues/18526, corrigé dans v0.34.3, encore en pré-version au 22/09/2026).
  // Plutôt que de retirer les meilleurs modèles pour tout le monde à cause d'une seule version d'Ollama, un
  // import Hugging Face qui échoue au téléchargement est écarté POUR CE RUN et le palier retombe sur le
  // meilleur modèle suivant (pickBestModelsFromBenchmark avec `exclude`) — "Retester la configuration" ne
  // plante donc plus jamais à cause de ce bug, et reprendra le bon modèle dès qu'Ollama sera corrigé.
  // Limité aux imports hf.co/ : une erreur sur un tag de la bibliothèque Ollama (réseau coupé...) continue
  // de remonter telle quelle, jamais masquée par un repli silencieux.
  const failedHuggingFace = new Set<string>()
  const blockedReasons = new Map<string, string>()
  const pulledOk = new Set<string>()
  // Borné : chaque tour exclut au moins un modèle de plus, et il n'y a que quelques imports hf.co/.
  for (let round = 0; round < 4; round++) {
    // Mode Code (étape 46) : le meilleur candidat qui tient dans la VRAM+RAM de cette machine
    // (picked.codeModel, même logique que flash/médium/puissant/vision) est installé d'avance ici aussi,
    // plutôt que de surprendre l'utilisateur en pleine génération de code.
    const modelsToInstall = new Set([picked.models.flash, picked.models.medium, picked.models.large, picked.visionModel, picked.codeModel])
    let newFailure = false
    for (const model of modelsToInstall) {
      try {
        await pullModelIfMissing(model, onLine)
        pulledOk.add(model)
      } catch (err) {
        if (err instanceof ModelTooLargeError || err instanceof DiskFullError) {
          if (!skippedModels.has(model)) onLine(`Modèle ${model} ignoré : ${err.message}`)
          skippedModels.set(model, err.message)
        } else if (model.startsWith('hf.co/') && !failedHuggingFace.has(model)) {
          onLine(
            `Téléchargement de ${model} impossible pour l'instant (${err instanceof Error ? err.message : String(err)}). ` +
              "C'est un bug connu de certaines versions d'Ollama avec Hugging Face : Jaris prend le meilleur modèle " +
              'suivant en attendant. Mets Ollama à jour puis relance « Retester la configuration » pour le récupérer.'
          )
          failedHuggingFace.add(model)
          // Phrase courte pour Léo (affichée dans Options → Modèles) ; l'erreur brute reste dans le journal ci-dessus.
          blockedReasons.set(model, "ta version d'Ollama bloque ce téléchargement (bug corrigé dans sa prochaine version)")
          newFailure = true
        } else {
          throw err
        }
      }
    }
    if (!newFailure) break
    picked = await pickBestModelsFromBenchmark(failedHuggingFace)
  }

  // Étape 175, Léo : le modèle d'image « doit s'installer dans la page modèles comme tous les modèles » —
  // ici, juste après ceux d'Ollama, et seulement si la machine a la puissance (même décision que la ligne
  // « Image » d'Options → Modèles). Un échec ne fait jamais échouer le reste de la configuration.
  const imagePick = pickImageModel(picked.vramGb, detectRamGb())
  let image: CapacityScanResult['image'] = imagePick
  if (imagePick.model) {
    try {
      await installImageModel(onLine)
      image = { ...imagePick, installed: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      onLine(`Modèle d'image ${imagePick.model} non installé : ${message}`)
      image = { ...imagePick, installed: false, error: message }
    }
  } else {
    onLine(`Pas de modèle d'image : ${imagePick.reason}.`)
  }

  // Étape 231, Léo : « comme image vidéo le mettre seul, si l'utilisateur n'a pas assez on met pas le rôle et il
  // fait comme maintenant ». Le modèle de pilotage d'écran n'est installé que si la carte le fait tourner ; un
  // échec ne fait jamais échouer le reste de la configuration — le modèle de vision continue alors de piloter.
  const pilotPick = pickPilotModel(picked.vramGb)
  let pilot: CapacityScanResult['pilot'] = pilotPick
  if (pilotPick.model) {
    try {
      await pullModelIfMissing(pilotPick.model, onLine)
      pilot = { ...pilotPick, installed: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      onLine(`Modèle de pilotage d'écran non installé (${message}) — le modèle de vision pilote l'écran en attendant.`)
      pilot = { ...pilotPick, installed: false, error: message }
    }
  } else {
    onLine(`Pas de modèle de pilotage d'écran : ${pilotPick.reason}. Le modèle de vision pilote l'écran, comme avant.`)
  }

  const profile = await getProfile()
  if (profile) {
    // Étape 133, Léo : "pour mon palier on a changer de model comment on fait ça me réinstalle pas les
    // nouveaux model direct et désinstalle l'ancien". Ce chemin RAPIDE (verified-tool-scores.md connaît
    // déjà le gagnant, pas de vrai benchmark à lancer) ne faisait QUE télécharger les nouveaux modèles
    // choisis, sans jamais nettoyer les anciens qu'ils remplacent.
    //
    // `keep` retient, pour chaque rôle, le modèle qui reste RÉELLEMENT en service après ce run : le nouveau
    // choix s'il a bien été téléchargé (pas dans skippedModels), sinon l'ANCIEN choix de ce rôle — sans ce
    // repli, un modèle "puissant" ignoré faute de VRAM/disque perdrait son ancien modèle fonctionnel en plus
    // de ne jamais recevoir le nouveau, laissant ce palier sans rien d'installé du tout.
    const skipped = new Set(skippedModels.keys())
    const keep = new Set<string>()
    const roles: [string | undefined, string][] = [
      [profile.models?.flash, picked.models.flash],
      [profile.models?.medium, picked.models.medium],
      [profile.models?.large, picked.models.large],
      [profile.visionModel, picked.visionModel],
      [profile.codeModel, picked.codeModel]
    ]
    for (const [before, after] of roles) {
      keep.add(skipped.has(after) && before ? before : after)
    }
    // Étape 141 : un modèle choisi à la main dans Chat/Code/Vocal reste en service, jamais supprimé ici.
    for (const chosen of Object.values(profile.modelChoices ?? {})) if (chosen) keep.add(chosen)
    const oldModels = roles.map(([before]) => before).filter((m): m is string => Boolean(m))
    // Étape 231 : le modèle de pilotage installé ce coup-ci, sinon celui d'avant s'il existe encore un rôle
    // (téléchargement raté) ; plus de rôle du tout (carte trop petite) = l'ancien est supprimé comme les autres.
    const pilotModel = pilot.installed ? pilot.model ?? undefined : pilotPick.model ? profile.pilotModel : undefined
    if (pilotModel) keep.add(pilotModel)
    if (profile.pilotModel) oldModels.push(profile.pilotModel)
    const toRemove = [...new Set(oldModels)].filter((m) => !keep.has(m))
    for (const model of toRemove) {
      try {
        await deleteModel(model)
        onLine(
          model === profile.pilotModel
            ? `Ancien modèle de pilotage d'écran ${model} supprimé (ta carte graphique ne le fait plus tourner).`
            : `Ancien modèle ${model} supprimé (remplacé par un meilleur choix pour ta configuration).`
        )
      } catch (err) {
        onLine(`Échec de la suppression de l'ancien modèle ${model} : ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    await saveProfile({
      ...profile,
      models: picked.models,
      visionModel: picked.visionModel,
      codeModel: picked.codeModel,
      pilotModel,
      capacityScanDone: true,
      knownModelCandidates: getAllCandidateModelIds(),
      // Étape 138 : mémorisé pour que la carte "Modèles choisis pour ta machine" explique pourquoi le
      // meilleur modèle n'est pas celui utilisé ; oublié dès qu'un téléchargement du même modèle réussit.
      blockedModels: Object.fromEntries([
        ...Object.entries(profile.blockedModels ?? {}).filter(([model]) => !pulledOk.has(model) && !blockedReasons.has(model)),
        ...blockedReasons
      ])
    })
  }

  const blockedList = [...blockedReasons].map(([model, reason]) => ({ model, reason }))
  const skippedList = [...skippedModels].map(([model, reason]) => ({ model, reason }))
  return {
    ...picked,
    skippedModels: skippedList.length ? skippedList : undefined,
    blockedModels: blockedList.length ? blockedList : undefined,
    image,
    pilot
  }
}

/** Fichier où le bouton « Tester les modèles sans score » écrit ses résultats (dossier de données de Jaris). */
export function unscoredResultsPath(): string {
  return join(getDataRoot(), 'benchmark-nouveaux-modeles.md')
}

/**
 * Les modèles que le bouton doit encore tester : sans score dans verified-tool-scores.md ET pas encore tout faits
 * dans le fichier brut de la campagne en cours (même nom que le script : <résultats>.traces.jsonl). Sans ce fichier
 * (aucune campagne), ce sont simplement les modèles sans score.
 */
export function getModelsToTest(): string[] {
  let traces = ''
  try {
    traces = readFileSync(unscoredResultsPath().replace(/\.md$/i, '.traces.jsonl'), 'utf8')
  } catch {
    // Pas encore de campagne.
  }
  return getUnscoredModels(campaignCompletion(traces))
}

/**
 * Étape 168 (Léo : « remets le bouton pour Lightning et qwen2.5-coder:14b ») : teste UNIQUEMENT les modèles de
 * Jaris qui n'ont encore aucun score (getUnscoredModels), avec le script de test habituel. Contrairement à
 * l'ancienne analyse complète (retirée à l'étape 166), rien n'est choisi ni installé à la fin : les scores
 * restent dans ce fichier, que Léo envoie pour qu'ils soient recopiés dans verified-tool-scores.md — la seule
 * source des scores de Jaris. Les modèles téléchargés pour le test sont supprimés par le script juste après.
 *
 * `process.execPath` + ELECTRON_RUN_AS_NODE : l'exécutable de Jaris est lui-même un Node complet, l'appli
 * installée n'a jamais besoin d'un `node` système. JARIS_RESUME : un PC éteint en route reprend là où il en
 * était au clic suivant. Marge RAM de 12 Go au lieu de 16 : voir RAM_SAFETY_MARGIN_GB dans le script.
 */
/**
 * Étape 230 : le test en cours. Un re-test complet dure des heures ; fermer Jaris ne l'arrêtait pas (un process
 * lancé par Jaris lui survit sous Windows), et le relancer ensuite en faisait tourner DEUX sur le même fichier
 * de résultats. Gardé ici pour l'arrêter à la fermeture (stopModelTest) et refuser un second lancement.
 */
let runningTest: ChildProcess | null = null

/** Arrête le test de modèles en cours, s'il y en a un (fermeture de Jaris). Il reprendra au prochain lancement. */
export function stopModelTest(): void {
  runningTest?.kill()
  runningTest = null
}

export function testUnscoredModels(onLine: (line: string) => void): Promise<{ models: string[]; resultsPath: string }> {
  const models = getModelsToTest()
  const resultsPath = unscoredResultsPath()
  if (!models.length) return Promise.resolve({ models, resultsPath })
  if (runningTest) return Promise.reject(new Error('Un test est déjà en cours : attends sa fin, ou ferme Jaris pour l’arrêter.'))
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [join(resourcesRoot(), 'scripts', 'benchmark-models.mjs')], {
      windowsHide: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        OLLAMA_HOST: config.ollama.host,
        JARIS_ONLY_MODELS: models.join(','),
        JARIS_RESULTS_PATH: resultsPath,
        JARIS_RESUME: '1',
        // Étape 230 : chaque modèle téléchargé pour le test est supprimé juste après (sinon ~290 Go restent).
        JARIS_DELETE_AFTER_TEST: '1',
        JARIS_RAM_SAFETY_MARGIN_GB: '12',
        // Étape 233 : écrite dans les traces, pour savoir quelle version de Jaris a produit chaque score.
        JARIS_APP_VERSION: app.getVersion()
      }
    })
    runningTest = proc
    // Étape 236 : un test de 1,5 à 3 jours sans surveillance. Sans ce blocage, la mise en veille de Windows le
    // suspendait en pleine génération — au réveil, une requête coupée passe pour un modèle figé ou un Ollama
    // arrêté. Le PC reste éveillé tant que le test tourne (l'écran, lui, peut s'éteindre), et seulement pendant.
    const awake = powerSaveBlocker.start('prevent-app-suspension')
    const release = (): void => {
      if (powerSaveBlocker.isStarted(awake)) powerSaveBlocker.stop(awake)
    }
    let buffer = ''
    // setEncoding : un caractère accentué coupé entre deux morceaux reste entier (piège déjà rencontré, étape 121).
    proc.stdout.setEncoding('utf8')
    proc.stderr.setEncoding('utf8')
    const handleChunk = (chunk: string): void => {
      buffer += chunk
      let newlineIndex: number
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        onLine(buffer.slice(0, newlineIndex))
        buffer = buffer.slice(newlineIndex + 1)
      }
    }
    proc.stdout.on('data', handleChunk)
    proc.stderr.on('data', handleChunk)
    proc.on('error', (err) => {
      release()
      if (runningTest === proc) runningTest = null
      reject(new Error(`Impossible de lancer le test : ${err.message}`))
    })
    proc.on('close', (code) => {
      release()
      if (runningTest === proc) runningTest = null
      if (buffer.trim()) onLine(buffer)
      if (code === 0) resolve({ models, resultsPath })
      else reject(new Error(`Le test s'est arrêté avant la fin (code ${code ?? '?'}). Relance-le : il reprendra là où il en était.`))
    })
  })
}
