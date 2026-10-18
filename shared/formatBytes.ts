import { formatDecimal, t } from './i18n'
/**
 * Taille de fichier lisible ("98 Mo", "1,5 Go"), en français (virgule décimale, "o" pour octets).
 *
 * Dans `shared/` et pas dans `src/lib/` ni dans `electron/services/` parce que les DEUX côtés l'affichent :
 * le main process l'utilise dans ses messages d'erreur de téléchargement (download.ts), le renderer dans la
 * barre de progression de la mise à jour (OptionsMenu.tsx). Deux copies auraient fini par diverger — le
 * piège déjà rencontré avec les types dupliqués de `shared/ipc.ts` et avec les deux composeurs (étape 92).
 */
export function formatBytes(bytes: number): string {
  // Étape 293 : les unités suivent la langue (« Go » en français, « GB » en anglais, « ГБ » en russe) et la virgule
  // décimale aussi (Intl) : « 1,5 Go », « 1.5 GB ».
  const decimal = (value: number): string => formatDecimal(value, 1)
  if (!Number.isFinite(bytes) || bytes < 0) return t('unit.b', { value: 0 })
  const go = bytes / 1024 ** 3
  if (go >= 1) return t('unit.gb', { value: decimal(go) })
  const mo = bytes / 1024 ** 2
  if (mo >= 1) return t('unit.mb', { value: Math.round(mo) })
  const ko = bytes / 1024
  if (ko >= 1) return t('unit.kb', { value: Math.round(ko) })
  return t('unit.b', { value: Math.round(bytes) })
}
