import { config, runWithLocalOllama } from '../config'
import { deleteModel, fetchOllamaVersion, fitToModelContext, listInstalledModels, preloadModel, pullModelIfMissing, unloadOllamaModels } from './ollama'
import { detectGpu, getAllCandidateSizes } from './hardwareScan'
import { detectRamGb } from './systemResources'
import { getProfile } from './profileStore'
import { getSpeedResults, saveSpeedResult } from './speedStore'
import { SPEED_TEST_OPTIONS, SPEED_TEST_PROMPTS, SPEED_TEST_VERSION, median, speedKey, speedOfAnswer } from '../../shared/localSpeed'
import type { SpeedTestEvent, SpeedTestModel } from '../../shared/ipc'
import { t } from '../../shared/i18n'

/**
 * Étape 514 (Léo : « un bouton pour tester la vitesse de tous les modèles, pouvoir choisir ceux que je veux ou tout, et
 * les mêmes questions pour tout le monde… comme l'analyse mais pour la vitesse ») : chaque modèle choisi reçoit les
 * MÊMES questions avec les MÊMES réglages (SPEED_TEST_PROMPTS / SPEED_TEST_OPTIONS) ; sa vitesse est la médiane de ses
 * réponses (tokens écrits par seconde, mesurés par Ollama). Comme le test des modèles : un modèle absent est téléchargé,
 * puis supprimé après le test s'il ne sert à aucun rôle de Jaris. Toujours sur CE PC (runWithLocalOllama) : c'est la
 * vitesse « sur ton PC ».
 */

/** Sans un seul fragment de réponse pendant ce temps, la question est abandonnée (inactivité, jamais durée totale). */
export const SPEED_IDLE_MS = 180_000
/** Chargement d'un gros modèle débordant sur la RAM : plusieurs minutes possibles. */
const LOAD_TIMEOUT_MS = 15 * 60_000
const THINK_REFUSED = /does not support thinking|thinking is not supported/i

let running: AbortController | null = null

export function isSpeedTestRunning(): boolean {
  return running !== null
}

/** Les modèles de Jaris, du plus petit au plus gros, avec ce que l'écran doit savoir. */
export async function getSpeedTestModels(): Promise<SpeedTestModel[]> {
  const installed = await runWithLocalOllama(() => listInstalledModels()).catch(() => [] as string[])
  const installedKeys = new Set(installed.map(speedKey))
  const results = getSpeedResults()
  return getAllCandidateSizes()
    .map(({ model, sizeGb }) => {
      const result = results[speedKey(model)]
      return { model, sizeGb, installed: installedKeys.has(speedKey(model)), speed: result?.speed ?? null, testedAt: result?.testedAt ?? null }
    })
    .sort((a, b) => a.sizeGb - b.sizeGb)
}

/** Les modèles que Jaris utilise pour un rôle : jamais supprimés après le test. */
async function modelsInUse(): Promise<Set<string>> {
  const profile = await getProfile().catch(() => null)
  const used = new Set<string>()
  const add = (model: unknown): void => {
    if (typeof model === 'string' && model) used.add(speedKey(model))
  }
  for (const tiers of [profile?.models, profile?.voiceModels]) for (const model of Object.values(tiers ?? {})) add(model)
  add(profile?.visionModel)
  add(profile?.codeModel)
  add(profile?.pilotModel)
  return used
}

/** Une question posée au modèle (flux NDJSON d'Ollama) : tokens écrits et durée d'écriture, mesurés par Ollama. */
async function ask(model: string, prompt: string, numCtx: number, signal: AbortSignal, think = true): Promise<{ tokens?: number; ns?: number }> {
  const idle = new AbortController()
  const both = AbortSignal.any([signal, idle.signal])
  let timer: ReturnType<typeof setTimeout> | undefined
  const alive = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => idle.abort(), SPEED_IDLE_MS)
  }
  alive()
  try {
    const response = await fetch(`${config.ollama.host}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: true,
        ...(think ? { think: false } : {}),
        keep_alive: '10m',
        options: { ...SPEED_TEST_OPTIONS, num_ctx: numCtx }
      }),
      signal: both
    })
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '')
      // Un modèle sans mode réflexion refuse le champ `think` : même question sans lui.
      if (think && THINK_REFUSED.test(text)) return ask(model, prompt, numCtx, signal, false)
      throw new Error(t('speed.ollamaError', { status: response.status, detail: text.slice(0, 200) || '?' }))
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let last: { eval_count?: number; eval_duration?: number; error?: string } = {}
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      alive()
      buffer += decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        const data = JSON.parse(line) as typeof last & { done?: boolean }
        if (data.error) throw new Error(data.error)
        if (data.done) last = data
      }
    }
    if (buffer.trim()) {
      const data = JSON.parse(buffer) as typeof last & { done?: boolean }
      if (data.done) last = data
    }
    return { tokens: last.eval_count, ns: last.eval_duration }
  } catch (err) {
    if (idle.signal.aborted && !signal.aborted) throw new Error(t('speed.stalled', { seconds: Math.round(SPEED_IDLE_MS / 1000) }))
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/** La vitesse d'un modèle : chargé d'abord (jamais compté), puis les mêmes questions que pour tous les autres. */
async function measure(model: string, signal: AbortSignal, onEvent: (event: SpeedTestEvent) => void): Promise<number> {
  const numCtx = await fitToModelContext(model, SPEED_TEST_OPTIONS.num_ctx)
  if (!(await preloadModel(model, numCtx, LOAD_TIMEOUT_MS))) throw new Error(t('speed.loadFailed'))
  const speeds: number[] = []
  for (const [index, prompt] of SPEED_TEST_PROMPTS.entries()) {
    if (signal.aborted) throw new DOMException('stopped', 'AbortError')
    onEvent({ type: 'measuring', model, question: index + 1, total: SPEED_TEST_PROMPTS.length })
    const { tokens, ns } = await ask(model, prompt, numCtx, signal)
    const speed = speedOfAnswer(tokens, ns)
    if (speed !== null) speeds.push(speed)
  }
  const result = median(speeds)
  if (result === null) throw new Error(t('speed.tooShort'))
  return result
}

/** Décharge un modèle tout de suite (keep_alive 0, méthode documentée par Ollama) : le suivant a toute la carte. */
async function unload(model: string): Promise<void> {
  await fetch(`${config.ollama.host}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, keep_alive: 0 })
  }).catch(() => undefined)
}

