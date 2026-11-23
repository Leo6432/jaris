import { join } from 'path'
import { UNREADABLE_DATA_DIR, readJsonDataFile, writeFileAtomic } from './atomicFile'
import { getDataRoot } from './dataLocation'
import { SPEED_TEST_VERSION, parseSpeedTestFile, speedKey, speedsOf, type SpeedTestResults } from '../../shared/localSpeed'

/**
 * Étape 367 : les vitesses des modèles sur ce PC (tokens par seconde, shared/localSpeed.ts), dans le dossier de données
 * (OWNED_ENTRIES : elles suivent « Déplacer »). Gardées en mémoire : le choix des modèles les relit à chaque calcul.
 *
 * Étape 514 (Léo : « les mêmes questions pour tout le monde… donc enlève ») : seules les vitesses du TEST DE VITESSE
 * (speedTest.ts) sont gardées. L'ancien fichier (mesures prises pendant l'usage, des questions différentes pour chaque
 * modèle) n'est pas relu : il est remplacé par un fichier vide au premier démarrage, les anciennes mesures disparaissent.
 */
const storePath = join(getDataRoot(), 'model-speeds.json')
const unreadableDir = join(getDataRoot(), UNREADABLE_DATA_DIR)

let results: SpeedTestResults = {}
// Même objet tant que rien ne change : hardwareScan.ts ne recalcule qu'après un test.
let speeds: Record<string, number> = {}
let loading: Promise<void> | null = null
let writeChain: Promise<unknown> = Promise.resolve()

function save(): Promise<void> {
  const run = writeChain.then(() => writeFileAtomic(storePath, JSON.stringify({ version: SPEED_TEST_VERSION, results })))
  writeChain = run.catch((err) => console.error('[jaris] Vitesses non enregistrées :', err))
  return run as Promise<void>
}

function loadOnce(): Promise<void> {
  loading ??= readJsonDataFile(storePath, (value) => value, unreadableDir, 'model-speeds')
    .then(async (read) => {
      if (read.status !== 'ok') return
      const parsed = parseSpeedTestFile(read.value)
      if (parsed) {
        // Un test fini pendant la lecture n'est pas perdu.
        results = { ...parsed, ...results }
        speeds = speedsOf(results)
      } else {
        // Ancien format (mesures d'usage, étape 367) ou autre version du test : jamais relu, effacé.
        await save()
      }
    })
    .catch((err) => console.error('[jaris] Vitesses illisibles pour l’instant :', err))
  return loading
}

/** Relit les vitesses au démarrage. Un échec laisse la liste vide : la vitesse est alors inconnue. */
export function loadModelSpeeds(): Promise<void> {
  return loadOnce()
}

/** Vitesse retenue de chaque modèle testé sur ce PC. */
export function getMeasuredSpeeds(): Record<string, number> {
  return speeds
}

/** Résultats complets (vitesse et date du test), pour l'écran du test de vitesse. */
export function getSpeedResults(): SpeedTestResults {
  return results
}

/** Enregistre la vitesse d'un modèle testé (speedTest.ts) : remplace son ancien résultat. */
export async function saveSpeedResult(model: string, speed: number, testedAt = new Date().toISOString()): Promise<void> {
  await loadOnce()
  results = { ...results, [speedKey(model)]: { speed, testedAt } }
  speeds = speedsOf(results)
  await save()
}
