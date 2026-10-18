import { join } from 'path'
import type { Profile } from '../../shared/ipc'
import { UNREADABLE_DATA_DIR, readJsonDataFile, writeFileAtomic } from './atomicFile'
import { getDataRoot } from './dataLocation'

const profilePath = join(getDataRoot(), 'profile.json')
/** Où un profil abîmé est rangé avant d'être remplacé (atomicFile.ts) : il suit « Déplacer » avec le reste. */
const unreadableDir = join(getDataRoot(), UNREADABLE_DATA_DIR)

const parseProfile = (value: unknown): Profile | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Profile) : null

/**
 * null tant que l'utilisateur n'a pas encore renseigné son prénom (premier lancement).
 *
 * Étape 325 : avant, TOUTE erreur de lecture rendait null — un profil tronqué (coupure de courant pendant une
 * écriture) ou verrouillé un instant par un antivirus relançait l'écran de premier lancement, dont le premier
 * enregistrement (le prénom seul) écrasait le vrai profil, choix des modèles compris. Désormais :
 * - abîmé : rangé de côté (fichiers-illisibles), PUIS null — rien n'est perdu ;
 * - momentanément illisible : réessayé, puis DataFileUnreadableError — jamais pris pour « aucun profil ».
 */
export async function getProfile(): Promise<Profile | null> {
  const read = await readJsonDataFile(profilePath, parseProfile, unreadableDir, 'profile')
  return read.status === 'ok' ? read.value : null
}

/** Écrit d'un seul tenant (atomicFile.ts) : une coupure en pleine écriture laisse l'ancien profil intact. */
export async function saveProfile(profile: Profile): Promise<void> {
  await writeFileAtomic(profilePath, JSON.stringify(profile, null, 2))
}