/**
 * Teste `chosen` (seulement des modèles de Jaris : un nom venu de l'écran qui n'en est pas est ignoré). Résout à la fin,
 * `stopped` si l'utilisateur a arrêté. Chaque vitesse est enregistrée dès que son modèle est fini.
 */
export async function runSpeedTest(chosen: readonly string[], onEvent: (event: SpeedTestEvent) => void): Promise<{ tested: number; stopped?: boolean }> {
  if (running) throw new Error(t('speed.running'))
  const known = new Set(getAllCandidateSizes().map((c) => c.model))
  const models = [...new Set(chosen)].filter((m) => known.has(m))
  const controller = new AbortController()
  running = controller
  let tested = 0
  try {
    return await runWithLocalOllama(async () => {
      // Une carte libre pour tout le monde : aucun autre modèle chargé ne fausse la mesure.
      await unloadOllamaModels()
      const keep = await modelsInUse()
      for (const [index, model] of models.entries()) {
        if (controller.signal.aborted) break
        onEvent({ type: 'progress', done: index, total: models.length })
        let downloaded = false
        try {
          downloaded = await pullModelIfMissing(
            model,
            undefined,
            (progress) => progress && onEvent({ type: 'downloading', model, percent: progress.percent }),
            controller.signal
          )
        } catch (err) {
          if (controller.signal.aborted) break
          onEvent({ type: 'skipped', model, reason: err instanceof Error ? err.message : String(err) })
          continue
        }
        try {
          const speed = await measure(model, controller.signal, onEvent)
          await saveSpeedResult(model, speed)
          tested++
          onEvent({ type: 'done', model, speed })
        } catch (err) {
          if (controller.signal.aborted) break
          onEvent({ type: 'skipped', model, reason: err instanceof Error ? err.message : String(err) })
        } finally {
          await unload(model)
          // Comme le test des modèles : un modèle téléchargé POUR le test, et qui ne sert à aucun rôle, est supprimé.
          if (downloaded && !keep.has(speedKey(model))) await deleteModel(model).catch(() => undefined)
        }
      }
      if (controller.signal.aborted) return { tested, stopped: true }
      onEvent({ type: 'progress', done: models.length, total: models.length })
      return { tested }
    })
  } finally {
    if (running === controller) running = null
  }
}

/** Le bouton « Arrêter » : la question en cours est abandonnée, ce qui est déjà mesuré reste. */
export function stopSpeedTest(): void {
  running?.abort()
}

/**
 * Étape 516 (Léo : « je vais te donner les résultats et personne ne va faire de test : quand il installe, il voit tous
 * les scores, de duel, de vitesse, de tout ; l'utilisateur ne fait rien ») : comme le fichier de l'analyse, le fichier
 * des vitesses que Léo m'envoie, avec ce qui les rend lisibles ailleurs : la carte graphique, la mémoire, Ollama,
 * Jaris, la version du test. `null` : aucune vitesse mesurée.
 */
export async function buildSpeedExport(appVersion: string): Promise<{ json: string; models: number } | null> {
  const results = getSpeedResults()
  const models = Object.keys(results).length
  if (!models) return null
  const gpu = await detectGpu().catch(() => ({ name: null, vramGb: null }))
  const ollama = await runWithLocalOllama(() => fetchOllamaVersion()).catch(() => null)
  const file = {
    kind: 'jaris-speed-test',
    testVersion: SPEED_TEST_VERSION,
    jaris: appVersion,
    ollama,
    gpu: gpu.name,
    vramGb: gpu.vramGb,
    ramGb: detectRamGb(),
    exportedAt: new Date().toISOString(),
    results
  }
  return { json: JSON.stringify(file, null, 2), models }
}
