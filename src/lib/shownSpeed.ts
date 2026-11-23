import type { ModelOverviewEntry } from '../../shared/ipc'
import { PUBLISHED_SPEED_REFERENCE } from '../../shared/publishedSpeeds'
import { formatDecimal, t } from '@/lib/i18n'

/**
 * Étape 367 : la vitesse affichée pour un modèle. Étape 517 : celle du test de vitesse sur CE PC, sinon celle mesurée par
 * Léo et publiée dans Jaris (shared/publishedSpeeds.ts) ; `null` si aucune des deux.
 */
export function shownSpeed(entry: ModelOverviewEntry): { value: number | null; kind: 'measured' | 'published' | null } {
  return { value: entry.localSpeed ?? null, kind: entry.localSpeed == null ? null : entry.localSpeedKind ?? null }
}

/**
 * Étape 517 : d'où vient une vitesse, dit en clair (infobulle) — sur ce PC, ou par Jaris sur la carte de mesure. La carte
 * vient du fichier publié, jamais écrite à la main ici.
 */
export function speedSourceLabel(kind: 'measured' | 'published' | null | undefined): string | undefined {
  if (kind === 'measured') return t('speed.kind.measured')
  if (kind === 'published') {
    return t('speed.kind.published', {
      gpu: PUBLISHED_SPEED_REFERENCE.gpu.replace(/^NVIDIA\s+(GeForce\s+)?/i, ''),
      vram: t('unit.gb', { value: formatDecimal(PUBLISHED_SPEED_REFERENCE.vramGb) })
    })
  }
  return undefined
}
