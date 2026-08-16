import { app } from 'electron'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import type { Profile } from '../../shared/ipc'

const profilePath = join(app.getPath('userData'), 'profile.json')

/** null tant que l'utilisateur n'a pas encore renseigné son prénom (premier lancement). */
export async function getProfile(): Promise<Profile | null> {
  try {
    const raw = await readFile(profilePath, 'utf-8')
    return JSON.parse(raw) as Profile
  } catch {
    return null
  }
}

export async function saveProfile(profile: Profile): Promise<void> {
  await mkdir(dirname(profilePath), { recursive: true })
  await writeFile(profilePath, JSON.stringify(profile, null, 2), 'utf-8')
}

/** Marque l'écran "connecter Gmail ou ignorer" comme déjà vu, pour ne plus le remontrer au lancement suivant. */
export async function markGmailOnboardingDone(): Promise<void> {
  const profile = await getProfile()
  if (!profile) return
  await saveProfile({ ...profile, gmailOnboardingDone: true })
}
