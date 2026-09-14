/**
 * Taille de fichier lisible ("98 Mo", "1,5 Go"), en français (virgule décimale, "o" pour octets).
 *
 * Dans `shared/` et pas dans `src/lib/` ni dans `electron/services/` parce que les DEUX côtés l'affichent :
 * le main process l'utilise dans ses messages d'erreur de téléchargement (download.ts), le renderer dans la
 * barre de progression de la mise à jour (OptionsMenu.tsx). Deux copies auraient fini par diverger — le
 * piège déjà rencontré avec les types dupliqués de `shared/ipc.ts` et avec les deux composeurs (étape 92).
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 o'
  const go = bytes / 1024 ** 3
  if (go >= 1) return `${go.toFixed(1).replace('.', ',')} Go`
  const mo = bytes / 1024 ** 2
  if (mo >= 1) return `${Math.round(mo)} Mo`
  const ko = bytes / 1024
  if (ko >= 1) return `${Math.round(ko)} Ko`
  return `${Math.round(bytes)} o`
}
