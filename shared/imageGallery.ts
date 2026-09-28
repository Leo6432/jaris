/**
 * Mode Image (étape 200) : nom et date d'une image dessinée, lus sur son nom de fichier
 * (`2026-09-28T17-22-15-un-chat-sur-la-lune.png`, voir imageFileName dans imageGenerator.ts). Module pur,
 * partagé par le main et l'écran, testé sans Electron.
 */

/** Seul un NOM de fichier PNG simple est accepté (il vient de l'écran) : jamais un chemin, jamais « .. ». */
export function isGeneratedImageFileName(name: unknown): name is string {
  return typeof name === 'string' && /^[\w-]+(\.[\w-]+)*\.png$/.test(name) && !name.includes('..')
}

const STAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-?/

/** L'horodatage est écrit en heure universelle (toISOString) : relu comme tel. `null` si le nom n'en a pas. */
export function imageTimestampFromFileName(fileName: string): number | null {
  const match = STAMP.exec(fileName)
  if (!match) return null
  const time = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`)
  return Number.isNaN(time) ? null : time
}

/** « un-chat-sur-la-lune » → « Un chat sur la lune » ; « Image » quand la description n'a laissé aucun mot. */
export function imageLabelFromFileName(fileName: string): string {
  const words = fileName.replace(/\.png$/i, '').replace(STAMP, '').replace(/-+/g, ' ').trim()
  if (!words || words === 'image') return 'Image'
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * « Dessin : étape 2 sur 4 » (journal de generateImage) → { step: 2, total: 4 } pour la barre du mode Image ;
 * `null` pour les autres lignes (préparation, finition…), qui restent affichées telles quelles.
 */
export function imageStepFromLog(line: string): { step: number; total: number } | null {
  const match = /étape (\d+) sur (\d+)/i.exec(line)
  if (!match) return null
  const step = Number(match[1])
  const total = Number(match[2])
  return total > 0 && step >= 0 && step <= total ? { step, total } : null
}
