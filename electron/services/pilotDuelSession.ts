import { nativeImage } from 'electron'
import { writeFile } from 'fs/promises'
import { join } from 'path'
import { config } from '../config'
import { PILOT_MODEL, PILOT_MODEL_LABEL } from '../../shared/pilotModel'
import type { PilotDuelCaptureInfo, PilotDuelOutcome } from '../../shared/ipc'
import { getDataRoot } from './dataLocation'
import { pullModelIfMissing, unloadOllamaModels } from './ollama'
import { MAI_UI_LABEL, MAI_UI_MODEL, formatDuelReport, pickTargets, runDuel, type DuelCapture, type DuelDeps } from './pilotDuel'
import { captureScreenWithElements } from './pilotDuelCapture'

/**
 * Étape 249 : la session du duel des pilotes — les captures prises, puis le duel lui-même (pilotDuel.ts) avec
 * les vrais modèles d'Ollama. Les captures restent dans `duel-pilotes/` du dossier de données (jamais envoyées
 * nulle part) ; le rapport, lui, ne contient que des noms de boutons, des positions et les réponses des modèles.
 */
const captures: DuelCapture[] = []

export function pilotDuelDir(): string {
  return join(getDataRoot(), 'duel-pilotes')
}

export function pilotDuelReportPath(): string {
  return join(pilotDuelDir(), 'resultat-duel-pilotes.md')
}

export async function addDuelCapture(): Promise<PilotDuelCaptureInfo> {
  const capture = await captureScreenWithElements(join(pilotDuelDir(), `capture-${captures.length + 1}.png`))
  // Au moins un bouton DANS la fenêtre : une capture qui ne garde que la barre des tâches ne teste pas ce que Léo
  // utilise (capture 1 de son 1er duel : la fenêtre Discord n'avait donné aucune cible).
  if (!pickTargets(capture).some((el) => el.zone !== 'taskbar')) {
    const where = capture.window ? `la fenêtre « ${capture.window} »` : 'la fenêtre au premier plan'
    throw new Error(`Windows n'a donné aucun bouton de ${where} : essaie avec une autre fenêtre, par exemple Firefox ou l'Explorateur de fichiers.`)
  }
  captures.push(capture)
  return duelInfo()
}

export function resetDuelCaptures(): PilotDuelCaptureInfo {
  captures.length = 0
  return duelInfo()
}

function duelInfo(): PilotDuelCaptureInfo {
  return { captures: captures.length, targets: captures.reduce((n, c) => n + pickTargets(c).length, 0), lastWindow: captures.at(-1)?.window }
}

/** 3 minutes par réponse : un premier chargement de modèle sur une carte de 8 Go peut en prendre une bonne partie. */
const CALL_TIMEOUT_MS = 180_000

const deps = (onProgress: (message: string) => void): DuelDeps => ({
  onProgress,
  image: async (png, rect, maxWidth) => {
    let image = nativeImage.createFromPath(png)
    if (rect) image = image.crop({ x: rect.x, y: rect.y, width: rect.w, height: rect.h })
    if (image.getSize().width > maxWidth) image = image.resize({ width: maxWidth, quality: 'best' })
    const size = image.getSize()
    return { base64: image.toPNG().toString('base64'), width: size.width, height: size.height }
  },
  chat: async (model, messages) => {
    const response = await fetch(`${config.ollama.host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      body: JSON.stringify({ model, messages, stream: false, options: { temperature: 0, num_ctx: 8192 } })
    })
    if (!response.ok) throw new Error(`Ollama a répondu ${response.status} : ${(await response.text()).slice(0, 200)}`)
    return ((await response.json()) as { message?: { content?: string } }).message?.content ?? ''
  }
})

export async function runPilotDuel(onProgress: (message: string) => void): Promise<PilotDuelOutcome> {
  if (!captures.length) throw new Error("Prends d'abord au moins une capture de ton écran.")
  const contenders = [
    { label: PILOT_MODEL_LABEL, model: PILOT_MODEL, kind: 'ui-tars' as const },
    { label: MAI_UI_LABEL, model: MAI_UI_MODEL, kind: 'mai-ui' as const }
  ]
  for (const c of contenders) await pullModelIfMissing(c.model, onProgress)
  // Rien d'autre en mémoire : chaque pilote doit avoir toute la carte graphique, comme dans le vrai pilotage.
  await unloadOllamaModels()
  const results = await runDuel(captures, contenders, deps(onProgress))
  await writeFile(pilotDuelReportPath(), formatDuelReport(results, captures, new Date()), 'utf8')
  return {
    reportPath: pilotDuelReportPath(),
    scores: results.map((r) => ({
      label: r.label,
      hits: r.hits,
      zoomHits: r.zoomHits,
      total: r.total,
      secondsPerTarget: r.total ? Math.round(r.seconds / r.total) : 0,
      error: r.error
    }))
  }
}
