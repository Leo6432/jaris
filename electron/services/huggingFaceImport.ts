import { config } from '../config'
import { DISK_SAFETY_MARGIN_GB, detectFreeDiskGb, getDownloadBudgetGb } from './systemResources'
import { DiskFullError, ModelTooLargeError } from './ollama'

/**
 * Étape 139, Léo : "oui" (au contournement proposé pour que G9v3-3B soit VRAIMENT utilisé malgré Ollama
 * 0.34.2). Cette version d'Ollama refuse tout `ollama pull hf.co/...` avec "blocked redirect to a different
 * host" (github.com/ollama/ollama/issues/18526, corrigé en 0.34.3, encore en pré-version) : vérifié pour de
 * vrai, `https://hf.co/v2/...` répond 307 vers `https://huggingface.co/v2/...` — la redirection entre deux
 * hôtes que 0.34.2 bloque.
 *
 * Jaris refait donc lui-même, pas à pas, EXACTEMENT ce que `ollama pull` aurait fait, sans passer par le
 * code de téléchargement d'Ollama :
 *   1. lire le manifeste du registre Ollama de Hugging Face (même URL, mêmes couches, mêmes empreintes) ;
 *   2. envoyer chaque fichier GGUF (modèle, et projecteur de vision pour GLM-4.6V-Flash) directement de
 *      Hugging Face vers Ollama (`POST /api/blobs/<sha256>`), en flux, sans fichier temporaire — Ollama
 *      recalcule l'empreinte et REFUSE un fichier corrompu ou tronqué (400), jamais installé à moitié ;
 *   3. créer le modèle sous le même nom (`POST /api/create`) avec le gabarit et les paramètres du manifeste.
 * Vérifié dans le code source d'Ollama (server/create.go) : plusieurs GGUF sont acceptés dans `files`, et un
 * projecteur de vision est reconnu automatiquement (isProjectorGGUF). Résultat identique à un vrai pull.
 */

const HF_REGISTRY = 'https://huggingface.co/v2'
const MANIFEST_ACCEPT = 'application/vnd.docker.distribution.manifest.v2+json'
/** Même règle que download.ts : on abandonne sur INACTIVITÉ, jamais sur une durée totale. */
const STALL_TIMEOUT_MS = 60_000

interface ManifestLayer {
  digest: string
  mediaType: string
  size: number
}

interface Manifest {
  layers: ManifestLayer[]
}

