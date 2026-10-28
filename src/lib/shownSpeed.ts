import type { ModelOverviewEntry } from '../../shared/ipc'

/**
 * Étape 367 : la vitesse affichée pour un modèle — celle de CE PC (mesurée, ou estimée pour un modèle jamais lancé ici)
 * quand le processus principal la donne, sinon la vitesse publiée par Artificial Analysis (comme avant).
 */
export function shownSpeed(entry: ModelOverviewEntry): { value: number | null; kind: 'measured' | 'estimated' | 'published' | null } {
  if (entry.localSpeed !== undefined) return { value: entry.localSpeed, kind: entry.localSpeedKind ?? null }
  const published = typeof entry.artificialAnalysisSpeed === 'number' ? entry.artificialAnalysisSpeed : null
  return { value: published, kind: published === null ? null : 'published' }
}
