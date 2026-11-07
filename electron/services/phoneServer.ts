import { randomInt, randomUUID } from 'crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { isIP, type AddressInfo } from 'net'
import type { ChatMessage, ModelChoiceInfo, PhoneDevice } from '../../shared/ipc'
import type { PhoneDeviceStore } from './phoneDevices'
import { currentLanguage, currentLocale, t, type MessageKey } from '../../shared/i18n'
import { fr } from '../../shared/i18n/fr'
import { uiBlocksToText } from '../../shared/uiBlocks'

/**
 * Serveur du téléphone (étape 214). Il n'écoute QUE sur 127.0.0.1 : rien sur le réseau local, rien sur
 * internet. Le seul chemin depuis l'extérieur est le tunnel Tailscale (jaris-tunnel), qui chiffre jusqu'au
 * PC puis transmet ici. Tout ce qui touche à Jaris passe par un jeton d'appareil, obtenu une fois avec le code
 * d'appairage affiché sur le PC.
 */

export interface PhoneReply {
  reply: string
  image?: string
}

/** Ce que le téléphone peut créer, d'après l'état des modes Image et Vidéo du PC. */
export interface PhoneStudio {
  image: { ready: boolean; reason: string | null }
  video: { ready: boolean; reason: string | null; qualities: { id: string; label: string }[]; durations: number[] }
}

/** Le téléphone ne règle que les modes qu'il utilise : Chat et Vocal (le mode Code n'existe pas sur le téléphone). */
export type PhoneModelMode = 'chat' | 'voice'

function phoneModelMode(value: unknown): PhoneModelMode {
  if (value === 'chat' || value === 'voice') return value
  throw new HttpError(400, t('phone.err.mode'))
}

export interface PhoneMedia {
  fileName: string
  label: string
  timestamp: number
}

export interface PhoneServerDeps {
  /**
   * Envoie le message dans la conversation active de Jaris (outils restreints), progression comprise.
   * `mode` vaut 'voice' pour l'onglet Vocal : la réponse sera lue à voix haute, donc sans mise en forme.
   */
  sendMessage(text: string, onStatus: (status: string) => void, mode: 'chat' | 'voice'): Promise<PhoneReply>
  /** Transcrit un WAV 16 kHz mono sur le PC (la même transcription que la voix). */
  transcribe(wav: Buffer): Promise<string>
  /** Lit la réponse avec la voix de Jaris (Supertonic, sur le PC) : un WAV. */
  speak(text: string): Promise<Buffer>
  /** État des modes Image et Vidéo : seules les qualités DÉJÀ installées sur le PC sont proposées. */
  studio(): Promise<PhoneStudio>
  generateImage(prompt: string, onStatus: (status: string) => void, signal: AbortSignal): Promise<{ fileName: string }>
  generateVideo(
    prompt: string,
    seconds: number,
    quality: string,
    onStatus: (status: string) => void,
    signal: AbortSignal
  ): Promise<{ fileName: string }>
  listImages(): Promise<PhoneMedia[]>
  listVideos(): Promise<PhoneMedia[]>
  /** Lève une erreur pour un nom qui n'est pas une image (ou vidéo) créée par Jaris : jamais un chemin. */
  readImage(fileName: string): Promise<Buffer>
  /** Vignette JPEG réduite pour la galerie : quelques dizaines de Ko au lieu d'un PNG de plus d'1 Mo en 4G. */
  readImageThumbnail(fileName: string): Promise<Buffer>
  readVideo(fileName: string): Promise<Buffer>
  /** Sélecteur de modèle et de réflexion, le même que sur le PC (Chat et Vocal seulement). */
  getModelChoice(mode: PhoneModelMode): Promise<ModelChoiceInfo>
  setModelChoice(mode: PhoneModelMode, model: string | null): Promise<void>
  setThinkChoice(mode: PhoneModelMode, think: unknown): Promise<void>
  /** Programme l'extinction du PC dans `seconds` (annulable d'ici là). */
  shutdown(seconds: number): Promise<void>
  cancelShutdown(): Promise<void>
  /** Derniers messages de la conversation active, pour que le téléphone reprenne là où on en est. */
  history(): Promise<ChatMessage[]>
  devices: PhoneDeviceStore
  /** Dossier des fichiers de la page (index.html, app.js…). */
  pageDir: string
  now?: () => number
}

