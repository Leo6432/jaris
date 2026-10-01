import { randomInt, randomUUID } from 'crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { readFile } from 'fs/promises'
import { join } from 'path'
import type { AddressInfo } from 'net'
import type { ChatMessage, PhoneDevice } from '../../shared/ipc'
import type { PhoneDeviceStore } from './phoneDevices'

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

export interface PhoneServerDeps {
  /** Envoie le message dans la conversation active de Jaris (outils restreints), progression comprise. */
  sendMessage(text: string, onStatus: (status: string) => void): Promise<PhoneReply>
  /** Transcrit un WAV 16 kHz mono sur le PC (la même transcription que la voix). */
  transcribe(wav: Buffer): Promise<string>
  /** Derniers messages de la conversation active, pour que le téléphone reprenne là où on en est. */
  history(): Promise<ChatMessage[]>
  devices: PhoneDeviceStore
  /** Dossier des fichiers de la page (index.html, app.js…). */
  pageDir: string
  now?: () => number
}

export type JobState = 'running' | 'done' | 'error'

interface Job {
  id: string
  state: JobState
  status: string
  transcript?: string
  reply?: string
  image?: string
  error?: string
  finishedAt?: number
}

/** Fichiers de la page, servis par leur nom exact uniquement : aucun chemin venu de la requête n'est suivi. */
const PAGE_FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/manifest.webmanifest': { file: 'manifest.webmanifest', type: 'application/manifest+json' },
  '/icon-192.png': { file: 'icon-192.png', type: 'image/png' },
  '/icon-512.png': { file: 'icon-512.png', type: 'image/png' },
  '/logo.png': { file: 'logo.png', type: 'image/png' }
}

export const PAIRING_CODE_TTL_MS = 10 * 60_000
const PAIRING_ATTEMPTS_PER_CODE = 5
const PAIRING_ATTEMPTS_PER_MINUTE = 10
const MAX_JSON_BYTES = 64 * 1024
/** ~2 min 40 de voix en WAV 16 kHz mono 16 bits : largement assez pour un message vocal. */
export const MAX_VOICE_BYTES = 5 * 1024 * 1024
const MAX_TEXT_CHARS = 4000
const KEPT_JOBS = 20

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
      reject(new HttpError(413, 'Message trop long.'))
      req.resume()
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new HttpError(413, 'Message trop long.'))
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
  throw new HttpError(400, 'Requête illisible.')
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

export class PhoneServer {
  private server: Server | null = null
  private pairing: { code: string; expiresAt: number; attemptsLeft: number } | null = null
  private pairAttempts: number[] = []
  private jobs = new Map<string, Job>()
  private busy = false
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
    this.pairing = { code, expiresAt, attemptsLeft: PAIRING_ATTEMPTS_PER_CODE }
    return { code, expiresAt }
  }

  cancelPairingCode(): void {
    this.pairing = null
  }

  private async authenticate(req: IncomingMessage): Promise<PhoneDevice> {
    const header = req.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    const device = token ? await this.deps.devices.findByToken(token) : null
    if (!device) throw new HttpError(401, 'Ce téléphone n’est pas (ou plus) connecté à Jaris.')
    void this.deps.devices.touch(device.id, this.now()).catch(() => {})
    return device
  }

  private async pair(req: IncomingMessage): Promise<{ token: string }> {
    const now = this.now()
    this.pairAttempts = this.pairAttempts.filter((t) => now - t < 60_000)
    if (this.pairAttempts.length >= PAIRING_ATTEMPTS_PER_MINUTE) throw new HttpError(429, 'Trop d’essais : attends une minute.')
    this.pairAttempts.push(now)

    const body = await readJson(req)
    const code = typeof body.code === 'string' ? body.code.replace(/\D/g, '') : ''
    const name = typeof body.name === 'string' ? body.name : 'Téléphone'
    const pairing = this.pairing
    if (!pairing || now > pairing.expiresAt) {
      this.pairing = null
      throw new HttpError(403, 'Code expiré : affiche un nouveau code sur le PC (Options → Téléphone).')
    }
    if (code !== pairing.code) {
      pairing.attemptsLeft -= 1
      if (pairing.attemptsLeft <= 0) this.pairing = null
      throw new HttpError(403, 'Code incorrect.')
    }
    // Usage unique : le même code ne connecte jamais un second appareil.
    this.pairing = null
    const { token } = await this.deps.devices.add(name, now)
    return { token }
  }

  private startJob(work: (job: Job) => Promise<void>): Job {
    if (this.busy) throw new HttpError(409, 'Jaris répond encore au message précédent.')
    this.busy = true
    const job: Job = { id: randomUUID(), state: 'running', status: 'Jaris réfléchit…' }
    this.jobs.set(job.id, job)
    while (this.jobs.size > KEPT_JOBS) this.jobs.delete(this.jobs.keys().next().value as string)
    void work(job)
      .then(() => {
        job.state = 'done'
      })
      .catch((err: unknown) => {
        job.state = 'error'
        job.error = err instanceof Error ? err.message : String(err)
      })
      .finally(() => {
        job.finishedAt = this.now()
        this.busy = false
      })
    return job
  }

  private async answer(job: Job, text: string): Promise<void> {
    const result = await this.deps.sendMessage(text, (status) => {
      job.status = status
    })
    job.reply = result.reply
    if (result.image) job.image = result.image
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname

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

      if (!path.startsWith('/api/')) throw new HttpError(404, 'Page introuvable.')
      const device = await this.authenticate(req)

      if (req.method === 'GET' && path === '/api/me') {
        send(res, 200, { name: device.name })
        return
      }
      if (req.method === 'GET' && path === '/api/history') {
        const messages = (await this.deps.history()).slice(-40)
        send(res, 200, { messages })
        return
      }
      if (req.method === 'POST' && path === '/api/message') {
        const body = await readJson(req)
        const text = typeof body.text === 'string' ? body.text.trim() : ''
        if (!text) throw new HttpError(400, 'Message vide.')
        if (text.length > MAX_TEXT_CHARS) throw new HttpError(413, 'Message trop long.')
        const job = this.startJob((j) => this.answer(j, text))
        send(res, 202, { jobId: job.id })
        return
      }
      if (req.method === 'POST' && path === '/api/voice') {
        const wav = await readBody(req, MAX_VOICE_BYTES)
        if (!isExpectedWav(wav)) throw new HttpError(400, 'Enregistrement illisible.')
        const job = this.startJob(async (j) => {
          j.status = 'Transcription sur ton PC…'
          const transcript = (await this.deps.transcribe(wav)).trim()
          if (!transcript) throw new Error("Je n'ai rien entendu dans ce message vocal.")
          j.transcript = transcript
          j.status = 'Jaris réfléchit…'
          await this.answer(j, transcript)
        })
        send(res, 202, { jobId: job.id })
        return
      }
      const jobMatch = path.match(/^\/api\/jobs\/([0-9a-f-]{36})$/)
      if (req.method === 'GET' && jobMatch) {
        const job = this.jobs.get(jobMatch[1])
        if (!job) throw new HttpError(404, 'Message introuvable.')
        const { id, state, status, transcript, reply, image, error } = job
        send(res, 200, { id, state, status, transcript, reply, image, error })
        return
      }
      throw new HttpError(404, 'Page introuvable.')
    } catch (err) {
      if (err instanceof HttpError) send(res, err.status, { error: err.message })
      else send(res, 500, { error: 'Erreur sur le PC.' })
    }
  }
}