/** `hf.co/org/depot:tag` -> { repo: 'org/depot', tag }. `null` si ce n'est pas un import Hugging Face. */
export function parseHuggingFaceModel(model: string): { repo: string; tag: string } | null {
  if (!model.startsWith('hf.co/')) return null
  const rest = model.slice('hf.co/'.length)
  const colon = rest.lastIndexOf(':')
  const repo = colon === -1 ? rest : rest.slice(0, colon)
  const tag = colon === -1 ? 'latest' : rest.slice(colon + 1)
  // Chaque segment commence par une lettre ou un chiffre : jamais `.`/`..`, qui feraient sortir l'URL du dépôt.
  if (!/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(repo) || !/^[A-Za-z0-9][\w.-]*$/.test(tag)) return null
  return { repo, tag }
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Hugging Face a répondu ${response.status} pour ${url}`)
  return response.text()
}

async function blobExists(digest: string): Promise<boolean> {
  const response = await fetch(`${config.ollama.host}/api/blobs/${digest}`, { method: 'HEAD' })
  return response.ok
}

/** Reprises autorisées après une coupure réseau, pour UN fichier (un GGUF de 6 Go traverse souvent une coupure). */
const MAX_RESUMES = 5

/**
 * Flux qui lit le fichier sur Hugging Face et, si la connexion est coupée en route, se reconnecte et REPREND
 * à l'octet près (en-tête HTTP Range) — vu pour de vrai pendant la vérification : une coupure à 70 % d'un
 * fichier de 6 Go faisait tout recommencer à zéro. L'envoi vers Ollama, lui, reste une seule requête ouverte ;
 * Ollama recalcule l'empreinte à la fin, donc une reprise mal raccordée serait refusée, jamais installée.
 */
function resumableSource(url: string, size: number, signal: AbortSignal, onChunk: (bytes: number) => void): ReadableStream<Uint8Array> {
  let received = 0
  let resumes = 0
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null

  const open = async (): Promise<void> => {
    const response = await fetch(url, { signal, headers: received > 0 ? { Range: `bytes=${received}-` } : undefined })
    if (received > 0 && response.status !== 206) throw new Error(`Hugging Face ne permet pas de reprendre ce téléchargement (${response.status})`)
    if (!response.ok || !response.body) throw new Error(`Hugging Face a répondu ${response.status}`)
    reader = response.body.getReader()
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        try {
          if (!reader) await open()
          const { done, value } = await reader!.read()
          if (done) {
            if (size && received < size) throw new Error('connexion fermée avant la fin du fichier')
            controller.close()
            return
          }
          received += value.byteLength
          onChunk(received)
          controller.enqueue(value)
          return
        } catch (err) {
          if (signal.aborted || resumes >= MAX_RESUMES) throw err
          resumes++
          reader = null
          await new Promise((resolve) => setTimeout(resolve, 2000 * resumes))
        }
      }
    },
    cancel() {
      void reader?.cancel()
    }
  })
}

/** Envoie un gros fichier de Hugging Face vers Ollama en flux, avec progression, reprise et arrêt sur inactivité. */
async function streamBlobToOllama(
  repo: string,
  layer: ManifestLayer,
  label: string,
  onStatus?: (message: string) => void
): Promise<void> {
  const controller = new AbortController()
  let stallTimer: ReturnType<typeof setTimeout> | undefined
  const armStall = (): void => {
    if (stallTimer) clearTimeout(stallTimer)
    stallTimer = setTimeout(() => controller.abort(), STALL_TIMEOUT_MS)
  }
  armStall()
  let lastPercent = -1
  const source = resumableSource(`${HF_REGISTRY}/${repo}/blobs/${layer.digest}`, layer.size, controller.signal, (received) => {
    armStall()
    const percent = layer.size ? Math.floor((received / layer.size) * 100) : 0
    if (percent !== lastPercent) {
      lastPercent = percent
      onStatus?.(`Téléchargement de ${label}… ${percent}%`)
    }
  })
  try {
    const upload = await fetch(`${config.ollama.host}/api/blobs/${layer.digest}`, {
      method: 'POST',
      body: source,
      signal: controller.signal,
      // Obligatoire pour envoyer un corps en flux avec fetch (Node/undici).
      duplex: 'half'
    } as RequestInit & { duplex: 'half' })
    if (!upload.ok) {
      throw new Error(
        upload.status === 400
          ? `${label} reçu incomplet ou corrompu (empreinte refusée par Ollama)`
          : `Ollama a répondu ${upload.status} en recevant ${label}`
      )
    }
  } catch (err) {
    if (controller.signal.aborted) throw new Error(`Téléchargement de ${label} bloqué : plus aucune donnée reçue depuis une minute.`)
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : ''
    throw new Error(`Téléchargement de ${label} interrompu (${err instanceof Error ? err.message : String(err)}${cause ? ` : ${cause}` : ''}).`)
  } finally {
    if (stallTimer) clearTimeout(stallTimer)
  }
}

/**
 * Installe un modèle `hf.co/...` sans passer par `ollama pull`. Mêmes garde-fous que pullModelIfMissing
 * (VRAM+RAM, disque) AVANT de télécharger quoi que ce soit.
 */
export async function importHuggingFaceModel(model: string, onStatus?: (message: string) => void): Promise<void> {
  const parsed = parseHuggingFaceModel(model)
  if (!parsed) throw new Error(`${model} n'est pas un modèle Hugging Face importable`)
  const { repo, tag } = parsed

  const manifestResponse = await fetch(`${HF_REGISTRY}/${repo}/manifests/${tag}`, { headers: { Accept: MANIFEST_ACCEPT } })
  if (!manifestResponse.ok) throw new Error(`Hugging Face a répondu ${manifestResponse.status} pour le manifeste de ${model}`)
  const manifest = (await manifestResponse.json()) as Manifest

  const ggufLayers = manifest.layers.filter(
    (l) => l.mediaType === 'application/vnd.ollama.image.model' || l.mediaType === 'application/vnd.ollama.image.projector'
  )
  if (!ggufLayers.some((l) => l.mediaType === 'application/vnd.ollama.image.model')) {
    throw new Error(`Le manifeste de ${model} ne contient aucun fichier de modèle`)
  }

  const requiredGb = ggufLayers.reduce((sum, l) => sum + l.size, 0) / 1024 ** 3
  const budgetGb = await getDownloadBudgetGb()
  if (requiredGb > budgetGb) throw new ModelTooLargeError(model, requiredGb, budgetGb)
  const freeDiskGb = detectFreeDiskGb()
  if (freeDiskGb !== null) {
    const diskBudgetGb = Math.max(0, freeDiskGb - DISK_SAFETY_MARGIN_GB)
    if (requiredGb > diskBudgetGb) throw new DiskFullError(model, requiredGb, diskBudgetGb)
  }

  const files: Record<string, string> = {}
  for (const layer of ggufLayers) {
    const isProjector = layer.mediaType === 'application/vnd.ollama.image.projector'
    const label = isProjector ? `${model} (vision)` : model
    if (!(await blobExists(layer.digest))) await streamBlobToOllama(repo, layer, label, onStatus)
    files[isProjector ? 'projector.gguf' : 'model.gguf'] = layer.digest
  }

  // Gabarit et paramètres du manifeste, repris tels quels : le modèle se comporte exactement comme après un
  // vrai pull (c'est avec ce réglage-là que ses scores ont été mesurés).
  const templateLayer = manifest.layers.find((l) => l.mediaType === 'application/vnd.ollama.image.template')
  const paramsLayer = manifest.layers.find((l) => l.mediaType === 'application/vnd.ollama.image.params')
  const template = templateLayer ? await fetchText(`${HF_REGISTRY}/${repo}/blobs/${templateLayer.digest}`) : undefined
  const parameters = paramsLayer ? (JSON.parse(await fetchText(`${HF_REGISTRY}/${repo}/blobs/${paramsLayer.digest}`)) as Record<string, unknown>) : undefined

  onStatus?.(`Installation de ${model} dans Ollama…`)
  const create = await fetch(`${config.ollama.host}/api/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, files, template, parameters, stream: false })
  })
  if (!create.ok) {
    let detail = ''
    try {
      detail = ((await create.json()) as { error?: string }).error ?? ''
    } catch {
      // corps illisible : le code HTTP seul reste l'information utile
    }
    throw new Error(`Ollama a refusé d'installer ${model} (${create.status}${detail ? ` : ${detail}` : ''})`)
  }
}
