import { createWriteStream } from 'fs'
import { mkdir, unlink } from 'fs/promises'
import { once } from 'events'
import { dirname } from 'path'
import { formatBytes } from '../../shared/formatBytes'

/**
 * Téléchargement de gros fichiers (installeurs), avec avancement au fil de l'eau (étape 98).
 *
 * Écrit après un retour de Léo : "quand on demande une mise à jour on ne sait pas quand c'est terminé et
 * des fois c'est bloqué et ça fait rien". Les trois téléchargements d'installeur de Jaris partageaient
 * exactement les deux mêmes défauts, mesurés pour de vrai avant d'écrire ce fichier (requête HTTP réelle
 * sur chaque fichier, pas une estimation) :
 *
 * 1. **Un délai TOTAL fixe, choisi sans jamais mesurer la taille du fichier.**
 *    - Jaris-Setup : 98 Mo avec un plafond de 120 s -> exige 7 Mbit/s SOUTENUS du début à la fin.
 *    - OllamaSetup (bouton "Mettre à jour") : 1,5 Go avec un plafond de 30 s -> 400 Mbit/s. Impossible.
 *    - OllamaSetup (premier lancement) : 1,5 Go avec un plafond de 120 s -> 100 Mbit/s. Impossible aussi.
 *    Un téléchargement qui avance parfaitement mais lentement était donc coupé en pleine réussite — et sur
 *    les deux derniers, il ne pouvait littéralement jamais aboutir. Remplacé par un délai d'INACTIVITÉ :
 *    seule l'absence totale de nouvelles données pendant une minute interrompt, ce qui n'a plus aucun
 *    rapport avec la taille du fichier ni avec le débit de la connexion. C'est la leçon déjà tirée pour
 *    l'installeur Docker Desktop (taille vérifiée par une requête HEAD avant de choisir un délai), mais
 *    appliquée cette fois d'une façon qui n'aura plus jamais besoin d'être recalculée quand un installeur
 *    grossira.
 * 2. **Aucun signe de vie.** Le fichier entier était chargé en mémoire (`await response.arrayBuffer()`)
 *    puis écrit d'un bloc : impossible de savoir où en est le téléchargement, et 1,5 Go en RAM au passage.
 *    Ici, le fichier est écrit au fur et à mesure et chaque paquet reçu met à jour l'avancement.
 *
 * Troisième défaut corrigé au passage : un téléchargement TRONQUÉ (connexion coupée à mi-chemin) produisait
 * un .exe incomplet, écrit sur le disque et lancé comme si de rien n'était — un installeur tronqué ne fait
 * rien de visible, exactement le "ça fait rien" décrit par Léo. La taille reçue est maintenant comparée à
 * celle annoncée par le serveur, et le fichier partiel est effacé plutôt que laissé en place.
 */
export interface DownloadProgress {
  receivedBytes: number
  /** Taille annoncée par le serveur (`Content-Length`), `null` s'il ne l'annonce pas. */
  totalBytes: number | null
  /** 0-100, `null` tant que la taille totale est inconnue (pas de barre possible dans ce cas). */
  percent: number | null
}

export interface DownloadOptions {
  onProgress?: (progress: DownloadProgress) => void
  /** Délai d'attente de la RÉPONSE initiale du serveur (pas du fichier entier). */
  connectTimeoutMs?: number
  /** Délai sans le moindre octet reçu avant d'abandonner — jamais un délai total, voir l'entête. */
  stallTimeoutMs?: number
}

export const CONNECT_TIMEOUT_MS = 30_000
export const STALL_TIMEOUT_MS = 60_000
/** Un évènement d'avancement au plus toutes les 200 ms : sur 1,5 Go, un par paquet inonderait l'IPC. */
const PROGRESS_INTERVAL_MS = 200

/** Erreur dont le message est DÉJÀ rédigé pour Léo : à afficher tel quel, jamais à réhabiller. */
export class DownloadError extends Error {}

/**
 * Transforme l'échec brut en une phrase lisible par quelqu'un qui n'est pas développeur. Séparée et
 * exportée pour être testable directement : les messages d'erreur de Jaris sont affichés TELS QUELS
 * (plus aucun modèle ne les reformule depuis le court-circuit d'assistant.ts), donc leur contenu compte
 * autant que le code qui les produit.
 */
