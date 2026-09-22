import type { ModelChoiceInfo, ModelChoiceMode, Profile } from '../../shared/ipc'

/**
 * Étape 141, Léo : « ajoute dans chat code vocal, la possibilité de choisir le model ou faire auto, comme se
 * qui se passe maintenant ». Chaque mode (Chat, Code, Vocal) a son propre choix : Auto (le comportement
 * d'avant, strictement inchangé) ou un modèle installé précis.
 *
 * Tout est volontairement PUR ici (aucun accès à Ollama ni au disque) : main.ts, assistant.ts et
 * codeGenerator.ts passent la liste des modèles installés qu'ils ont déjà, et les tests n'ont rien à simuler.
 */

export const MODEL_CHOICE_MODES: readonly ModelChoiceMode[] = ['chat', 'code', 'voice']

/** Ollama range un modèle sans tag sous `:latest` : les deux écritures désignent le même modèle. */
function withTag(name: string): string {
  const lastSegment = name.slice(name.lastIndexOf('/') + 1)
  return lastSegment.includes(':') ? name : `${name}:latest`
}

function isInstalled(model: string, installed: string[]): boolean {
  const wanted = withTag(model)
  return installed.some((m) => withTag(m) === wanted)
}

/**
 * Modèles proposés dans le sélecteur : tout ce qui est installé, SAUF les modèles d'embedding (ils ne savent
 * pas discuter, les proposer ferait échouer chaque réponse avec une erreur d'Ollama).
 */
export function selectableModels(installed: string[]): string[] {
  return installed.filter((m) => !/embed/i.test(m)).sort((a, b) => a.localeCompare(b))
}

/**
 * Le modèle choisi à la main pour ce mode, ou `null` pour Auto. Un choix dont le modèle n'est plus installé
 * (supprimé depuis, dossier des modèles déplacé...) retombe sur Auto plutôt que de faire échouer chaque
 * réponse avec « modèle introuvable » — Léo n'aurait aucun moyen de comprendre pourquoi Jaris ne répond plus.
 */
export function resolveChosenModel(profile: Profile | null, mode: ModelChoiceMode, installed: string[]): string | null {
  const chosen = profile?.modelChoices?.[mode]
  if (!chosen) return null
  return isInstalled(chosen, selectableModels(installed)) ? chosen : null
}

export function buildModelChoiceInfo(profile: Profile | null, mode: ModelChoiceMode, installed: string[] | null): ModelChoiceInfo {
  return {
    // Ollama injoignable : on montre quand même le choix enregistré plutôt que de le faire croire perdu.
    selected: installed === null ? (profile?.modelChoices?.[mode] ?? null) : resolveChosenModel(profile, mode, installed),
    installed: installed === null ? null : selectableModels(installed),
    autoModel: mode === 'code' ? (profile?.codeModel ?? null) : null
  }
}

/**
 * Enregistre le choix d'un mode. `model` vient du renderer : il est revérifié ici contre la liste réelle
 * d'Ollama (jamais un nom arbitraire enregistré tel quel), et `null` remet ce mode en Auto.
 */
export function applyModelChoice(
  profile: Profile,
  mode: ModelChoiceMode,
  model: string | null,
  installed: string[]
): Profile {
  if (!MODEL_CHOICE_MODES.includes(mode)) throw new Error(`Mode inconnu : ${String(mode)}`)
  const choices = { ...(profile.modelChoices ?? {}) }
  if (model === null) {
    delete choices[mode]
  } else {
    if (!isInstalled(model, selectableModels(installed))) throw new Error(`${model} n'est pas installé dans Ollama.`)
    choices[mode] = model
  }
  return { ...profile, modelChoices: choices }
}
