import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * Mode Vidéo (étape 203 : Wan 2.2 TI2V 5B avec le même moteur que les images, stable-diffusion.cpp).
 *
 * Pas de Windows ni de carte graphique ici : sd-cli.exe et les téléchargements sont simulés. Ce qui est vérifié :
 * la ligne de commande (tableau d'arguments, jamais un shell, commande officielle de sd.cpp pour Wan 2.2 TI2V 5B),
 * le refus avant tout calcul d'un PC trop faible ou d'un modèle absent, le verrou PARTAGÉ avec les images (une
 * seule chose à la fois sur la carte graphique), l'image de départ effacée après usage, et une liste/suppression
 * qui refuse tout chemin.
 *
 * Vérifié À LA MAIN hors de ce test : la même commande (en petit : peu d'images, peu d'étapes) lancée avec le vrai
 * sd-cli Linux de la même version et les trois vrais fichiers (empreintes identiques à celles figées ici) produit
 * bien un fichier WebM lisible.
 */
const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const nodeRequire = createRequire(import.meta.url)

function transpile(relativePath) {
  return ts.transpileModule(readFileSync(join(projectRoot, relativePath), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
}

function loadPure(relativePath) {
  const module = { exports: {} }
  vm.runInThisContext(`(function (exports, module) { ${transpile(relativePath)} })`)(module.exports, module)
  return module.exports
}

function loadWith(relativePath, modules, fakeProcess) {
  const module = { exports: {} }
  vm.runInThisContext(`(function (exports, module, require, process) { ${transpile(relativePath)} })`)(
    module.exports,
    module,
    (id) => modules[id] ?? nodeRequire(id),
    fakeProcess
  )
  return module.exports
}

const videoModel = loadPure('shared/videoModel.ts')
const imageModel = loadPure('shared/imageModel.ts')
const imageGallery = loadPure('shared/imageGallery.ts')

const sha = (content) => createHash('sha256').update(content).digest('hex')

/** Sortie réelle de sd-cli pendant une vidéo (même barre de progression que pour une image). */
const VIDEO_OUTPUT = [
  '  |========>                                         | 1/3 - 40.10s/it',
  '  |================>                                 | 2/3 - 40.02s/it',
  '  |==================================================| 3/3 - 40.00s/it'
]

function loadVideo({ vramGb = 8, ramGb = 32, platform = 'win32', holdEngine = false, installEngine = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'jaris-videos-'))
  const env = { LOCALAPPDATA: join(root, 'Local'), SystemRoot: 'C:\\Windows' }
  const dataRoot = join(root, 'data')
  const events = []
  const downloads = []
  const killed = []
  const spawns = []

  const fakeChildProcess = {
    execFile(file, args, _opts, cb) {
      if (file.endsWith('tar.exe')) {
        events.push('extract')
        writeFileSync(join(args[args.indexOf('-C') + 1], 'sd-cli.exe'), 'exe')
        return cb(null)
      }
      if (file === 'taskkill') killed.push(args)
      cb?.(null)
    },
    spawn(exe, args, options) {
      events.push('spawn')
      const proc = new EventEmitter()
      proc.pid = 4343
      proc.stdout = new EventEmitter()
      proc.stderr = new EventEmitter()
      proc.kill = () => killed.push('kill')
      // L'image de départ doit exister PENDANT le calcul : notée ici, avant son effacement.
      const init = args.includes('-i') ? args[args.indexOf('-i') + 1] : null
      spawns.push({ exe, args, options, initExistedDuringRun: init ? existsSync(init) : null })
      if (!holdEngine) {
        setImmediate(() => {
          for (const line of VIDEO_OUTPUT) proc.stdout.emit('data', Buffer.from(`${line}\r`))
          writeFileSync(args[args.indexOf('-o') + 1], 'webm')
          proc.emit('close', 0)
        })
      }
      return proc
    }
  }

  const contents = new Map()
  const common = {
    child_process: fakeChildProcess,
    './dataLocation': { getDataRoot: () => dataRoot },
    './ollama': {
      unloadOllamaModels: async () => {
        events.push('unload')
        return []
      }
    },
    './download': {
      downloadToFile: async (url, destination, { onProgress }) => {
        downloads.push(url)
        const content = contents.get(url)
        mkdirSync(dirname(destination), { recursive: true })
        writeFileSync(destination, content)
        onProgress?.({ receivedBytes: content.length, totalBytes: content.length, percent: 100 })
        return content.length
      }
    },
    '../../shared/formatBytes': { formatBytes: (n) => `${n} o` },
    './hardwareScan': { detectGpu: async () => ({ name: 'RTX 3070', vramGb }) },
    './systemResources': { detectRamGb: () => ramGb },
    '../../shared/imageModel': imageModel,
    '../../shared/imageGallery': imageGallery,
    '../../shared/videoModel': videoModel
  }
  const fakeProcess = { platform, env }
  const image = loadWith('electron/services/imageGenerator.ts', common, fakeProcess)
  const video = loadWith('electron/services/videoGenerator.ts', { ...common, './imageGenerator': image }, fakeProcess)

  // Contenus simulés à la bonne taille/empreinte (constantes figées remplacées pour ce test seulement).
  const engineContent = 'moteur'
  contents.set(image.SD_ENGINE.url, engineContent)
  Object.assign(image.SD_ENGINE, { bytes: engineContent.length, sha256: sha(engineContent) })
  for (const file of [...image.IMAGE_MODEL_FILES, ...video.VIDEO_MODEL_FILES]) {
    const content = `poids ${file.role} ${file.fileName}`
    contents.set(file.url, content)
    Object.assign(file, { bytes: content.length, sha256: sha(content) })
  }
  return { image, video, root, dataRoot, events, downloads, killed, spawns, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

async function untilSpawned(t) {
  // Attente en temps réel (5 s max), pas en tours de boucle : sous charge, 1000 tours passaient trop vite.
  for (const end = Date.now() + 5000; !t.spawns.length && Date.now() < end; ) await new Promise((r) => setTimeout(r, 5))
  assert.ok(t.spawns.length, 'sd-cli aurait dû être lancé')
}

async function installed(opts) {
  const t = loadVideo(opts)
  await t.video.installVideoModel()
  return t
}

test('qualités (étape 205) : seuls les crans que la machine peut faire tourner, sinon une raison lisible', () => {
  const q = (vram, ram) => [...videoModel.availableVideoQualities(vram, ram).qualities]
  assert.deepEqual(q(8, 32), ['light', 'q6'], 'RTX 3070 + 32 Go : Q8 laisse trop peu de marge sur 8 Go')
  assert.deepEqual(q(12, 32), ['light', 'q6', 'q8'])
  assert.deepEqual(q(7.9, 31.8), ['light', 'q6'], 'une carte « 8 Go » en annonce parfois un peu moins')
  assert.deepEqual(q(12, 23.5), ['light', 'q6', 'q8'], 'une machine « 24 Go » en annonce un peu moins')
  // Étape 207 : « Original » seulement pour les grosses machines (carte 16 Go ET 32 Go de RAM).
  assert.deepEqual(q(16, 31.8), ['light', 'q6', 'q8', 'original'])
  assert.deepEqual(q(24, 24), ['light', 'q6', 'q8'], 'grosse carte mais 24 Go de RAM : pas d’original (22,8 Go de fichiers)')
  assert.deepEqual(q(12, 64), ['light', 'q6', 'q8'], 'beaucoup de RAM mais carte de 12 Go : pas d’original')
  assert.equal(videoModel.videoQualityLabel('original'), 'Extra')
  assert.match(videoModel.availableVideoQualities(null, 32).reason, /aucune carte graphique détectée/)
  assert.match(videoModel.availableVideoQualities(6, 32).reason, /trop petite \(6 Go de VRAM, il en faut 8 ou plus\)/)
  // Étape 209 : l'AMD 8 Go + 16 Go de RAM de l'ami de Léo a maintenant le cran Léger (et seulement lui).
  assert.deepEqual(q(8, 15.8), ['light'])
  assert.match(videoModel.availableVideoQualities(12, 8).reason, /pas assez de RAM \(8 Go, il en faut 16 ou plus\)/)
  assert.equal(videoModel.availableVideoQualities(4, 32).qualities.length, 0)
  assert.equal(videoModel.isVideoQuality('q8'), true)
  for (const bad of ['Q8', 'q4', 'q5', 'Original', 'bf16', '', null, 8]) assert.equal(videoModel.isVideoQuality(bad), false, String(bad))
  // Dimensions exigées par Wan : multiples de 16, et 4n + 1 images.
  assert.equal(videoModel.VIDEO_WIDTH % 16, 0)
  assert.equal(videoModel.VIDEO_HEIGHT % 16, 0)
  for (const seconds of videoModel.VIDEO_DURATIONS) assert.equal((videoModel.videoFramesFor(seconds) - 1) % 4, 0, `${seconds} s`)
})

test('durée (étape 204) : 1 à 5 s à 24 images/s, 5 s = les 121 images officielles, valeur inconnue → 2 s', () => {
  assert.deepEqual([...videoModel.VIDEO_DURATIONS], [1, 2, 3, 4, 5])
  assert.equal(videoModel.videoFramesFor(5), 121)
  assert.equal(videoModel.videoFramesFor(2), 49)
  for (const bad of [0, 6, 2.5, '3', null, undefined, NaN, -1]) assert.equal(videoModel.normalizeVideoSeconds(bad), 2, String(bad))
  assert.equal(videoModel.normalizeVideoSeconds(4), 4)
})

test('la durée choisie arrive jusqu’à sd-cli (--video-frames), jamais une valeur hors limites', async () => {
  const t = await installed()
  await t.video.generateVideo('a cat', () => {}, undefined, undefined, 5)
  await t.video.generateVideo('a cat', () => {}, undefined, undefined, 99)
  await t.video.generateVideo('a cat')
  const frames = t.spawns.map(({ args }) => args[args.indexOf('--video-frames') + 1])
  assert.deepEqual(frames, ['121', '49', '49'])
  t.cleanup()
})

test('les noms de vidéo sont des .webm simples : jamais un chemin, jamais une image', () => {
  assert.ok(imageGallery.isGeneratedVideoFileName('2026-09-29T15-00-00-un-chat.webm'))
  for (const bad of ['../x.webm', '..\\x.webm', 'a/b.webm', 'x.png', 'x.webm.png', '.depart-x.webm.png', '', null, 42]) {
    assert.equal(imageGallery.isGeneratedVideoFileName(bad), false, String(bad))
  }
  assert.equal(imageGallery.imageLabelFromFileName('2026-09-29T15-00-00-un-chat-roux.webm'), 'Un chat roux')
})

test('installation : le moteur + les trois fichiers de Wan 2.2, vérifiés ; rien n’est dessiné', async () => {
  const t = loadVideo()
  const logs = []
  await t.video.installVideoModel('q6', (m) => logs.push(m))
  assert.equal(t.downloads.length, 4)
  assert.deepEqual(t.events, ['extract'])
  assert.equal(await t.video.isVideoQualityInstalled('q6'), true)
  assert.equal(await t.video.isVideoQualityInstalled('q8'), false, 'une qualité ne se télécharge que si on la choisit')
  assert.ok(logs.some((l) => /FastWan 2\.2 TI2V 5B, Q6/.test(l)), 'Léo voit ce qui se télécharge')
  t.cleanup()
})

test('le moteur déjà installé pour les images n’est jamais retéléchargé pour la vidéo', async () => {
  const t = loadVideo()
  await t.image.installImageModel()
  const before = t.downloads.length
  await t.video.installVideoModel()
  assert.equal(t.downloads.length - before, 3, 'seulement les trois fichiers vidéo')
  const status = await t.video.getVideoStudioStatus()
  assert.deepEqual(status.qualities.map((q) => [q.id, q.installed]), [['light', false], ['q6', true]], '8 Go de carte : Léger et Q6')
  t.cleanup()
})

test('état : la taille à télécharger ne compte le moteur que s’il manque, et le décodeur commun une seule fois', async () => {
  const t = loadVideo({ vramGb: 12 })
  const size = (q) => t.video.videoFilesFor(q).reduce((s, f) => s + f.bytes, 0)
  const label = async (q) => (await t.video.getVideoStudioStatus()).qualities.find((x) => x.id === q).downloadLabel
  assert.equal(await label('q6'), `${size('q6') + t.image.SD_ENGINE.bytes} o`)
  await t.image.installImageModel()
  assert.equal(await label('q6'), `${size('q6')} o`)
  await t.video.installVideoModel('q6')
  const vae = t.video.videoFilesFor('q8').find((f) => f.role === 'vae').bytes
  assert.equal(await label('q8'), `${size('q8') - vae} o`, 'le décodeur, déjà là pour Q6, n’est pas recompté')
  t.cleanup()
})

test('Q8 après Q6 (carte de 12 Go) : seulement son modèle vidéo et son lecteur (le décodeur est commun), puis la vidéo les utilise', async () => {
  const t = await installed({ vramGb: 12 })
  const before = t.downloads.length
  await t.video.installVideoModel('q8')
  const fetched = t.downloads.slice(before)
  assert.equal(fetched.length, 2)
  assert.ok(fetched.every((url) => /(q8_0|Q8_0)\.gguf$/.test(url)), fetched.join(' '))
  await t.video.generateVideo('a cat', () => {}, undefined, undefined, 2, 'q8')
  const { args } = t.spawns[0]
  assert.match(args[args.indexOf('--diffusion-model') + 1], /FastWan2\.2-TI2V-5B-q8_0\.gguf$/)
  assert.match(args[args.indexOf('--t5xxl') + 1], /umt5-xxl-encoder-Q8_0\.gguf$/)
  assert.match(args[args.indexOf('--vae') + 1], /wan2\.2_vae\.safetensors$/)
  t.cleanup()
})

test('Q8 sur une carte de 8 Go : refusé avec une phrase claire, AVANT tout téléchargement ou calcul', async () => {
  const t = await installed()
  const before = t.downloads.length
  t.events.length = 0
  await assert.rejects(t.video.installVideoModel('q8'), /qualité Élevé demande une carte graphique de 10 Go et 24 Go de RAM/)
  await assert.rejects(t.video.generateVideo('a cat', () => {}, undefined, undefined, 2, 'q8'), /qualité Élevé demande/)
  assert.equal(t.downloads.length, before)
  assert.deepEqual(t.events, [])
  t.cleanup()
})

test('qualité pas encore téléchargée (Q8 sur une carte de 12 Go) : message qui dit où la télécharger, rien n’est lancé', async () => {
  const t = await installed({ vramGb: 12 })
  t.events.length = 0
  await assert.rejects(t.video.generateVideo('a cat', () => {}, undefined, undefined, 2, 'q8'), /qualité Élevé n'est pas encore téléchargée/)
  assert.deepEqual(t.events, [])
  t.cleanup()
})

test('PC trop faible : refus lisible AVANT tout calcul, rien n’est lancé', async () => {
  const t = loadVideo({ vramGb: 4 })
  await assert.rejects(t.video.installVideoModel('q6'), /carte graphique trop petite/)
  assert.equal(t.downloads.length, 0, 'pas un octet téléchargé pour rien')
  await assert.rejects(t.video.generateVideo('a cat'), /pas assez de puissance pour créer des vidéos : carte graphique trop petite/)
  assert.deepEqual(t.events, [])
  const status = await t.video.getVideoStudioStatus()
  assert.equal(status.capable, false)
  assert.deepEqual(status.qualities, [])
  t.cleanup()
})

test('modèle absent : message qui renvoie vers le bouton d’installation, rien n’est téléchargé', async () => {
  const t = loadVideo()
  await assert.rejects(t.video.generateVideo('a cat'), /qualité Moyen n'est pas encore téléchargée/)
  assert.equal(t.downloads.length, 0)
  t.cleanup()
})

test('vidéo : Ollama libéré AVANT sd-cli, commande officielle de Wan 2.2, description en UN argument', async () => {
  const t = await installed()
  t.events.length = 0
  const piege = 'cat" & shutdown -s -t 0 & echo "'
  const logs = []
  const result = await t.video.generateVideo(piege, (m) => logs.push(m))
  assert.deepEqual(t.events, ['unload', 'spawn'])
  const { exe, args, options } = t.spawns[0]
  assert.ok(exe.endsWith('sd-cli.exe'))
  assert.equal(options.shell, undefined, 'aucun shell')
  assert.equal(args[args.indexOf('-p') + 1], piege, 'texte intact, en un seul argument')
  assert.equal(args[args.indexOf('-M') + 1], 'vid_gen')
  // FastWan (étape 206) : 3 étapes, CFG 1 (pas de second passage), planificateur lcm — la commande mesurée ici.
  for (const [flag, value] of [['--cfg-scale', '1.0'], ['--steps', '3'], ['--scheduler', 'lcm'], ['--sampling-method', 'euler'], ['--flow-shift', '3.0'], ['-W', '832'], ['-H', '480'], ['--video-frames', '49'], ['--fps', '24']]) {
    assert.equal(args[args.indexOf(flag) + 1], value, flag)
  }
  for (const flag of ['--diffusion-model', '--vae', '--t5xxl', '--offload-to-cpu', '--diffusion-fa', '--vae-tiling']) assert.ok(args.includes(flag), flag)
  assert.ok(!args.includes('-i'), 'sans image jointe, la vidéo part du texte seul')
  assert.match(args[args.indexOf('-o') + 1], /\.webm$/, 'WebM : lisible directement par l’écran')
  assert.equal(dirname(result.path), join(t.dataRoot, 'generated-videos'))
  assert.deepEqual(logs.filter((l) => l.startsWith('Vidéo')), ['Vidéo : étape 1 sur 3', 'Vidéo : étape 2 sur 3', 'Vidéo : étape 3 sur 3'])
  t.cleanup()
})

test('image → vidéo : l’image jointe est passée à sd-cli puis effacée, jamais listée comme une vidéo', async () => {
  const t = await installed()
  await t.video.generateVideo('the cat starts walking', () => {}, undefined, { bytes: new Uint8Array([1, 2, 3]), extension: 'png' })
  const { args, initExistedDuringRun } = t.spawns[0]
  assert.ok(args.includes('-i'))
  assert.equal(initExistedDuringRun, true, 'l’image existe pendant le calcul')
  assert.equal(existsSync(args[args.indexOf('-i') + 1]), false, 'puis elle est effacée')
  const list = await t.video.listGeneratedVideos()
  assert.equal(list.length, 1)
  assert.deepEqual(readdirSync(join(t.dataRoot, 'generated-videos')), [list[0].fileName])
  t.cleanup()
})

test('une seule chose à la fois sur la carte graphique : image et vidéo partagent le même verrou', async () => {
  const t = await installed({ holdEngine: true })
  await t.image.installImageModel()
  const controller = new AbortController()
  const running = t.video.generateVideo('a cat', () => {}, controller.signal)
  await untilSpawned(t)
  await assert.rejects(t.video.generateVideo('a dog'), /déjà en train de créer une vidéo/)
  await assert.rejects(t.image.generateImage('a dog'), /déjà en train de créer une vidéo/)
  controller.abort()
  await assert.rejects(running, /Vidéo annulée/)
  t.cleanup()
})

test('Arrêter tue vraiment sd-cli et libère le verrou pour la suite', async () => {
  const t = await installed({ holdEngine: true })
  const controller = new AbortController()
  const running = t.video.generateVideo('a cat', () => {}, controller.signal)
  await untilSpawned(t)
  controller.abort()
  await assert.rejects(running, /Vidéo annulée/)
  assert.deepEqual(t.killed[0], ['/PID', '4343', '/T', '/F'], 'tout l’arbre de processus est arrêté')
  // Le verrou est rendu : la demande suivante passe le verrou (puis s'arrête sur son propre signal déjà annulé).
  await assert.rejects(t.video.generateVideo('a dog', () => {}, AbortSignal.abort()), /^Error: Vidéo annulée\.$/)
  t.cleanup()
})

test('liste et suppression : seulement des .webm, tout chemin refusé', async () => {
  const t = await installed()
  const dir = join(t.dataRoot, 'generated-videos')
  mkdirSync(join(dir, 'ancien-montage'), { recursive: true })
  writeFileSync(join(dir, '2026-09-01T10-00-00-la-mer.webm'), 'webm')
  writeFileSync(join(dir, 'notes.txt'), 'x')
  const list = await t.video.listGeneratedVideos()
  assert.deepEqual(list.map((v) => v.label), ['La mer'])
  await assert.rejects(t.video.deleteGeneratedVideo('../profile.json'), /Vidéo inconnue/)
  await assert.rejects(t.video.readGeneratedVideo('..\\profile.json'), /Vidéo inconnue/)
  await t.video.deleteGeneratedVideo('2026-09-01T10-00-00-la-mer.webm')
  assert.deepEqual(await t.video.listGeneratedVideos(), [])
  assert.ok(existsSync(join(dir, 'ancien-montage')), 'les anciens dossiers ne sont jamais touchés')
  t.cleanup()
})

test('hors Windows : refus lisible, rien n’est installé', async () => {
  const t = loadVideo({ platform: 'linux' })
  await assert.rejects(t.video.installVideoModel(), /que sur Windows/)
  assert.equal((await t.video.getVideoStudioStatus()).supported, false)
  t.cleanup()
})

test('les fichiers figés sont ceux vérifiés sur Hugging Face (Apache 2.0, révision exacte, empreinte)', () => {
  const source = readFileSync(join(projectRoot, 'electron/services/videoGenerator.ts'), 'utf8')
  for (const [rev, hash] of [
    ['ee6f4a40737a995bf5818954cfce6d59443b0f04', 'e40321bd36b9709991dae2530eb4ac303dd168276980d3e9bc4b6e2b75fed156'],
    // Étape 206 : FastWan (Green-Sky, Apache 2.0) et le lecteur UMT5 en Q6/Q8.
    ['3e8fe5537b1200654868aa24ea8d0f4012fb3a1e', '416a87e30f2328dbefd7666ac90b395ead74f443748ff31c83483ac4ac6121cc'],
    ['3e8fe5537b1200654868aa24ea8d0f4012fb3a1e', 'b62f50ff87c4dfa2910c6883d45015e05b709366581698b302e259e7f25c9208'],
    ['b535255bee98c2b0a59ea7c0ae2dcd0c6657b3b7', '9209b4c77b34ad8cf3f06b04c6eaa27e7beeebb348a31f85e3b38a1d719b09ed'],
    ['b535255bee98c2b0a59ea7c0ae2dcd0c6657b3b7', '2521d4de0bf9e1cc6549866463ceae85e4ec3239bc6063f7488810be39033bbc'],
    // Étape 207 : cran « Original » (FastWan bf16 de Kijai, UMT5 fp16 de Comfy-Org).
    ['8260d429d19fd7a72304cad059160b95d843913f', '5f464f043fab64d43e61d6ee162316a445209c066027c4d8082d265b74ecd328'],
    ['123acf1cc74bccbb9bfff8ac1ee72edc08c2341d', '7b8850f1961e1cf8a77cca4c964a358d303f490833c6c087d0cff4b2f99db2af']
  ]) {
    assert.ok(source.includes(rev), rev)
    assert.ok(source.includes(hash), hash)
  }
  assert.ok(!/\bexec\(|shell:\s*true/.test(source), 'aucun shell')
})

test('les fichiers de l’ancien Wan 2.2 de base sont effacés, et SEULEMENT eux', async () => {
  const t = await installed()
  const dir = t.video.videoModelsDir()
  for (const name of t.video.OBSOLETE_VIDEO_FILES) writeFileSync(join(dir, name), 'ancien')
  writeFileSync(join(dir, 'notes-de-leo.txt'), 'à garder')
  const kept = readdirSync(dir).filter((n) => !t.video.OBSOLETE_VIDEO_FILES.includes(n))
  const removed = await t.video.removeObsoleteVideoFiles()
  assert.deepEqual([...removed].sort(), [...t.video.OBSOLETE_VIDEO_FILES].sort())
  assert.deepEqual(readdirSync(dir).sort(), kept.sort(), 'les fichiers FastWan installés et tout le reste sont intacts')
  assert.equal(await t.video.isVideoQualityInstalled('q6'), true)
  assert.deepEqual(await t.video.removeObsoleteVideoFiles(), [], 'rien à refaire au démarrage suivant')
  t.cleanup()
})

test('Original (grosse machine) : ses deux fichiers non compressés, le décodeur commun, et la commande les utilise', async () => {
  const t = await installed({ vramGb: 24, ramGb: 64 })
  const before = t.downloads.length
  await t.video.installVideoModel('original')
  const fetched = t.downloads.slice(before)
  assert.equal(fetched.length, 2)
  assert.ok(fetched.some((u) => u.endsWith('Wan2_2-TI2V-5B-FastWanFullAttn_bf16.safetensors')))
  assert.ok(fetched.some((u) => u.endsWith('umt5_xxl_fp16.safetensors')))
  await t.video.generateVideo('a cat', () => {}, undefined, undefined, 2, 'original')
  const { args } = t.spawns[0]
  assert.match(args[args.indexOf('--diffusion-model') + 1], /FastWanFullAttn_bf16\.safetensors$/)
  assert.match(args[args.indexOf('--t5xxl') + 1], /umt5_xxl_fp16\.safetensors$/)
  const status = await t.video.getVideoStudioStatus()
  assert.deepEqual(status.qualities.map((q) => q.label), ['Faible', 'Moyen', 'Élevé', 'Extra'])
  t.cleanup()
})

test('Original refusé sur la machine de Léo (8 Go de carte), avant tout téléchargement', async () => {
  const t = await installed()
  const before = t.downloads.length
  await assert.rejects(t.video.installVideoModel('original'), /qualité Extra demande une carte graphique de 16 Go et 32 Go de RAM/)
  assert.equal(t.downloads.length, before)
  t.cleanup()
})

test('Léger (étape 209) : même modèle vidéo que Q6, lecteur Q4 — après Q6, seul le lecteur se télécharge', async () => {
  const t = await installed({ ramGb: 32 })
  const before = t.downloads.length
  await t.video.installVideoModel('light')
  const fetched = t.downloads.slice(before)
  assert.deepEqual(fetched.map((u) => u.split('/').pop()), ['umt5-xxl-encoder-Q4_K_M.gguf'], 'le modèle vidéo Q6 est partagé')
  await t.video.generateVideo('a cat', () => {}, undefined, undefined, 2, 'light')
  const { args } = t.spawns[0]
  assert.match(args[args.indexOf('--diffusion-model') + 1], /FastWan2\.2-TI2V-5B-q6_k\.gguf$/)
  assert.match(args[args.indexOf('--t5xxl') + 1], /umt5-xxl-encoder-Q4_K_M\.gguf$/)
  t.cleanup()
})

test('PC à 16 Go de RAM : Léger proposé, Q6 refusé avec la vraie raison', async () => {
  const t = loadVideo({ ramGb: 15.8 })
  const status = await t.video.getVideoStudioStatus()
  assert.equal(status.capable, true)
  assert.deepEqual(status.qualities.map((q) => q.id), ['light'])
  await assert.rejects(t.video.installVideoModel('q6'), /qualité Moyen demande une carte graphique de 8 Go et 24 Go de RAM/)
  await t.video.installVideoModel('light')
  assert.equal(await t.video.isVideoQualityInstalled('light'), true)
  t.cleanup()
})

test('le lecteur Q4 du cran Léger n’est JAMAIS effacé au démarrage comme un ancien fichier', async () => {
  const t = await installed({ ramGb: 32 })
  await t.video.installVideoModel('light')
  assert.equal(t.video.OBSOLETE_VIDEO_FILES.includes('umt5-xxl-encoder-Q4_K_M.gguf'), false)
  await t.video.removeObsoleteVideoFiles()
  assert.equal(await t.video.isVideoQualityInstalled('light'), true, 'toujours installé après le nettoyage')
  // Aucun fichier d'une qualité actuelle ne doit figurer parmi les « anciens ».
  for (const file of t.video.VIDEO_MODEL_FILES) assert.equal(t.video.OBSOLETE_VIDEO_FILES.includes(file.fileName), false, file.fileName)
  t.cleanup()
})

test('échec du moteur (étape 211) : « vidéo » et pas « image », code lisible, lignes d’erreur reprises', () => {
  const { image } = loadVideo()
  const crash = image.describeEngineFailure(3221226505, ['[INFO ] model_loader.cpp:1380 - loading tensors completed, taking 2.91s'], 'video')
  assert.match(crash, /^Le moteur vidéo s'est arrêté sans finir la vidéo \(code 0xC0000409 — arrêt brutal, sans message du moteur\)/)
  assert.doesNotMatch(crash, /image/, 'plus jamais « image » pour une vidéo')
  const withError = image.describeEngineFailure(1, ['[INFO ] chargement', '[ERROR] GGML_ASSERT(ne00 % 32 == 0) failed', '[INFO ] fin'], 'video')
  assert.match(withError, /Dernière ligne : \[ERROR\] GGML_ASSERT\(ne00 % 32 == 0\) failed/, 'la ligne d’erreur, pas la dernière ligne quelconque')
  assert.match(image.describeEngineFailure(1, ['vk::Device::allocateMemory: ErrorOutOfDeviceMemory'], 'video'), /Pas assez de mémoire pour créer la vidéo.*durée plus courte/)
  assert.match(image.describeEngineFailure(1, ['x'], 'image'), /Le moteur d'images s'est arrêté sans finir l'image \(code 1\)/, 'les images gardent leur texte')
})
