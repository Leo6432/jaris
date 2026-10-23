import type { AudioInputDevice, Profile } from '../../shared/ipc'

/**
 * Valeur du menu « Micro utilisé » (Options → Voix). Étape 346 : le micro est retrouvé par son NOM — son numéro change
 * dès qu'on branche un casque, et le menu montrait alors un autre micro que celui réellement écouté. Le numéro ne sert
 * que pour un profil enregistré avant cette version (sans nom). Un micro choisi mais débranché : « par défaut ».
 */
export function selectedInputDevice(
  profile: Pick<Profile, 'audioInputDeviceIndex' | 'audioInputDeviceName'> | null | undefined,
  devices: AudioInputDevice[] | null
): string {
  const name = profile?.audioInputDeviceName
  if (name) {
    if (!devices) return ''
    const wanted = name.trim().toLowerCase()
    const found = devices.find((device) => device.name.trim().toLowerCase() === wanted)
    return found ? String(found.index) : ''
  }
  const index = profile?.audioInputDeviceIndex
  if (index === null || index === undefined) return ''
  if (devices && !devices.some((device) => device.index === index)) return ''
  return String(index)
}