export type JobState = 'running' | 'done' | 'error' | 'cancelled'

/**
 * Deux files indépendantes : parler à Jaris (Chat, Vocal) et créer (Image, Vidéo). Une vidéo de plusieurs
 * minutes ne bloque donc pas la conversation, mais deux messages ne se croisent jamais dans la même conversation.
 */
type Lane = 'conversation' | 'studio'

interface Job {
  id: string
  lane: Lane
  state: JobState
  status: string
  transcript?: string
  reply?: string
  image?: string
  /** Réponse lue à voix haute (onglet Vocal), servie à part par /api/jobs/:id/audio. */
  audio?: Buffer
  /** Image ou vidéo créée (onglets Image et Vidéo). */
  fileName?: string
  error?: string
  finishedAt?: number
  abort?: AbortController
  /** Se résout quand le travail est fini (réussi, raté ou arrêté). */
  settled?: Promise<void>
}

/** Fichiers de la page, servis par leur nom exact uniquement : aucun chemin venu de la requête n'est suivi. */
const PAGE_FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/manifest.webmanifest': { file: 'manifest.webmanifest', type: 'application/manifest+json' },
  '/icon-192.png': { file: 'icon-192.png', type: 'image/png' },
  '/icon-512.png': { file: 'icon-512.png', type: 'image/png' },
  '/logo.png': { file: 'logo.png', type: 'image/png' },
  // Garde la page sur le téléphone : PC éteint, elle s'ouvre quand même et peut le dire (étape 218).
  '/sw.js': { file: 'sw.js', type: 'text/javascript; charset=utf-8' }
}

/**
 * Étape 293 : les textes de la page du téléphone (clés `pwa.*`), dans la langue de Jaris au moment où la page est
 * chargée. Un fichier à part plutôt qu'un script dans la page : la page interdit tout script en ligne (CSP).
 */
export function phonePageI18nScript(): string {
  const messages: Record<string, string> = {}
  for (const key of Object.keys(fr) as MessageKey[]) if (key.startsWith('pwa.')) messages[key] = t(key)
  // Le chemin vers l'écran d'appairage, avec les vrais noms affichés sur le PC dans cette langue.
  messages['pwa.pair.path'] = `${t('options.title')} → ${t('options.tab.phone')} → ${t('phone.connect')}`
  return `window.JARIS_I18N = ${JSON.stringify({ lang: currentLanguage(), locale: currentLocale(), messages })}\n`
}

/** Délai avant l'extinction demandée depuis le téléphone : le temps de se raviser et d'annuler. */
export const POWER_OFF_DELAY_S = 60

export const PAIRING_CODE_TTL_MS = 10 * 60_000
/** Mauvais codes permis à UN appareil pour un même code : au-delà, cet appareil-là ne peut plus s'en servir. */
export const PAIRING_ATTEMPTS_PER_CODE = 5
/** Essais par minute pour UN appareil. */
export const PAIRING_ATTEMPTS_PER_MINUTE = 10
/**
 * Mauvais codes tous appareils confondus avant que le code ne tombe : la protection contre une force brute répartie sur
 * beaucoup d'adresses. 100 essais pour 100 millions de codes possibles : une chance sur un million.
 */
export const PAIRING_FAILURES_PER_CODE = 100
/** Appareils suivis au plus pour la limite par minute (la mémoire ne grossit pas sans fin). */
const MAX_TRACKED_SOURCES = 10_000
const MAX_JSON_BYTES = 64 * 1024
/** ~2 min 40 de voix en WAV 16 kHz mono 16 bits : largement assez pour un message vocal. */
export const MAX_VOICE_BYTES = 5 * 1024 * 1024
const MAX_TEXT_CHARS = 4000
const MAX_PROMPT_CHARS = 1000
const KEPT_JOBS = 20
/** Un nom de fichier créé par Jaris (horodatage + mots sans accent) : rien d'autre n'est même regardé. */
const MEDIA_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8'): void {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-store' })
  res.end(payload)
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0)
    if (declared > limit) {
      reject(new HttpError(413, t('phone.err.tooLong')))
      req.resume()
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new HttpError(413, t('phone.err.tooLong')))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req, MAX_JSON_BYTES)
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    // traité juste en dessous
  }
  throw new HttpError(400, t('phone.err.badRequest'))
}

