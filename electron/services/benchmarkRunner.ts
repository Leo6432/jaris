import { deleteModel, pullModelIfMissing, ModelTooLargeError, DiskFullError } from './ollama'
import { getAllCandidateModelIds, pickBestModelsFromBenchmark } from './hardwareScan'
import { getProfile, saveProfile } from './profileStore'
import type { CapacityScanResult } from '../../shared/ipc'

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
    const toRemove = [...new Set(oldModels)].filter((m) => !keep.has(m))
    for (const model of toRemove) {
      try {
        await deleteModel(model)
        onLine(`Ancien modèle ${model} supprimé (remplacé par un meilleur choix pour ta configuration).`)
      } catch (err) {
        onLine(`Échec de la suppression de l'ancien modèle ${model} : ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    await saveProfile({
      ...profile,
      models: picked.models,
      visionModel: picked.visionModel,
      codeModel: picked.codeModel,
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
    blockedModels: blockedList.length ? blockedList : undefined
  }
}
