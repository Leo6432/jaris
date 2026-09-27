'use strict'
/**
 * Montage (étape 189) : programme de rendu Remotion lancé par Jaris dans un process à part, avec le Node
 * embarqué dans Electron (`ELECTRON_RUN_AS_NODE=1`) — Léo n'a ni Node ni npm sur son PC.
 *
 * Il ne reçoit qu'un chemin de fichier JSON (la tâche), écrit par Jaris : aucun texte venant du modèle ou de
 * l'utilisateur ne passe par la ligne de commande. Il répond par une ligne JSON par évènement sur stdout :
 *   {"event":"progress","stage":"browser"|"bundle"|"render","progress":0..1}
 *   {"event":"done"}
 *   {"event":"error","stage":"browser"|"bundle"|"render","message":"..."}
 *
 * Tâches :
 *   {"action":"ensure-browser","nodeModules":"..."}                   télécharge Chrome Headless Shell
 *   {"action":"render","nodeModules":"...","projectDir":"...","output":"...","browserExecutable"?:"..."}
 *
 * Les modules Remotion sont chargés depuis `nodeModules` (le paquet Montage téléchargé), jamais depuis
 * Jaris : ce fichier est livré avec Jaris, le paquet ne l'est pas.
 */
const fs = require('node:fs')
const path = require('node:path')

const send = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`)

let stage = 'bundle'
let currentJob = null
const fail = (err) => {
  const message = err && err.message ? err.message : String(err)
  if (currentJob && currentJob.action === 'render') {
    try {
      cleanup(currentJob)
    } catch {
      // Le vrai message d'erreur compte plus qu'un dossier temporaire resté en place.
    }
  }
  send({ event: 'error', stage, message: message.slice(0, 4000) })
  process.exit(1)
}
process.on('uncaughtException', fail)
process.on('unhandledRejection', fail)

/** Ne remonte qu'un changement d'au moins 1 % : le rendu appelle onProgress à chaque image. */
function progressReporter(currentStage) {
  let last = -1
  return (value) => {
    const rounded = Math.floor(Math.max(0, Math.min(1, value)) * 100)
    if (rounded === last) return
    last = rounded
    send({ event: 'progress', stage: currentStage, progress: rounded / 100 })
  }
}

async function ensureBrowser(job) {
  stage = 'browser'
  const { ensureBrowser: ensure } = require(path.join(job.nodeModules, '@remotion/renderer'))
  const report = progressReporter('browser')
  await ensure({
    logLevel: 'error',
    onBrowserDownload: () => ({
      version: null,
      onProgress: ({ percent }) => report(percent)
    })
  })
  report(1)
}

async function render(job) {
  const { bundle } = require(path.join(job.nodeModules, '@remotion/bundler'))
  const { renderMedia, selectComposition } = require(path.join(job.nodeModules, '@remotion/renderer'))

  stage = 'bundle'
  const bundleReport = progressReporter('bundle')
  const serveUrl = await bundle({
    entryPoint: path.join(job.projectDir, 'index.tsx'),
    rootDir: job.projectDir,
    outDir: path.join(job.projectDir, '.bundle'),
    onProgress: (percent) => bundleReport(percent / 100),
    // Le projet vit dans les données de Léo, loin du paquet : sans ce chemin, « remotion » et « react » ne
    // seraient trouvés nulle part (webpack ne cherche qu'en remontant depuis le fichier importé).
    webpackOverride: (config) => ({
      ...config,
      resolve: { ...config.resolve, modules: [job.nodeModules, 'node_modules'] },
      resolveLoader: { ...(config.resolveLoader || {}), modules: [job.nodeModules, 'node_modules'] }
    })
  })

  stage = 'render'
  const browserExecutable = job.browserExecutable || null
  const composition = await selectComposition({ serveUrl, id: 'Video', browserExecutable, logLevel: 'error' })
  const renderReport = progressReporter('render')
  await renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    outputLocation: job.output,
    browserExecutable,
    logLevel: 'error',
    onProgress: ({ progress }) => renderReport(progress)
  })
  cleanup(job)
}

/** Le bundle et le cache de webpack ne servent qu'au rendu : seuls le code et la vidéo restent. */
function cleanup(job) {
  for (const dir of ['.bundle', '.cache']) fs.rmSync(path.join(job.projectDir, dir), { recursive: true, force: true })
}

async function main() {
  const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf-8'))
  currentJob = job
  if (job.action === 'ensure-browser') await ensureBrowser(job)
  else if (job.action === 'render') await render(job)
  else throw new Error(`tâche inconnue : ${job.action}`)
  send({ event: 'done' })
  process.exit(0)
}

main().catch(fail)