/** Vérifie que c'est bien un WAV PCM 16 bits mono 16 kHz, le seul format que la page envoie. */
export function isExpectedWav(buffer: Buffer): boolean {
  if (buffer.length < 44) return false
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return false
  if (buffer.toString('ascii', 12, 16) !== 'fmt ') return false
  const format = buffer.readUInt16LE(20)
  const channels = buffer.readUInt16LE(22)
  const rate = buffer.readUInt32LE(24)
  const bits = buffer.readUInt16LE(34)
  return format === 1 && channels === 1 && rate === 16000 && bits === 16
}

/**
 * L'appareil qui tente de s'appairer. Tout arrive de 127.0.0.1 (le tunnel) : c'est jaris-tunnel qui donne l'adresse de
 * l'appareil (X-Jaris-Client, avec X-Jaris-Tunnel), posée par lui et jamais reprise de ce qu'envoie internet. Une adresse
 * IPv6 compte pour son réseau (/64) : un seul abonné en a des milliards. Sans elle : la connexion elle-même (ce PC).
 */
export function pairingSource(req: IncomingMessage): string {
  const header = req.headers['x-jaris-client']
  const client = req.headers['x-jaris-tunnel'] === '1' && typeof header === 'string' ? header.trim().toLowerCase() : ''
  const family = client ? isIP(client) : 0
  // Une IPv4 écrite à la façon IPv6 (::ffff:a.b.c.d) compte pour elle-même (le tunnel la donne déjà en IPv4).
  if (family === 4 || (family === 6 && client.includes('.'))) return `ip:${client}`
  if (family === 6) return `ip6:${ipv6Network(client)}`
  return `local:${req.socket.remoteAddress ?? ''}`
}

