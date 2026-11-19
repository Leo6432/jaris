import type { ModelOverviewEntry } from '../../shared/ipc'

/**
 * Étape 367 : la vitesse affichée pour un modèle — celle mesurée sur CE PC. Étape 498 : plus aucune vitesse publiée
 * (Artificial Analysis retiré) ; `null` tant que le modèle n'a pas été mesuré ici.
 */
export function shownSpeed(entry: ModelOverviewEntry): { value: number | null; kind: 'measured' | null } {
  return { value: entry.localSpeed ?? null, kind: entry.localSpeed == null ? null : entry.localSpeedKind ?? null }
}