export function describeDownloadFailure(
  error: unknown,
  context: { receivedBytes: number; totalBytes: number | null; stalledAfterMs: number | null }
): string {
  const { receivedBytes, stalledAfterMs } = context
  const seconds = stalledAfterMs === null ? 0 : Math.round(stalledAfterMs / 1000)

  if (stalledAfterMs !== null) {
    return receivedBytes === 0
      ? `Le serveur n'a pas répondu au bout de ${seconds} secondes : vérifie ta connexion internet, puis réessaie.`
      : `Téléchargement interrompu après ${formatBytes(receivedBytes)} (plus rien reçu pendant ${seconds} secondes) : ` +
          'vérifie ta connexion internet, puis réessaie.'
  }

  const code = (error as { code?: string } | null)?.code
  if (code === 'ENOSPC') {
    return "Plus assez de place sur le disque pour télécharger le fichier : fais un peu de place, puis réessaie."
  }
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
    return (
      'Windows a refusé d\'écrire le fichier téléchargé (un antivirus, ou une installation déjà en cours) : ' +
      'redémarre Jaris, puis réessaie.'
    )
  }

  const message = error instanceof Error ? error.message : String(error)
  // Message exact de fetch quand la connexion ne s'établit pas du tout — incompréhensible tel quel.
  if (message === 'fetch failed') {
    return "Impossible de joindre le serveur : pas de connexion internet, ou un pare-feu bloque l'accès."
  }
  if ((error as { name?: string } | null)?.name === 'AbortError') {
    return receivedBytes === 0
      ? 'Le téléchargement a été interrompu avant même de commencer : réessaie.'
      : `Le téléchargement a été interrompu après ${formatBytes(receivedBytes)} : réessaie.`
  }
  return `Le téléchargement a échoué : ${message}`
}

/**
 * Télécharge `url` vers `destination` et renvoie le nombre d'octets réellement écrits. Lève une
 * `DownloadError` (message déjà rédigé pour l'utilisateur) en cas d'échec, après avoir effacé le fichier
 * partiel : l'appelant n'a jamais à se demander si ce qui est sur le disque est complet ou non.
 */
export async function downloadToFile(url: string, destination: string, options: DownloadOptions = {}): Promise<number> {
  const { onProgress, connectTimeoutMs = CONNECT_TIMEOUT_MS, stallTimeoutMs = STALL_TIMEOUT_MS } = options

  const controller = new AbortController()
  let stalledAfterMs: number | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  /** (Ré)arme le chien de garde : chaque paquet reçu repousse l'échéance, un fichier qui avance n'expire jamais. */
  const arm = (ms: number): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      stalledAfterMs = ms
      controller.abort()
    }, ms)
  }

  let receivedBytes = 0
  let totalBytes: number | null = null

  try {
    // Une nouvelle racine choisie dans « Déplacer » n'a pas encore de dossier downloads.
    // Créer le parent avant la requête évite qu'un WriteStream émette ENOENT sans listener
    // (exception non interceptée dans le processus principal Electron).
    await mkdir(dirname(destination), { recursive: true })
    arm(connectTimeoutMs)
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) {
      throw new DownloadError(`Le serveur a répondu « HTTP ${response.status} » au lieu d'envoyer le fichier.`)
    }
    if (!response.body) throw new DownloadError("Le serveur a répondu sans le moindre fichier à télécharger.")

    const announced = Number(response.headers.get('content-length'))
    totalBytes = Number.isFinite(announced) && announced > 0 ? announced : null

    const report = (): void => {
      onProgress?.({
        receivedBytes,
        totalBytes,
        percent: totalBytes === null ? null : Math.min(100, Math.round((receivedBytes / totalBytes) * 100))
      })
    }
    report()

    const file = createWriteStream(destination)
    let streamError: Error | null = null
    file.on('error', (error) => {
      streamError = error
      controller.abort()
    })
    const reader = response.body.getReader()
    let lastReport = 0
    try {
      arm(stallTimeoutMs)
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        arm(stallTimeoutMs)
        receivedBytes += value.byteLength
        // `write` renvoie false quand le tampon est plein : sans attendre 'drain', un fichier d'1,5 Go
        // s'accumulerait en mémoire au lieu de partir sur le disque — exactement ce qu'on voulait éviter.
        if (!file.write(value)) await once(file, 'drain')
        if (streamError) throw streamError
        const now = Date.now()
        if (now - lastReport >= PROGRESS_INTERVAL_MS) {
          lastReport = now
          report()
        }
      }
      await new Promise<void>((resolve, reject) => file.end((error?: Error | null) => (error ? reject(error) : resolve())))
      if (streamError) throw streamError
    } catch (err) {
      file.destroy()
      throw streamError ?? err
    }
    report()

    if (totalBytes !== null && receivedBytes !== totalBytes) {
      throw new DownloadError(
        `Téléchargement incomplet : ${formatBytes(receivedBytes)} reçus sur ${formatBytes(totalBytes)} annoncés. ` +
          'Vérifie ta connexion internet, puis réessaie.'
      )
    }
    return receivedBytes
  } catch (err) {
    // Jamais laisser un fichier partiel derrière soi : un installeur tronqué se lance sans rien faire.
    await unlink(destination).catch(() => undefined)
    throw err instanceof DownloadError
      ? err
      : new DownloadError(describeDownloadFailure(err, { receivedBytes, totalBytes, stalledAfterMs }))
  } finally {
    if (timer) clearTimeout(timer)
  }
}
