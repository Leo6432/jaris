/**
 * Mode Image (étape 200) : nom et date d'une image dessinée, lus sur son nom de fichier
 * (`2026-09-28T17-22-15-un-chat-sur-la-lune.png`, voir imageFileName dans imageGenerator.ts). Module pur,
 * partagé par le main et l'écran, testé sans Electron.
 */
import { t, type MessageKey } from './i18n'

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

/** Étape 203 : même règle pour une vidéo créée par le mode Vidéo (`.webm`, lisible directement par l'écran). */
export function isGeneratedVideoFileName(name: unknown): name is string {
  return typeof name === 'string' && /^[\w-]+(\.[\w-]+)*\.webm$/.test(name) && !name.includes('..')
}

/**
 * « un-chat-sur-la-lune » → « Un chat sur la lune » ; « Image » / « Vidéo » quand la description n'a laissé aucun mot.
 * Ce cas n'est pas rare hors des langues à alphabet latin : le nom de fichier ne garde que a-z et 0-9, donc une
 * demande en russe ou en grec ne laisse aucun mot — le nom par défaut suit alors la langue de Jaris, comme le reste
 * de l'écran (il était écrit en dur en français, « Vidéo », jusqu'à la version 0.34.31).
 */
export function imageLabelFromFileName(fileName: string): string {
  const words = fileName.replace(/\.(png|webm)$/i, '').replace(STAMP, '').replace(/-+/g, ' ').trim()
  if (!words || words === 'image') return t('app.mode.image')
  if (words === 'video') return t('app.mode.video')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * « Dessin : étape 2 sur 4 » (journal de generateImage) → { step: 2, total: 4 } pour la barre du mode Image ;
 * `null` pour les autres lignes (préparation, finition…), qui restent affichées telles quelles.
 */
export function imageStepFromLog(line: string): { step: number; total: number } | null {
  // « Dessin : 2/4 » depuis l'étape 293 (la même forme dans toutes les langues) ; « étape 2 sur 4 » pour les anciens.
  const match = /(\d+)\s*\/\s*(\d+)\s*$/.exec(line) ?? /étape (\d+) sur (\d+)/i.exec(line)
  if (!match) return null
  const step = Number(match[1])
  const total = Number(match[2])
  return total > 0 && step >= 0 && step <= total ? { step, total } : null
}

/**
 * La ligne du journal qui annonce une étape du moteur de dessin ou de vidéo : « Dessin : 2/4 » en français,
 * « Drawing: 2/4 » en anglais (`labelKey` : engine.step.image ou engine.step.video). C'est la SEULE façon de la
 * fabriquer (runEngine, imageGenerator.ts) et la seule de la reconnaître (engineStepFromLine) : jusqu'à la version
 * 0.34.31, la reconnaissance du téléphone cherchait « <mot> : » avec l'espace française avant les deux-points, alors
 * que la ligne suivait la ponctuation de la langue — hors français, le téléphone n'affichait jamais l'avancement d'un
 * dessin.
 */
export function engineStepLine(labelKey: MessageKey, step: number, total: number): string {
  return t('common.labelValue', { label: t(labelKey), value: `${step}/${total}` })
}

/**
 * L'étape si `line` est exactement une ligne d'étape fabriquée par engineStepLine pour `labelKey`, dans la langue
 * courante ; `null` sinon (une autre ligne qui finirait par « 2/4 » n'est jamais prise pour une étape). Le gabarit
 * « {label} : {value} » est découpé autour de la valeur, d'où qu'elle soit placée dans la langue.
 */
export function engineStepFromLine(line: string, labelKey: MessageKey): { step: number; total: number } | null {
  const marker = '\u0000'
  const [before, after = ''] = t('common.labelValue', { label: t(labelKey), value: marker }).split(marker)
  const trimmed = line.trim()
  if (trimmed.length < before.length + after.length || !trimmed.startsWith(before) || !trimmed.endsWith(after)) return null
  const match = /^(\d+)\/(\d+)$/.exec(trimmed.slice(before.length, trimmed.length - after.length))
  if (!match) return null
  const step = Number(match[1])
  const total = Number(match[2])
  return total > 0 && step >= 0 && step <= total ? { step, total } : null
}
