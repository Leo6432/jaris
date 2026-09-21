import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import type { ExternalScoreOverride } from '../../shared/ipc'
import { getDataRoot } from './dataLocation'

/**
 * Corrections manuelles de Léo aux scores externes (Artificial Analysis, page "Tous les modèles") — voir
 * ExternalScoreOverride (shared/ipc.ts) pour le pourquoi. Stocké dans userData (getDataRoot, déplaçable
 * avec le reste des données via "Déplacer", étape 121), PAS commité dans le dépôt comme
 * verified-tool-scores.md : ces valeurs sont propres à ce que Léo a lui-même relevé sur le site, jamais
 * regénérées par un `npm run build`, et un futur correctif de la table figée
 * (ARTIFICIAL_ANALYSIS_INTELLIGENCE_INDEX, hardwareScan.ts) ne doit jamais les écraser silencieusement.
 */
const externalScoresPath = join(getDataRoot(), 'external-scores.json')

export async function getExternalScoreOverrides(): Promise<Record<string, ExternalScoreOverride>> {
  try {
    const raw = await readFile(externalScoresPath, 'utf-8')
    return JSON.parse(raw) as Record<string, ExternalScoreOverride>
  } catch {
    return {}
  }
}

/**
 * `value: null` efface le champ édité (retour au repli habituel : la table figée pour `intelligence`,
 * "—" pour `speed`, qui n'a aucun repli). Les deux champs s'éditent indépendamment : effacer/modifier
 * `intelligence` ne touche jamais à `speed` déjà enregistré pour ce même modèle, et réciproquement.
 */
export async function setExternalScoreOverride(model: string, field: keyof ExternalScoreOverride, value: number | null): Promise<void> {
  const all = await getExternalScoreOverrides()
  const existing: ExternalScoreOverride = { ...all[model] }
  if (value === null) {
    delete existing[field]
  } else {
    existing[field] = value
  }
  if (Object.keys(existing).length === 0) {
    delete all[model]
  } else {
    all[model] = existing
  }
  await mkdir(dirname(externalScoresPath), { recursive: true })
  await writeFile(externalScoresPath, JSON.stringify(all, null, 2), 'utf-8')
}
