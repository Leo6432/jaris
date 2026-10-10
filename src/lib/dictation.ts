/**
 * Étape 276 (Léo : « quand on clique sur le micro dans le Chat, ça ne doit pas aller en vocal, ça doit enregistrer
 * et transcrire en texte ») : la dictée du champ de saisie. Le son est enregistré ici, ramené au format que la
 * transcription de Jaris attend (WAV 16 kHz mono, 16 bits — le même que les messages vocaux du téléphone), puis
 * transcrit par le modèle déjà chargé pour le micro (main.ts, transcribeDictation).
 */

/** Au-delà, la dictée s'arrête toute seule (environ 4,8 Mo de son, sous la limite de 5 Mo acceptée par Jaris). */
export const DICTATION_MAX_MS = 150_000
/** En dessous, c'était un clic sans parole : rien n'est envoyé à la transcription. */
export const DICTATION_MIN_MS = 300

/** Le son du micro (souvent 48 kHz) ramené à 16 kHz, en moyennant chaque groupe d'échantillons. */
export function downsampleTo16k(chunks: Float32Array[], frames: number, rate: number): Float32Array {
  const input = new Float32Array(frames)
  let offset = 0
  for (const chunk of chunks) {
    input.set(chunk.subarray(0, Math.min(chunk.length, frames - offset)), offset)
    offset += chunk.length
    if (offset >= frames) break
  }
  if (rate === 16000) return input
  const ratio = rate / 16000
  const output = new Float32Array(Math.floor(frames / ratio))
  for (let i = 0; i < output.length; i++) {
    const start = Math.floor(i * ratio)
    const end = Math.min(frames, Math.floor((i + 1) * ratio))
    let sum = 0
    for (let j = start; j < end; j++) sum += input[j]
    output[i] = end > start ? sum / (end - start) : input[start]
  }
  return output
}

/** WAV PCM 16 bits mono 16 kHz : l'en-tête de 44 octets puis les échantillons. */
export function encodeWav16k(samples: Float32Array): Uint8Array {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const text = (offset: number, value: string): void => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i))
  }
  text(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 16000, true)
  view.setUint32(28, 32000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return new Uint8Array(buffer)
}

/** Le texte dicté ajouté à ce qui est déjà écrit, séparé par une espace (jamais collé au mot d'avant). */
export function appendDictation(current: string, dictated: string): string {
  const text = dictated.trim()
  if (!text) return current
  if (!current.trim()) return text
  return `${current.replace(/\s+$/, '')} ${text}`
}

/** Un enregistrement en cours : `stop()` rend le WAV (ou null si trop court), `cancel()` jette tout. */
export class DictationRecorder {
  private chunks: Float32Array[] = []
  private frames = 0
  private startedAt = Date.now()

  private constructor(
    private readonly ctx: AudioContext,
    private readonly stream: MediaStream,
    private readonly nodes: { source: MediaStreamAudioSourceNode; processor: ScriptProcessorNode }
  ) {
    nodes.processor.onaudioprocess = (event) => {
      const data = event.inputBuffer.getChannelData(0)
      this.chunks.push(new Float32Array(data))
      this.frames += data.length
    }
  }

  /** Ouvre le micro par défaut de Windows. Échoue (message clair) si aucun micro n'est accessible. */
  static async start(): Promise<DictationRecorder> {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Le micro n'est pas accessible ici.")
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
    } catch {
      throw new Error("Impossible d'ouvrir le micro : vérifie qu'un micro est branché et autorisé dans Windows.")
    }
    const ctx = new AudioContext()
    const source = ctx.createMediaStreamSource(stream)
    // Indispensable pour que le traitement tourne ; la sortie reste silencieuse.
    const processor = ctx.createScriptProcessor(4096, 1, 1)
    source.connect(processor)
    processor.connect(ctx.destination)
    return new DictationRecorder(ctx, stream, { source, processor })
  }

  /** Durée enregistrée jusqu'ici, en millisecondes. */
  get elapsedMs(): number {
    return Date.now() - this.startedAt
  }

  stop(): Uint8Array | null {
    const { chunks, frames } = this
    const rate = this.ctx.sampleRate
    this.release()
    if (frames < (rate * DICTATION_MIN_MS) / 1000) return null
    return encodeWav16k(downsampleTo16k(chunks, frames, rate))
  }

  cancel(): void {
    this.release()
  }

  private release(): void {
    this.nodes.processor.onaudioprocess = null
    this.nodes.source.disconnect()
    this.nodes.processor.disconnect()
    this.stream.getTracks().forEach((track) => track.stop())
    void this.ctx.close().catch(() => {})
    this.chunks = []
    this.frames = 0
  }
}
