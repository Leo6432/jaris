import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as crypto from 'node:crypto'
import * as path from 'node:path'
import * as readline from 'node:readline'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * Étape 257 : le service du duel vidéo (electron/services/videoDuel.ts) de bout en bout, sur un VRAI dossier
 * temporaire. Seuls Python, PyTorch et FastWan sont simulés (pas de carte graphique ni de Windows ici) ; le script
 * Python lui-même a été lancé pour de vrai à part (lignes réelles dans test-video-duel.mjs).
 */
function transpile(file) {
  return ts.transpileModule(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
}
function loadPure(file) {
  const module = { exports: {} }
  vm.runInThisContext(`(function (exports, require, module) {\n${transpile(file)}\n})`)(module.exports, () => ({}), module)
  return module.exports
}
const videoModel = loadPure('shared/videoModel.ts')
const formatBytes = loadPure('shared/formatBytes.ts')
const duelShared = loadPure('shared/videoDuel.ts')
const pythonDir = new URL('../python', import.meta.url).pathname

/** Un faux processus : ses lignes de sortie, puis son code de fin. */
function fakeProcess(lines, code, onKill) {
  const proc = new EventEmitter()
  proc.stdout = new PassThrough()
  proc.stderr = new PassThrough()
  proc.pid = 4242
  proc.kill = () => onKill?.()
  setImmediate(() => {
    for (const line of lines) proc.stdout.write(`${line}\n`)
    proc.stdout.end()
    proc.stderr.end()
    setImmediate(() => proc.emit('close', code))
  })
  return proc
}

function setup({ installed = ['q6', 'q8'], kandinsky = 'ok', platform = 'win32', onFastWan } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'jaris-duel-'))
  const calls = []
  const fastwan = []
  const engine = []
  const spawn = (exe, args) => {
    const joined = args.join(' ')
    if (exe === 'taskkill') return fakeProcess([], 0)
    if (args.includes('venv')) {
      calls.push('venv')
      fs.mkdirSync(path.join(args.at(-1), 'Scripts'), { recursive: true })
      writeFileSync(path.join(args.at(-1), 'Scripts', 'python.exe'), '')
      return fakeProcess([], 0)
    }
    if (joined.includes('--index-url')) return calls.push('torch'), fakeProcess(['Successfully installed torch-2.14.1+cu126'], 0)
    if (args.includes('-r')) return calls.push('requirements'), fakeProcess(['Successfully installed diffusers'], 0)
    if (args[0] === '-c') {
      calls.push('download')
      assert.deepEqual(args.slice(2, 4), ['kandinskylab/Kandinsky-6.0-Lite-distill-5s-Diffusers', 'efbaeb9961770cc82fece5b9cb2197049d8c983c'])
      fs.mkdirSync(args[4], { recursive: true })
      return fakeProcess([], 0)
    }
    if (args[0].endsWith('video_duel.py')) {
      calls.push(['kandinsky', args])
      const out = args[args.indexOf('--out') + 1]
      if (kandinsky === 'fail') {
        return fakeProcess(['{"event": "progress", "message": "Chargement du modèle vidéo Kandinsky 6 Lite…"}', '{"event": "error", "message": "OutOfMemoryError : CUDA out of memory"}'], 1)
      }
      const lines = ['{"event": "progress", "message": "Kandinsky lit la description « humain »…"}']
      for (const [i, name] of ['humain', 'paysage', 'chat'].entries()) {
        writeFileSync(path.join(out, `kandinsky-${name}.mp4`), 'mp4')
        lines.push(JSON.stringify({ event: 'result', name, file: `kandinsky-${name}.mp4`, seconds: 300 + i, denoise_seconds: 250, peak_vram_gb: 7.2, offload: 'model', device: 'NVIDIA GeForce RTX 3070' }))
      }
      lines.push('{"event": "done", "encode_seconds": 95.5, "load_seconds": 12.1}')
      return fakeProcess(lines, 0)
    }
    throw new Error(`commande inattendue : ${exe} ${joined}`)
  }
  const modules = {
    child_process: { spawn },
    crypto, fs, 'fs/promises': fsp, path, readline,
    '../paths': { pythonScriptsDir: () => pythonDir },
    './hardwareScan': { detectGpu: async () => ({ name: 'NVIDIA GeForce RTX 3070', vramGb: 8 }) },
    './imageGenerator': {
      claimEngine: (kind) => engine.push(`claim:${kind}`),
      releaseEngine: () => engine.push('release'),
      imageEngineRoot: () => root
    },
    './ollama': { unloadOllamaModels: async () => (engine.push('unload'), ['granite4.2:8b']) },
    './pythonRuntime': { managedPythonExe: () => 'C:\\Jaris\\python.exe', PIP_INSTALL: ['-m', 'pip', 'install', '--no-cache-dir'] },
    './videoGenerator': {
      getVideoStudioStatus: async () => ({ qualities: ['light', 'q6', 'q8'].map((id) => ({ id, installed: installed.includes(id) })) }),
      generateVideo: async (prompt, onLog, signal, image, seconds, quality, options) => {
        fastwan.push({ prompt, seconds, quality, options, image })
        onFastWan?.(fastwan.length)
        if (signal?.aborted) throw new Error('Vidéo annulée.')
        fs.mkdirSync(path.dirname(options.output), { recursive: true })
        writeFileSync(options.output, 'webm')
        return { path: options.output, fileName: path.basename(options.output) }
      }
    },
    '../../shared/videoModel': videoModel,
    '../../shared/formatBytes': formatBytes,
    '../../shared/videoDuel': duelShared
  }
  const module = { exports: {} }
  const fakeProcessGlobal = { ...process, platform, env: { ...process.env } }
  vm.runInThisContext(`(function (exports, require, module, process) {\n${transpile('electron/services/videoDuel.ts')}\n})`)(
    module.exports, (name) => modules[name], module, fakeProcessGlobal
  )
  const outDir = path.join(root, 'video-duel', 'resultats')
  const results = () => JSON.parse(readFileSync(path.join(outDir, 'resultats.json'), 'utf8'))
  return { duel: module.exports, root, calls, fastwan, engine, outDir, results, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('duel complet : préparation une fois, 3 FastWan par le vrai chemin de Jaris, puis Kandinsky ; tout est enregistré', async () => {
  const t = setup()
  try {
    const logs = []
    const results = await t.duel.runVideoDuel((m) => logs.push(m))
    assert.deepEqual(t.calls.slice(0, 4), ['venv', 'torch', 'requirements', 'download'])
    // FastWan : meilleure qualité DÉJÀ téléchargée, graine fixe, durée du duel, fichiers dans le dossier du duel.
    assert.deepEqual(t.fastwan.map((f) => [f.quality, f.seconds, f.options.seed]), [['q8', 2, 42], ['q8', 2, 42], ['q8', 2, 42]])
    assert.deepEqual(t.fastwan.map((f) => path.basename(f.options.output)), ['fastwan-humain.webm', 'fastwan-paysage.webm', 'fastwan-chat.webm'])
    assert.ok(t.fastwan.every((f) => f.options.output.startsWith(t.outDir) && f.image === undefined))
    // Kandinsky : carte graphique réservée et libérée d'Ollama, mêmes taille/durée/graine que FastWan.
    const args = t.calls.find((c) => c[0] === 'kandinsky')[1]
    const arg = (name) => args[args.indexOf(name) + 1]
    assert.deepEqual([arg('--width'), arg('--height'), arg('--frames'), arg('--fps'), arg('--seed')], ['832', '480', '49', '24', '42'])
    assert.deepEqual(t.engine, ['claim:video', 'unload', 'release'])
    assert.equal(results.machine, 'NVIDIA GeForce RTX 3070 (8 Go)')
    assert.equal(results.videos.length, 6)
    assert.deepEqual(results.kandinsky, { encodeSeconds: 95.5, loadSeconds: 12.1, offload: 'model', peakVramGb: 7.2 })
    const saved = t.results()
    assert.equal(saved.videos.length, 6)
    assert.ok(['fastwan', 'kandinsky'].includes(saved.order.humain))
    assert.ok(logs.some((l) => /FastWan « Un chat » : faite en/.test(l)) && logs.some((l) => /Kandinsky « humain » : faite en 5 min 00/.test(l)))
    // Deuxième duel : plus rien à installer ni à télécharger.
    t.calls.length = 0
    await t.duel.runVideoDuel(() => {})
    assert.deepEqual(t.calls.map((c) => (Array.isArray(c) ? c[0] : c)), ['kandinsky'])
  } finally {
    t.cleanup()
  }
})

test('Kandinsky échoue : la vraie raison remonte, les vidéos FastWan déjà faites et l’erreur restent enregistrées', async () => {
  const t = setup({ kandinsky: 'fail' })
  try {
    await assert.rejects(t.duel.runVideoDuel(() => {}), /Kandinsky s'est arrêté : OutOfMemoryError : CUDA out of memory/)
    const saved = t.results()
    assert.equal(saved.videos.filter((v) => v.model === 'fastwan').length, 3)
    assert.match(saved.error, /CUDA out of memory/)
    assert.deepEqual(t.engine, ['claim:video', 'unload', 'release'], 'la carte graphique est rendue même en cas d’échec')
    assert.equal((await t.duel.getVideoDuelStatus()).running, false)
  } finally {
    t.cleanup()
  }
})

test('« Arrêter » pendant FastWan : plus aucune vidéo, Kandinsky jamais lancé', async () => {
  const t = setup({ onFastWan: (n) => n === 2 && t.duel.cancelVideoDuel() })
  try {
    await assert.rejects(t.duel.runVideoDuel(() => {}), /arrêté|annulée/)
    assert.equal(t.fastwan.length, 2)
    assert.ok(!t.calls.some((c) => Array.isArray(c)))
  } finally {
    t.cleanup()
  }
})

test('pas de FastWan téléchargé, ou pas Windows : refus lisible avant tout téléchargement', async () => {
  for (const [options, message] of [[{ installed: [] }, /Télécharge d'abord FastWan dans le mode Vidéo/], [{ platform: 'linux' }, /que sous Windows/]]) {
    const t = setup(options)
    try {
      assert.match((await t.duel.getVideoDuelStatus()).blocker, message)
      await assert.rejects(t.duel.runVideoDuel(() => {}), message)
      assert.deepEqual(t.calls, [])
    } finally {
      t.cleanup()
    }
  }
})

test('statut avant le premier duel : ce qu’il reste à télécharger est annoncé', async () => {
  const t = setup()
  try {
    const status = await t.duel.getVideoDuelStatus()
    assert.equal(status.ready, false)
    assert.match(status.downloadLabel, /^environ \d+(,\d+)? Go$/)
    assert.equal(status.results, null)
  } finally {
    t.cleanup()
  }
})

test('lecture d’une vidéo : seuls les noms du duel, jamais un chemin ; le choix est enregistré', async () => {
  const t = setup()
  try {
    await t.duel.runVideoDuel(() => {})
    assert.equal((await t.duel.readDuelVideo('kandinsky-chat.mp4')).toString(), 'mp4')
    await assert.rejects(t.duel.readDuelVideo('../resultats.json'), /inconnue/)
    await assert.rejects(t.duel.readDuelVideo('resultats.json'), /inconnue/)
    await t.duel.setDuelChoice('chat', 'kandinsky')
    assert.equal(t.results().choices.chat, 'kandinsky')
    // Effacer les fichiers garde vidéos et résultats.
    await t.duel.deleteVideoDuelFiles()
    assert.ok(fs.existsSync(path.join(t.outDir, 'fastwan-humain.webm')) && fs.existsSync(path.join(t.outDir, 'resultats.json')))
    assert.ok(!fs.existsSync(path.join(t.root, 'video-duel', 'python')) && !fs.existsSync(path.join(t.root, 'video-duel', 'kandinsky6-lite')))
  } finally {
    t.cleanup()
  }
})