/** Les 4 premiers groupes (le réseau /64) d'une adresse IPv6 valide, forme abrégée « :: » comprise. */
function ipv6Network(address: string): string {
  const halves = address.split('::')
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length > 1 && halves[1] ? halves[1].split(':') : []
  const groups = halves.length > 1 ? [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left
  return groups
    .slice(0, 4)
    .map((group) => (Number.parseInt(group, 16) || 0).toString(16))
    .join(':')
}

export class PhoneServer {
  private server: Server | null = null
  /** Le code affiché sur le PC ; ses mauvais essais, au total et par appareil (pairingSource). */
  private pairing: { code: string; expiresAt: number; failures: number; failuresBySource: Map<string, number> } | null = null
  /** Essais récents de chaque appareil (pairingSource), pour la limite par minute. */
  private pairAttempts = new Map<string, number[]>()
  private jobs = new Map<string, Job>()
  private busy: Record<Lane, boolean> = { conversation: false, studio: false }
  /** Heure prévue de l'extinction demandée depuis le téléphone, ou null. */
  private shutdownAt: number | null = null
  private readonly now: () => number

  constructor(private readonly deps: PhoneServerDeps) {
    this.now = deps.now ?? Date.now
  }

  /** Démarre sur 127.0.0.1, port choisi par le système. Renvoie le port. */
  async listen(): Promise<number> {
    if (this.server) return (this.server.address() as AddressInfo).port
    const server = createServer((req, res) => void this.handle(req, res))
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    return (server.address() as AddressInfo).port
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = null
    this.pairing = null
    if (!server) return
    // Sans ça, close() attend la fin des connexions gardées ouvertes par le téléphone (suivi d'une réponse) :
    // « Désactiver » pourrait ne jamais aboutir tant qu'un téléphone reste sur la page.
    const closed = new Promise<void>((resolve) => server.close(() => resolve()))
    server.closeAllConnections()
    await closed
  }

  /** Nouveau code d'appairage à 8 chiffres, valable 10 minutes et une seule fois ; remplace le précédent. */
  createPairingCode(): { code: string; expiresAt: number } {
    const code = String(randomInt(0, 100_000_000)).padStart(8, '0')
    const expiresAt = this.now() + PAIRING_CODE_TTL_MS
    this.pairing = { code, expiresAt, failures: 0, failuresBySource: new Map() }
    return { code, expiresAt }
  }

  cancelPairingCode(): void {
    this.pairing = null
  }

  private async authenticate(req: IncomingMessage): Promise<PhoneDevice> {
    const header = req.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    const device = token ? await this.deps.devices.findByToken(token) : null
    if (!device) throw new HttpError(401, t('phone.err.notPaired'))
    // « Vu le » : au plus une fois par minute (la page interroge le PC toutes les secondes pendant une réponse). Sans
    // attendre : la requête n'en dépend pas ; un échec (fichier verrouillé un instant) laisse la liste intacte.
    const now = this.now()
    if (!(now - Date.parse(device.lastSeenAt) < 60_000)) {
      void this.deps.devices.touch(device.id, now).catch((err: unknown) => console.warn('[phone] « vu le » non enregistré :', err))
    }
    return device
  }

  /** Oublie les appareils sans essai depuis une minute, puis les plus anciens si la liste reste trop longue. */
  private forgetOldPairAttempts(now: number): void {
    if (this.pairAttempts.size <= MAX_TRACKED_SOURCES) return
    for (const [source, attempts] of this.pairAttempts) if (attempts.every((at) => now - at >= 60_000)) this.pairAttempts.delete(source)
    for (const source of this.pairAttempts.keys()) {
      if (this.pairAttempts.size <= MAX_TRACKED_SOURCES) break
      this.pairAttempts.delete(source)
    }
  }

  /**
   * Relecture croisée : la limite d'essais était COMMUNE à tout internet (l'adresse publique Funnel), et 5 mauvais codes,
   * de qui que ce soit, annulaient le code de Léo : un inconnu pouvait l'empêcher de connecter son téléphone. Désormais
   * chaque appareil a sa limite (pairingSource) et ses 5 essais ; seul un très grand nombre d'échecs au total (une force
   * brute répartie) fait tomber le code.
   */
  private async pair(req: IncomingMessage): Promise<{ token: string }> {
    const now = this.now()
    const source = pairingSource(req)
    const recent = (this.pairAttempts.get(source) ?? []).filter((at) => now - at < 60_000)
    if (recent.length >= PAIRING_ATTEMPTS_PER_MINUTE) throw new HttpError(429, t('phone.err.tooManyAttempts'))
    recent.push(now)
    this.pairAttempts.delete(source)
    this.pairAttempts.set(source, recent)
    this.forgetOldPairAttempts(now)

    const body = await readJson(req)
    const code = typeof body.code === 'string' ? body.code.replace(/\D/g, '') : ''
    const name = typeof body.name === 'string' ? body.name : t('phone.defaultName')
    const pairing = this.pairing
    const expired = (): HttpError => new HttpError(403, t('phone.err.codeExpired', { path: `${t('options.title')} → ${t('options.tab.phone')}` }))
    if (!pairing || now > pairing.expiresAt) {
      this.pairing = null
      throw expired()
    }
    // Cet appareil s'est déjà trompé 5 fois sur CE code : il ne peut plus s'en servir, même avec le bon (comme avant pour
    // Léo, qui affiche alors un nouveau code) — mais le code reste valable pour les autres.
    const failed = pairing.failuresBySource.get(source) ?? 0
    if (failed >= PAIRING_ATTEMPTS_PER_CODE) throw expired()
    if (code !== pairing.code) {
      pairing.failuresBySource.set(source, failed + 1)
      pairing.failures += 1
      if (pairing.failures >= PAIRING_FAILURES_PER_CODE) this.pairing = null
      throw new HttpError(403, t('phone.err.badCode'))
    }
    // Usage unique : le même code ne connecte jamais un second appareil.
    this.pairing = null
    const { token } = await this.deps.devices.add(name, now)
    return { token }
  }

  private startJob(lane: Lane, work: (job: Job) => Promise<void>, abort?: AbortController): Job {
    if (this.busy[lane])
      throw new HttpError(
        409,
        lane === 'conversation' ? t('phone.err.conversationBusy') : t('phone.err.studioBusy')
      )
    this.busy[lane] = true
    const job: Job = { id: randomUUID(), lane, state: 'running', status: lane === 'conversation' ? t('phone.status.thinking') : t('phone.status.preparing'), abort }
    this.jobs.set(job.id, job)
    // Seuls des travaux FINIS sont oubliés : une vidéo longue ne doit jamais disparaître pendant qu'elle se fait.
    for (const [id, old] of this.jobs) {
      if (this.jobs.size <= KEPT_JOBS) break
      if (old.state !== 'running') this.jobs.delete(id)
    }
    job.settled = work(job)
      .then(() => {
        job.state = 'done'
      })
      .catch((err: unknown) => {
        if (abort?.signal.aborted) {
          job.state = 'cancelled'
          return
        }
        job.state = 'error'
        job.error = err instanceof Error ? err.message : String(err)
      })
      .finally(() => {
        job.finishedAt = this.now()
        job.abort = undefined
        this.busy[lane] = false
      })
    return job
  }

  /**
   * Relecture croisée : arrête les créations en cours (images, vidéos) et attend qu'elles soient vraiment finies.
   * « Déplacer » (main.ts) l'appelle avant de copier les données : le moteur de dessin garde ses fichiers ouverts.
   */
  async stopStudioJobs(): Promise<void> {
    const running = [...this.jobs.values()].filter((job) => job.lane === 'studio' && job.state === 'running')
    for (const job of running) job.abort?.abort()
    await Promise.all(running.map((job) => job.settled))
  }

  private async answer(job: Job, text: string, mode: 'chat' | 'voice'): Promise<void> {
    const result = await this.deps.sendMessage(
      text,
      (status) => {
        job.status = status
      },
      mode
    )
    // La page du téléphone ne dessine pas les blocs interactifs du Chat : leur version texte, jamais du JSON.
    job.reply = uiBlocksToText(result.reply)
    if (result.image) job.image = result.image
  }

  private async transcribeInto(job: Job, wav: Buffer): Promise<string> {
    job.status = t('phone.status.transcribing')
    const transcript = (await this.deps.transcribe(wav)).trim()
    if (!transcript) throw new Error(t('phone.err.nothingHeard'))
    job.transcript = transcript
    job.status = t('phone.status.thinking')
    return transcript
  }

  /** Onglet Vocal : transcription, réponse courte, puis la voix de Jaris. Sans voix, la réponse reste écrite. */
  private async talk(job: Job, wav: Buffer): Promise<void> {
    const transcript = await this.transcribeInto(job, wav)
    await this.answer(job, transcript, 'voice')
    if (!job.reply) return
    job.status = t('phone.status.voice')
    try {
      job.audio = await this.deps.speak(job.reply)
    } catch {
      // La réponse est déjà là : une voix indisponible ne doit pas la transformer en erreur.
    }
  }

  private async studioStatus(): Promise<PhoneStudio> {
    return this.deps.studio()
  }

  private async createImage(body: Record<string, unknown>): Promise<Job> {
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    if (!prompt) throw new HttpError(400, t('phone.err.describeImage'))
    if (prompt.length > MAX_PROMPT_CHARS) throw new HttpError(413, t('phone.err.promptTooLong'))
    const studio = await this.studioStatus()
    if (!studio.image.ready) throw new HttpError(409, studio.image.reason ?? t('phone.err.imageNotReady'))
    const abort = new AbortController()
    return this.startJob(
      'studio',
      async (job) => {
        const image = await this.deps.generateImage(prompt, (status) => (job.status = status), abort.signal)
        job.fileName = image.fileName
      },
      abort
    )
  }

  private async createVideo(body: Record<string, unknown>): Promise<Job> {
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    if (!prompt) throw new HttpError(400, t('phone.err.describeVideo'))
    if (prompt.length > MAX_PROMPT_CHARS) throw new HttpError(413, t('phone.err.promptTooLong'))
    const studio = await this.studioStatus()
    if (!studio.video.ready) throw new HttpError(409, studio.video.reason ?? t('phone.err.videoNotReady'))
    // Jamais cru sur parole : seules une durée et une qualité DÉJÀ proposées par le PC sont acceptées.
    const seconds = typeof body.seconds === 'number' ? body.seconds : Number.NaN
    if (!studio.video.durations.includes(seconds)) throw new HttpError(400, t('phone.err.duration'))
    const quality = typeof body.quality === 'string' ? body.quality : ''
    if (!studio.video.qualities.some((q) => q.id === quality)) throw new HttpError(400, t('phone.err.quality'))
    const abort = new AbortController()
    return this.startJob(
      'studio',
      async (job) => {
        const video = await this.deps.generateVideo(prompt, seconds, quality, (status) => (job.status = status), abort.signal)
        job.fileName = video.fileName
      },
      abort
    )
  }

  private async sendMedia(res: ServerResponse, kind: 'image' | 'thumbnail' | 'video', rawName: string): Promise<void> {
    let fileName: string
    try {
      fileName = decodeURIComponent(rawName)
    } catch {
      throw new HttpError(404, t('phone.err.fileMissing'))
    }
    if (!MEDIA_NAME.test(fileName)) throw new HttpError(404, t('phone.err.fileMissing'))
    let content: Buffer
    try {
      content =
        kind === 'image'
          ? await this.deps.readImage(fileName)
          : kind === 'thumbnail'
            ? await this.deps.readImageThumbnail(fileName)
            : await this.deps.readVideo(fileName)
    } catch {
      throw new HttpError(404, t('phone.err.fileMissing'))
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': kind === 'image' ? 'image/png' : kind === 'thumbnail' ? 'image/jpeg' : 'video/webm',
      'Content-Length': String(content.length),
      'Cache-Control': 'private, no-store'
    })
    res.end(content)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname

      if (req.method === 'GET' && path === '/i18n.js') {
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' })
        res.end(phonePageI18nScript())
        return
      }
      if (req.method === 'GET' && PAGE_FILES[path]) {
        const { file, type } = PAGE_FILES[path]
        const content = await readFile(join(this.deps.pageDir, file))
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-cache' })
        res.end(content)
        return
      }

      if (req.method === 'POST' && path === '/api/pair') {
        send(res, 200, await this.pair(req))
        return
      }

      if (!path.startsWith('/api/')) throw new HttpError(404, t('phone.err.pageMissing'))
      const device = await this.authenticate(req)

      if (req.method === 'GET' && path === '/api/me') {
        send(res, 200, { name: device.name })
        return
      }
      if (req.method === 'GET' && path === '/api/history') {
        const messages = (await this.deps.history())
          .slice(-40)
          .map((message) => ({ ...message, content: uiBlocksToText(message.content) }))
        send(res, 200, { messages })
        return
      }
      if (req.method === 'POST' && path === '/api/message') {
        const body = await readJson(req)
        const text = typeof body.text === 'string' ? body.text.trim() : ''
        if (!text) throw new HttpError(400, t('phone.err.empty'))
        if (text.length > MAX_TEXT_CHARS) throw new HttpError(413, t('phone.err.tooLong'))
        const job = this.startJob('conversation', (j) => this.answer(j, text, 'chat'))
        send(res, 202, { jobId: job.id })
        return
      }
      if (req.method === 'POST' && path === '/api/talk') {
        const wav = await readBody(req, MAX_VOICE_BYTES)
        if (!isExpectedWav(wav)) throw new HttpError(400, t('phone.err.badRecording'))
        const job = this.startJob('conversation', (j) => this.talk(j, wav))
        send(res, 202, { jobId: job.id })
        return
      }
      if (req.method === 'GET' && path === '/api/status') {
        send(res, 200, { online: true, shutdownAt: this.shutdownAt })
        return
      }
      if (req.method === 'POST' && path === '/api/power') {
        const body = await readJson(req)
        // Seul un bouton de la page arrive ici, jamais la conversation : une page web lue par Jaris ou une
        // phrase ambiguë ne peut pas éteindre le PC (shutdown_pc reste interdit depuis le téléphone).
        try {
          if (body.action === 'shutdown') {
            if (this.shutdownAt === null) {
              await this.deps.shutdown(POWER_OFF_DELAY_S)
              this.shutdownAt = this.now() + POWER_OFF_DELAY_S * 1000
            }
          } else if (body.action === 'cancel') {
            await this.deps.cancelShutdown()
            this.shutdownAt = null
          } else {
            throw new HttpError(400, t('phone.err.action'))
          }
        } catch (err) {
          if (err instanceof HttpError) throw err
          throw new HttpError(500, err instanceof Error ? err.message : String(err))
        }
        send(res, 200, { online: true, shutdownAt: this.shutdownAt })
        return
      }
      if (req.method === 'GET' && path === '/api/model') {
        send(res, 200, await this.deps.getModelChoice(phoneModelMode(url.searchParams.get('mode'))))
        return
      }
      if (req.method === 'POST' && (path === '/api/model' || path === '/api/think')) {
        const body = await readJson(req)
        const mode = phoneModelMode(body.mode)
        try {
          if (path === '/api/model') {
            if (body.model !== null && typeof body.model !== 'string') throw new HttpError(400, t('phone.err.model'))
            await this.deps.setModelChoice(mode, body.model as string | null)
          } else {
            await this.deps.setThinkChoice(mode, body.think ?? null)
          }
        } catch (err) {
          // Refus du PC (modèle pas installé, réflexion non acceptée) : son message tel quel, lisible.
          if (err instanceof HttpError) throw err
          throw new HttpError(400, err instanceof Error ? err.message : String(err))
        }
        send(res, 200, await this.deps.getModelChoice(mode))
        return
      }
      if (req.method === 'GET' && path === '/api/studio') {
        send(res, 200, await this.studioStatus())
        return
      }
      if (req.method === 'POST' && path === '/api/image') {
        const job = await this.createImage(await readJson(req))
        send(res, 202, { jobId: job.id })
        return
      }
      if (req.method === 'POST' && path === '/api/video') {
        const job = await this.createVideo(await readJson(req))
        send(res, 202, { jobId: job.id })
        return
      }
      if (req.method === 'GET' && path === '/api/images') {
        send(res, 200, { items: await this.deps.listImages() })
        return
      }
      if (req.method === 'GET' && path === '/api/videos') {
        send(res, 200, { items: await this.deps.listVideos() })
        return
      }
      const mediaMatch = path.match(/^\/api\/(images|videos)\/([^/]+)$/)
      if (req.method === 'GET' && mediaMatch) {
        const kind = mediaMatch[1] === 'videos' ? 'video' : url.searchParams.has('thumb') ? 'thumbnail' : 'image'
        await this.sendMedia(res, kind, mediaMatch[2])
        return
      }
      const jobMatch = path.match(/^\/api\/jobs\/([0-9a-f-]{36})(\/audio|\/cancel)?$/)
      if (jobMatch) {
        const job = this.jobs.get(jobMatch[1])
        if (!job) throw new HttpError(404, t('phone.err.jobMissing'))
        if (req.method === 'GET' && !jobMatch[2]) {
          const { id, state, status, transcript, reply, image, fileName, error } = job
          send(res, 200, { id, state, status, transcript, reply, image, fileName, error, audio: Boolean(job.audio) })
          return
        }
        if (req.method === 'GET' && jobMatch[2] === '/audio') {
          if (!job.audio) throw new HttpError(404, t('phone.err.noAudio'))
          res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'audio/wav', 'Content-Length': String(job.audio.length), 'Cache-Control': 'private, no-store' })
          res.end(job.audio)
          return
        }
        if (req.method === 'POST' && jobMatch[2] === '/cancel') {
          // Seule une création s'arrête : une réponse de Jaris déjà partie va de toute façon jusqu'au bout.
          if (job.lane !== 'studio') throw new HttpError(400, t('phone.err.notCancellable'))
          job.abort?.abort()
          send(res, 200, { ok: true })
          return
        }
      }
      throw new HttpError(404, t('phone.err.pageMissing'))
    } catch (err) {
      if (err instanceof HttpError) send(res, err.status, { error: err.message })
      else send(res, 500, { error: t('phone.err.pc') })
    }
  }
}
