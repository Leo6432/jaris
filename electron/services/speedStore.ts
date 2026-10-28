import { join } from 'path'
import { UNREADABLE_DATA_DIR, readJsonDataFile, writeFileAtomic } from './atomicFile'
import { getDataRoot } from './dataLocation'
import { SPEED_SAMPLES_KEPT, addSpeedSample, measuredSpeeds, parseSpeedSamples, sampleSpeed, type SpeedSamples } from '../../shared/localSpeed'

/**
 * Étape 367 : les vitesses mesurées sur ce PC (tokens par seconde, shared/localSpeed.ts), une liste dans le dossier de
 * données (OWNED_ENTRIES : elles suivent « Déplacer »). Gardées en mémoire : le choix des modèles les relit à chaque
 * calcul, sans attendre le disque.
 */
const storePath = join(getDataRoot(), 'model-speeds.json')
const unreadableDir = join(getDataRoot(), UNREADABLE_DATA_DIR)

let samples: SpeedSamples = {}
// Même objet tant que rien ne change : hardwareScan.ts ne recalcule le rapport mesuré/publié qu'après une mesure.
let speeds: Record<string, number> = {}
let loading: Promise<void> | null = null

function loadOnce(): Promise<void> {
  loading ??= readJsonDataFile(storePath, parseSpeedSamples, unreadableDir, 'model-speeds')
    .then((read) => {
      if (read.status === 'ok') {
        // Une mesure arrivée pendant la lecture n'est pas perdue.
        for (const [model, values] of Object.entries(read.value)) samples[model] = [...values, ...(samples[model] ?? [])].slice(-SPEED_SAMPLES_KEPT)
        speeds = measuredSpeeds(samples)
      }
    })
    .catch((err) => console.error('[jaris] Vitesses mesurées illisibles pour l’instant :', err))
  return loading
}

/** Relit les vitesses au démarrage. Un échec laisse la liste vide : Jaris utilise alors les vitesses publiées. */
export function loadModelSpeeds(): Promise<void> {
  return loadOnce()
}

/** Vitesse retenue (médiane) de chaque modèle mesuré sur ce PC. */
export function getMeasuredSpeeds(): Record<string, number> {
  return speeds
}

let writeChain: Promise<unknown> = Promise.resolve()

/**
 * Enregistre la vitesse d'une réponse (requestChat, ollama.ts). Une réponse trop courte n'est pas comptée. Jamais
 * d'erreur remontée : une mesure perdue ne doit pas faire échouer une réponse.
 */
export function recordModelSpeed(model: string, tokens: number | undefined, ms: number | undefined): Promise<void> {
  const speed = sampleSpeed(tokens, ms)
  if (speed === null) return Promise.resolve()
  const run = writeChain.then(async () => {
    await loadOnce()
    samples = addSpeedSample(samples, model, speed)
    speeds = measuredSpeeds(samples)
    await writeFileAtomic(storePath, JSON.stringify(samples))
  })
  writeChain = run.catch((err) => console.error('[jaris] Vitesse non enregistrée :', err))
  return writeChain as Promise<void>
}
