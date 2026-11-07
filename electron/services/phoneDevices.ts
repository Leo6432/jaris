import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import { dirname, join } from 'path'
import type { PhoneDevice } from '../../shared/ipc'
import { t } from '../../shared/i18n'
import { UNREADABLE_DATA_DIR, readJsonDataFile, writeFileAtomic } from './atomicFile'

interface StoredDevice extends PhoneDevice {
  /** SHA-256 du jeton : le jeton lui-même n'est jamais écrit sur le disque, seulement sur le téléphone. */
  tokenHash: string
}

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest()
}

const isStoredDevice = (value: unknown): value is StoredDevice => {
  const device = value as Partial<StoredDevice> | null
  return (
    typeof device === 'object' &&
    device !== null &&
    typeof device.id === 'string' &&
    typeof device.name === 'string' &&
    typeof device.createdAt === 'string' &&
    typeof device.lastSeenAt === 'string' &&
    typeof device.tokenHash === 'string'
  )
}

/** La liste du fichier, ou `null` si sa forme ne va pas (rangé de côté par readJsonDataFile, jamais pris pour vide). */
const parseDevices = (value: unknown): StoredDevice[] | null => {
  const devices = (value as { devices?: unknown } | null)?.devices
  return Array.isArray(devices) && devices.every(isStoredDevice) ? devices : null
}

/**
 * Téléphones appairés (étape 214), un fichier JSON dans les données de Jaris. Chaque téléphone a son propre
 * jeton : « Déconnecter » en retire un seul, et un téléphone volé se coupe sans toucher aux autres.
 *
 * Relecture croisée : chaque requête du téléphone mettait à jour « vu le » (touch) sans attendre, et ces mises à jour
 * se croisaient — deux relectures de la même liste, deux écritures dans le même temporaire : une liste mélangée était
 * ensuite prise pour vide et TOUS les téléphones étaient oubliés. Une liste verrouillée un instant (antivirus) était
 * aussi prise pour vide : un appairage ou un retrait réécrivait alors la liste sans les autres ; et un « vu le » parti
 * juste avant un retrait faisait revenir le téléphone retiré. Désormais :
 * - fichier absent : aucun téléphone ; verrouillé : erreur, rien n'est réécrit ; abîmé : rangé de côté
 *   (fichiers-illisibles), jamais écrasé sans copie ;
 * - chaque modification relit la liste PUIS l'écrit, une à la fois (file exclusive), d'un seul tenant (atomicFile.ts).
 */
export class PhoneDeviceStore {
  /** Une modification à la fois : une relecture suivie d'une écriture ne peut pas être coupée par une autre. */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task)
    this.chain = run.catch(() => undefined)
    return run
  }

  private async read(): Promise<StoredDevice[]> {
    const read = await readJsonDataFile(this.filePath, parseDevices, join(dirname(this.filePath), UNREADABLE_DATA_DIR), 'phone-devices')
    return read.status === 'ok' ? read.value : []
  }

  /** Seulement depuis `exclusive`, d'un seul tenant (temporaire forcé sur le disque, puis renommage). */
  private async write(devices: StoredDevice[]): Promise<void> {
    await writeFileAtomic(this.filePath, JSON.stringify({ devices }, null, 2))
  }

  async list(): Promise<PhoneDevice[]> {
    return (await this.read()).map(({ id, name, createdAt, lastSeenAt }) => ({ id, name, createdAt, lastSeenAt }))
  }

  /** Nouveau téléphone : renvoie son jeton, une seule fois (il n'est gardé ici que sous forme d'empreinte). */
  async add(name: string, now = Date.now()): Promise<{ device: PhoneDevice; token: string }> {
    const token = randomBytes(32).toString('base64url')
    const device: StoredDevice = {
      id: randomUUID(),
      name: name.trim().slice(0, 60) || t('phone.defaultName'),
      createdAt: new Date(now).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
      tokenHash: hashToken(token).toString('hex')
    }
    await this.exclusive(async () => this.write([...(await this.read()), device]))
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

  /**
   * Mis à jour au plus une fois par minute : inutile de réécrire le fichier à chaque message. Relu DANS la file : un
   * téléphone retiré entre-temps n'est jamais réécrit.
   */
  touch(id: string, now = Date.now()): Promise<void> {
    return this.exclusive(async () => {
      const devices = await this.read()
      const device = devices.find((d) => d.id === id)
      if (!device || now - Date.parse(device.lastSeenAt) < 60_000) return
      device.lastSeenAt = new Date(now).toISOString()
      await this.write(devices)
    })
  }

  remove(id: string): Promise<void> {
    return this.exclusive(async () => {
      const devices = await this.read()
      const kept = devices.filter((d) => d.id !== id)
      if (kept.length !== devices.length) await this.write(kept)
    })
  }

  /** « Se déconnecter de Tailscale » : tous oubliés (rien à relire). */
  removeAll(): Promise<void> {
    return this.exclusive(() => this.write([]))
  }
}
