import type { ModelChoiceInfo, ModelChoiceMode, Profile } from '../../shared/ipc'

/**
 * Étape 141, Léo : « ajoute dans chat code vocal, la possibilité de choisir le model ou faire auto, comme se
 * qui se passe maintenant ». Chaque mode (Chat, Code, Vocal) a son propre choix : Auto (le comportement
 * d'avant, strictement inchangé) ou un rôle lié au modèle actuellement retenu pour cette machine.
 *
 * Tout est volontairement PUR ici (aucun accès à Ollama ni au disque) : main.ts, assistant.ts et
 * codeGenerator.ts passent la liste des modèles installés qu'ils ont déjà, et les tests n'ont rien à simuler.
 */

export const MODEL_CHOICE_MODES: readonly ModelChoiceMode[] = ['chat', 'code', 'voice']

// Étape 198 (Léo : « pourquoi on peut choisir Vision, c'est pas un modèle pour la conversation ») : le rôle
// Vision ne sert qu'à regarder l'écran ou une image, il n'est plus proposé pour discuter. Un ancien choix
// « role:vision » enregistré retombe sur Auto (modelForRole ne le connaît plus).
//
// Étape 201 (Léo : « dans chat et vocal on doit pas avoir code », « dans code on peut choisir le modèle, mais
// ça doit pas être possible, c'est toujours code, comme image avec le modèle image ») : chaque mode ne propose
// que ses propres rôles. Chat et Vocal : Rapide, Médium, Puissant. Code : AUCUN choix, toujours le modèle Code
// du profil (comme le mode Image avec son modèle de dessin). Un ancien choix enregistré hors de cette liste
// (« role:code » en Chat, n'importe quoi en Code) retombe sur Auto.
const CONVERSATION_ROLES = [
  { key: 'flash', label: 'Faible' },
  { key: 'medium', label: 'Moyen' },
  { key: 'large', label: 'Élevé' }
] as const

const ROLES_BY_MODE: Record<ModelChoiceMode, ReadonlyArray<{ key: string; label: string }>> = {
  chat: CONVERSATION_ROLES,
  voice: CONVERSATION_ROLES,
  code: []
}

function modelForRole(profile: Profile | null, value: string, mode: ModelChoiceMode): string | null {
  if (!ROLES_BY_MODE[mode].some(({ key }) => value === `role:${key}`)) return null
  switch (value) {
    case 'role:flash': return profile?.models?.flash ?? null
    case 'role:medium': return profile?.models?.medium ?? null
    case 'role:large': return profile?.models?.large ?? null
    default: return null
  }
}

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
 * Modèles utilisables derrière les rôles : tout ce qui est installé, SAUF les modèles d'embedding (ils ne
 * savent pas discuter, les proposer ferait échouer chaque réponse avec une erreur d'Ollama).
 */
export function selectableModels(installed: string[]): string[] {
  return installed.filter((m) => !/embed/i.test(m)).sort((a, b) => a.localeCompare(b))
}

/**
 * Le modèle correspondant au rôle choisi pour ce mode, ou `null` pour Auto. Un choix dont le modèle n'est plus installé
 * (supprimé depuis, dossier des modèles déplacé...) retombe sur Auto plutôt que de faire échouer chaque
 * réponse avec « modèle introuvable » — Léo n'aurait aucun moyen de comprendre pourquoi Jaris ne répond plus.
 */
export function resolveChosenModel(profile: Profile | null, mode: ModelChoiceMode, installed: string[]): string | null {
  const chosen = profile?.modelChoices?.[mode]
  if (!chosen || mode === 'code') return null
  const model = chosen.startsWith('role:') ? modelForRole(profile, chosen, mode) : chosen
  return model && isInstalled(model, selectableModels(installed)) ? model : null
}

export function buildModelChoiceInfo(profile: Profile | null, mode: ModelChoiceMode, installed: string[] | null): ModelChoiceInfo {
  return {
    // Ollama injoignable : on montre quand même le choix enregistré plutôt que de le faire croire perdu.
    selected: installed === null ? (profile?.modelChoices?.[mode] ?? null) :
      (resolveChosenModel(profile, mode, installed) ? (profile?.modelChoices?.[mode] ?? null) : null),
    installed: installed === null ? null : selectableModels(installed),
    autoModel: mode === 'code' ? (profile?.codeModel ?? null) : null,
    roles: ROLES_BY_MODE[mode].flatMap(({ key, label }) => {
      const value = `role:${key}`
      const model = modelForRole(profile, value, mode)
      return model ? [{ value, label, model, installed: installed === null || isInstalled(model, selectableModels(installed)) }] : []
    })
  }
}

/**
 * Enregistre le rôle choisi pour un mode. Sa cible est revérifiée contre la liste réelle d'Ollama ; un rôle
 * absent ou non installé n'est pas accepté. Les anciens choix par nom restent lisibles, mais plus proposés.
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
    if (mode === 'code') throw new Error('Le mode Code utilise toujours le modèle Code : il ne se choisit pas.')
    const target = modelForRole(profile, model, mode)
    if (!target || !isInstalled(target, selectableModels(installed))) throw new Error(`Le modèle du rôle ${model} n'est pas installé dans Ollama.`)
    choices[mode] = model
  }
  return { ...profile, modelChoices: choices }
}
