import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { dirname } from 'path'
import type { PhoneDevice } from '../../shared/ipc'

interface StoredDevice extends PhoneDevice {
  /** SHA-256 du jeton : le jeton lui-même n'est jamais écrit sur le disque, seulement sur le téléphone. */
  tokenHash: string
}

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest()
}

/**
 * Téléphones appairés (étape 214), un fichier JSON dans les données de Jaris. Chaque téléphone a son propre
 * jeton : « Déconnecter » en retire un seul, et un téléphone volé se coupe sans toucher aux autres.
 */
export class PhoneDeviceStore {
  constructor(private readonly filePath: string) {}

  private async read(): Promise<StoredDevice[]> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf-8')) as { devices?: StoredDevice[] }
      return Array.isArray(parsed.devices) ? parsed.devices : []
    } catch {
      return []
    }
  }

  private async write(devices: StoredDevice[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    // Écrit à côté puis renomme : un arrêt en pleine écriture ne laisse jamais un fichier à moitié écrit,
    // qui déconnecterait tous les téléphones d'un coup.
    const temporary = `${this.filePath}.tmp`
    await writeFile(temporary, JSON.stringify({ devices }, null, 2), 'utf-8')
    await rename(temporary, this.filePath)
  }

  async list(): Promise<PhoneDevice[]> {
    return (await this.read()).map(({ id, name, createdAt, lastSeenAt }) => ({ id, name, createdAt, lastSeenAt }))
  }

  /** Nouveau téléphone : renvoie son jeton, une seule fois (il n'est gardé ici que sous forme d'empreinte). */
  async add(name: string, now = Date.now()): Promise<{ device: PhoneDevice; token: string }> {
    const token = randomBytes(32).toString('base64url')
    const device: StoredDevice = {
      id: randomUUID(),
      name: name.trim().slice(0, 60) || 'Téléphone',
      createdAt: new Date(now).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
      tokenHash: hashToken(token).toString('hex')
    }
    await this.write([...(await this.read()), device])
    const { tokenHash: _hash, ...visible } = device
    return { device: visible, token }
  }

  /** Le téléphone qui porte ce jeton, ou null. Comparaison à temps constant, sur les empreintes. */
  async findByToken(token: string): Promise<PhoneDevice | null> {
    if (!token || token.length > 200) return null
    const candidate = hashToken(token)
    for (const device of await this.read()) {
      const stored = Buffer.from(device.tokenHash, 'hex')
      if (stored.length === candidate.length && timingSafeEqual(stored, candidate)) {
        const { tokenHash: _hash, ...visible } = device
        return visible
      }
    }
    return null
  }

  /** Mis à jour au plus une fois par minute : inutile de réécrire le fichier à chaque message. */
  async touch(id: string, now = Date.now()): Promise<void> {
    const devices = await this.read()
    const device = devices.find((d) => d.id === id)
    if (!device || now - Date.parse(device.lastSeenAt) < 60_000) return
    device.lastSeenAt = new Date(now).toISOString()
    await this.write(devices)
  }

  async remove(id: string): Promise<void> {
    await this.write((await this.read()).filter((d) => d.id !== id))
  }

  async removeAll(): Promise<void> {
    await this.write([])
  }
}
