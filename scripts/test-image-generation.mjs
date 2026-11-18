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
import { modelChoiceModule } from './load-model-choice.mjs'
import { systemPromptModule } from './load-system-prompt.mjs'
import { withI18n } from './i18n-test-module.mjs'

/**
 * Génération d'images en local (étape 173 : stable-diffusion.cpp + FLUX.2 klein 4B ; étape 494 : Z-Image-Turbo, en
 * niveaux Q2…Q8 selon la carte graphique).
 *
 * Pas de Windows ni de carte graphique ici : sd-cli.exe, tar.exe et les téléchargements sont simulés. Ce qui
 * est vérifié pour de vrai : la ligne de commande (tableau d'arguments, jamais un shell), la lecture de
 * l'avancement sur la VRAIE sortie de sd-cli (lignes copiées d'une génération réelle sur ce conteneur), le
 * refus d'un fichier dont l'empreinte ne correspond pas, la libération de la carte graphique AVANT le dessin,
 * et le court-circuit de la conversation (l'image n'est jamais « racontée » par le modèle).
 *
 * Ce qui a été vérifié À LA MAIN, hors de ce test (sd.cpp compilé pour processeur sur ce conteneur, fichiers
 * téléchargés depuis les révisions figées) : la commande produit bien une image, et une description en
 * FRANÇAIS (« un chat roux… ») a donné un CHIEN — d'où la description demandée en anglais au modèle.
 */
const projectRoot = fileURLToPath(new URL('..', import.meta.url))

function loadPure(relativePath) {
  const module = { exports: {} }
  vm.runInThisContext(`(function (exports, module, require) { ${transpile(relativePath)} })`)(module.exports, module, withI18n((name) => { throw new Error(`import inattendu : ${name}`) }))
  return module.exports
}
const nodeRequire = createRequire(import.meta.url)

function transpile(relativePath) {
  return ts.transpileModule(readFileSync(join(projectRoot, relativePath), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
}

const imageModel = loadPure('shared/imageModel.ts')
// Étape 200 : le mode Image lit le nom et la date des images (module pur, chargé tel quel).
const imageGallery = loadPure('shared/imageGallery.ts')

/**
 * Lignes réelles de sd-cli (étape 494 : Z-Image-Turbo Q4_0, 512 px, 8 étapes, version épinglée compilée sur ce
 * conteneur — un vrai chat roux sur un canapé bleu), barres de progression comprises.
 */
const REAL_OUTPUT = [
  '[INFO   ] image.cpp:524  - get_learned_condition completed, taking 1.29s',
  '  |#                                                 | 1/138 - 0.00MB/s',
  '  |##################################################| 138/138 - 472.50MB/s',
  '  |======>                                           | 1/8 - 82.83s/it',
  '  |============>                                     | 2/8 - 87.05s/it',
  '  |==================>                               | 3/8 - 93.72s/it',
  '  |=========================>                        | 4/8 - 93.98s/it',
  '  |===============================>                  | 5/8 - 86.27s/it',
  '  |=====================================>            | 6/8 - 85.99s/it',
  '  |===========================================>      | 7/8 - 86.32s/it',
  '  |==================================================| 8/8 - 83.29s/it',
  '[INFO   ] image.cpp:894  - sampling completed, taking 699.45s',
  // Le décodage par tuiles a son propre compteur (9 tuiles en 512 px), à ne pas prendre pour le dessin.
  '  |=====>                                            | 1/9 - 4.31s/it',
  '  |===========>                                      | 2/9 - 3.78s/it',
  '  |==================================================| 9/9 - 3.69s/it',
  "[INFO   ] main.cpp:497  - save result image 0 to 'out.png' (success)"
]

function sha(content) {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Charge imageGenerator.ts avec des faux : téléchargement (écrit un contenu connu), tar.exe (pose sd-cli.exe),
 * sd-cli (écrit la vraie sortie ci-dessus puis l'image), Ollama (note le déchargement).
 */
function loadGenerator({ corruptFile = null, engineExitCode = 0, engineOutput = REAL_OUTPUT, holdEngine = false, vramGb = 8, ramGb = 32, gpuDecodeFails = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'jaris-images-'))
  const env = { LOCALAPPDATA: join(root, 'Local'), SystemRoot: 'C:\\Windows' }
  const dataRoot = join(root, 'data')
  const events = []
  const downloads = []
  const killed = []

  const fakeChildProcess = {
    execFile(file, args, _opts, cb) {
      if (file.endsWith('tar.exe')) {
        events.push('extract')
        const target = args[args.indexOf('-C') + 1]
        writeFileSync(join(target, 'sd-cli.exe'), 'exe')
        return cb(null)
      }
      if (file === 'taskkill') killed.push(args)
      cb?.(null)
    },
    spawn(exe, args, options) {
      events.push('spawn')
      const proc = new EventEmitter()
      proc.pid = 4242
      proc.stdout = new EventEmitter()
      proc.stderr = new EventEmitter()
      proc.kill = () => killed.push('kill')
      proc.spawnArgs = { exe, args, options }
      loaded.lastSpawn = proc
      loaded.backends = [...(loaded.backends ?? []), args[args.indexOf('--backend') + 1]]
      // Étape 345 : carte qui s'arrête net au décodage (0xC0000409) tant que le décodeur est sur elle.
      const exitCode = gpuDecodeFails && !args.includes('te=cpu,vae=cpu') ? 3221226505 : engineExitCode
      if (!holdEngine) {
        setImmediate(() => {
          for (const line of engineOutput) proc.stdout.emit('data', Buffer.from(`${line}\r`))
          if (exitCode === 0) writeFileSync(args[args.indexOf('-o') + 1], 'png')
          proc.emit('close', exitCode)
        })
      }
      return proc
    }
  }

  const contents = new Map()
  const modules = {
    child_process: fakeChildProcess,
    './dataLocation': { getDataRoot: () => dataRoot },
    '../config': { runWithLocalOllama: (fn) => fn() }, './ollama': {
      unloadOllamaModels: async () => {
        events.push('unload')
        return ['qwen3.5:9b']
      }
    },
    './download': {
      downloadToFile: async (url, destination, { onProgress }) => {
        downloads.push(url)
        const content = contents.get(url)
        mkdirSync(dirname(destination), { recursive: true })
        writeFileSync(destination, corruptFile && url.includes(corruptFile) ? `${content}-abîmé` : content)
        onProgress?.({ receivedBytes: content.length, totalBytes: content.length, percent: 100 })
        return content.length
      }
    },
    '../../shared/formatBytes': { formatBytes: (n) => `${n} o` },
    './hardwareScan': { detectGpu: async () => ({ name: 'RTX 3070', vramGb }) },
    './systemResources': { detectRamGb: () => ramGb },
    '../../shared/imageModel': imageModel,
    '../../shared/imageGallery': imageGallery
  }
  const fakeProcess = { platform: 'win32', env }
  const module = { exports: {} }
  vm.runInThisContext(`(function (exports, module, require, process) { ${transpile('electron/services/imageGenerator.ts')} })`)(
    module.exports,
    module,
    withI18n((id) => modules[id] ?? nodeRequire(id)),
    fakeProcess
  )
  const loaded = module.exports

  // Contenus simulés à la bonne taille/empreinte : les constantes figées sont remplacées pour ce test seulement.
  const engineContent = 'moteur'
  contents.set(loaded.SD_ENGINE.url, engineContent)
  Object.assign(loaded.SD_ENGINE, { bytes: engineContent.length, sha256: sha(engineContent) })
  for (const file of [...Object.values(loaded.IMAGE_QUALITY_FILES), ...loaded.IMAGE_SHARED_FILES]) {
    const content = `poids ${file.fileName}`
    contents.set(file.url, content)
    Object.assign(file, { bytes: content.length, sha256: sha(content) })
  }
  return { gen: loaded, root, env, dataRoot, events, downloads, killed, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/** Étape 175 : le modèle s'installe comme les autres (runQuickSetup), puis on dessine. */
async function installed(opts, quality = 'q6') {
  const t = loadGenerator(opts)
  await t.gen.installImageModel(quality)
  return t
}

test('installation (page Modèles) : le moteur + les trois fichiers, rien d’autre', async () => {
  const t = loadGenerator()
  const logs = []
  await t.gen.installImageModel('q6', (m) => logs.push(m))
  assert.equal(t.downloads.length, 4, 'le moteur + les trois fichiers du niveau')
  assert.ok(t.downloads.some((u) => u.endsWith('z_image_turbo-Q6_K.gguf')), 'le dessinateur du niveau demandé')
  assert.deepEqual(t.events, ['extract'], 'installer ne dessine rien et ne touche pas à Ollama')
  assert.ok(logs.some((l) => /Téléchargement de .* : 100 %/.test(l)), 'avancement visible pendant l’installation')
  t.cleanup()
})

test('dessiner n’installe JAMAIS rien : sans modèle installé, message qui renvoie vers Options → Modèles', async () => {
  const t = loadGenerator()
  await assert.rejects(t.gen.generateImage('a cat'), /pas encore installé sur ce PC : ouvre Options → Modèles et clique « Retester la configuration »/)
  assert.equal(t.downloads.length, 0)
  assert.deepEqual(t.events, [])
  t.cleanup()
})

test('dessin : la carte graphique est libérée AVANT de lancer sd-cli, l’image est créée, rien n’est téléchargé', async () => {
  const t = await installed()
  const downloadsBefore = t.downloads.length
  t.events.length = 0
  const logs = []
  const image = await t.gen.generateImage('a ginger cat on a blue sofa', (m) => logs.push(m))

  assert.equal(t.downloads.length, downloadsBefore, 'aucun téléchargement pendant un dessin')
  assert.deepEqual(t.events, ['unload', 'spawn'])
  assert.ok(existsSync(image.path), 'le PNG existe')
  assert.equal(dirname(image.path), join(t.dataRoot, 'generated-images'), 'rangé avec les données de Léo')
  assert.match(image.fileName, /^\d{4}-\d{2}-\d{2}T[\d-]+-a-ginger-cat-on-a-blue-sofa\.png$/)
  // Avancement lu sur la vraie sortie : les étapes de dessin, jamais les compteurs du chargement des poids.
  assert.deepEqual(
    logs.filter((l) => l.startsWith('Dessin')),
    Array.from({ length: 8 }, (_, i) => `Dessin : ${i + 1}/8`)
  )
  assert.ok(logs.some((l) => l.includes('Carte graphique libérée')))
  t.cleanup()
})

test('réinstaller un modèle déjà présent ne retélécharge rien', async () => {
  const t = await installed()
  const before = t.downloads.length
  await t.gen.installImageModel('q6')
  assert.equal(t.downloads.length, before)
  t.cleanup()
})

test('la description passe en UN argument (jamais un shell), avec la commande documentée pour Z-Image-Turbo', async () => {
  const t = await installed()
  const piege = 'cat" & shutdown -s -t 0 & echo "'
  await t.gen.generateImage(piege)
  const { exe, args, options } = t.gen.lastSpawn.spawnArgs
  assert.ok(exe.endsWith('sd-cli.exe'))
  assert.equal(options.shell, undefined, 'aucun shell')
  assert.equal(options.windowsHide, true)
  assert.equal(args[args.indexOf('-p') + 1], piege, 'texte intact, en un seul argument')
  for (const flag of ['--diffusion-model', '--vae', '--llm', '--offload-to-cpu', '--diffusion-fa', '--vae-tiling']) {
    assert.ok(args.includes(flag), `${flag} manquant`)
  }
  assert.equal(args[args.indexOf('--cfg-scale') + 1], '1.0')
  assert.equal(args[args.indexOf('--steps') + 1], '8')
  assert.match(args[args.indexOf('--diffusion-model') + 1], /z_image_turbo-Q6_K\.gguf$/)
  assert.match(args[args.indexOf('--vae') + 1], /z-image-vae\.safetensors$/)
  assert.match(args[args.indexOf('--llm') + 1], /Qwen3-4B-Q4_K_M\.gguf$/)
  assert.ok(!args.includes('-r'), 'étape 494 : plus d’image de départ (propre à klein)')
  // Étape 343 : sur la carte, la table de vocabulaire du lecteur faisait planter le moteur (0xC0000409).
  // Étape 345 : le décodeur, lui, essaie d'abord la carte (bien plus rapide quand elle y arrive).
  assert.equal(args[args.indexOf('--backend') + 1], 'te=cpu', 'lecteur sur le processeur, décodeur sur la carte')
  t.cleanup()
})

test('étape 345 : la carte s’arrête net au décodage → même image refaite décodeur sur le processeur, et retenu', async () => {
  const t = await installed({ gpuDecodeFails: true })
  const logs = []
  const image = await t.gen.generateImage('cat', (m) => logs.push(m))
  assert.ok(existsSync(image.path), 'image finie malgré la carte')
  assert.deepEqual(t.gen.backends, ['te=cpu', 'te=cpu,vae=cpu'], 'carte d’abord, puis processeur')
  assert.ok(logs.some((l) => l.includes('nouvel essai avec le processeur')), 'Léo voit pourquoi ça recommence')
  assert.equal(await t.gen.decodeOnCpuRemembered(), true)
  // L'image suivante passe directement par le processeur : aucun essai raté de plus.
  t.gen.backends = []
  await t.gen.generateImage('dog', () => {})
  assert.deepEqual(t.gen.backends, ['te=cpu,vae=cpu'])
  t.cleanup()
})

test('étape 345 : une carte qui marche reste sur la carte, rien n’est retenu', async () => {
  const t = await installed()
  await t.gen.generateImage('cat', () => {})
  await t.gen.generateImage('dog', () => {})
  assert.deepEqual(t.gen.backends, ['te=cpu', 'te=cpu'])
  assert.equal(await t.gen.decodeOnCpuRemembered(), false)
  t.cleanup()
})

test('étape 345 : une panne qui n’est pas la carte (échec aussi au processeur) n’est jamais retenue', async () => {
  const t = await installed({ engineExitCode: 1, engineOutput: ['ggml_vulkan: Device memory allocation failed', 'ErrorOutOfDeviceMemory'] })
  await assert.rejects(t.gen.generateImage('cat'), /Pas assez de mémoire pour dessiner/)
  assert.equal(await t.gen.decodeOnCpuRemembered(), false)
  t.cleanup()
})

test('étape 345 : un nouveau moteur réessaie la carte (le défaut a peut-être été corrigé)', async () => {
  const t = await installed({ gpuDecodeFails: true })
  await t.gen.generateImage('cat', () => {})
  assert.equal(await t.gen.decodeOnCpuRemembered(), true)
  // Nouvelle version du moteur : le dossier bin est remplacé, le souvenir part avec lui.
  t.gen.SD_ENGINE.tag = 'master-999-nouveau'
  await t.gen.installImageModel('q6')
  assert.equal(await t.gen.decodeOnCpuRemembered(), false)
  t.cleanup()
})

test('les chevrons sont retirés : sd.cpp lirait <lora:…> comme un fichier à charger', () => {
  const t = loadGenerator()
  assert.equal(t.gen.cleanPrompt('a cat <lora:evil:1> on a sofa'), 'a cat lora:evil:1 on a sofa')
  assert.equal(t.gen.cleanPrompt('x'.repeat(3000)).length, 1000)
  t.cleanup()
})

test('un fichier dont l’empreinte ne correspond pas est effacé et refusé, sd-cli n’est jamais lancé', async () => {
  const t = loadGenerator({ corruptFile: 'Qwen3-4B' })
  await assert.rejects(t.gen.installImageModel('q6'), /ne correspond pas à l'original/)
  assert.equal(await t.gen.isImageModelInstalled(), false)
  await assert.rejects(t.gen.generateImage('cat'), /pas encore installé/)
  assert.ok(!t.events.includes('spawn'))
  const models = join(t.env.LOCALAPPDATA, 'Jaris', 'image-generation', 'models')
  assert.deepEqual(readdirSync(models).filter((f) => f.startsWith('Qwen3')), [], 'ni fichier final, ni fichier partiel')
  t.cleanup()
})

test('un manque de mémoire devient une phrase lisible par Léo', async () => {
  const t = await installed({ engineExitCode: 1, engineOutput: ['ggml_vulkan: Device memory allocation failed', 'ErrorOutOfDeviceMemory'] })
  await assert.rejects(t.gen.generateImage('cat'), /Pas assez de mémoire pour dessiner/)
  t.cleanup()
})

test('une seule image à la fois, et un arrêt demandé tue vraiment sd-cli', async () => {
  const t = await installed({ holdEngine: true })
  const controller = new AbortController()
  const logs = []
  const first = t.gen.generateImage('cat', (m) => logs.push(m), controller.signal)
  // Attente en temps réel (5 s max), pas en tours de boucle : sous charge (suite complète), 1000 tours
  // s'écoulaient avant la fin des lectures disque et le test échouait sans aucun défaut du code.
  for (const end = Date.now() + 5000; !t.gen.lastSpawn && Date.now() < end; ) await new Promise((r) => setTimeout(r, 5))
  assert.ok(t.gen.lastSpawn, 'sd-cli aurait dû être lancé')
  await assert.rejects(t.gen.generateImage('dog'), /déjà en train de dessiner/)
  controller.abort()
  await assert.rejects(first, /annulé/)
  // Étape 345 : un arrêt demandé n'est jamais pris pour une panne de la carte (pas de second essai annoncé).
  assert.ok(!logs.some((l) => l.includes('nouvel essai')), 'aucun nouvel essai après un arrêt')
  assert.deepEqual(t.killed[0], ['/PID', '4242', '/T', '/F'], 'tout l’arbre de processus est arrêté')
  t.cleanup()
})

// Relecture croisée : « Déplacer » copiait les données pendant qu'un dessin tournait encore — sd.exe garde ouverts les
// fichiers du dossier image-generation. Le dessin est maintenant arrêté avant la copie, et sa VRAIE sortie attendue.
test('« Déplacer » : waitForEngineExit attend que le moteur arrêté soit vraiment sorti', async () => {
  const t = await installed({ holdEngine: true })
  assert.equal(await t.gen.waitForEngineExit(), true) // rien ne tourne : immédiat
  const controller = new AbortController()
  const drawing = t.gen.generateImage('cat', () => {}, controller.signal)
  for (const end = Date.now() + 5000; !t.gen.lastSpawn && Date.now() < end; ) await new Promise((r) => setTimeout(r, 5))
  assert.ok(t.gen.lastSpawn, 'sd-cli aurait dû être lancé')
  controller.abort()
  await assert.rejects(drawing, /annulé/)
  let exited = false
  const waiting = t.gen.waitForEngineExit().then((result) => {
    exited = result
  })
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(exited, false, 'rendu la main alors que le moteur tourne encore (fichiers encore ouverts)')
  t.gen.lastSpawn.emit('exit', 1)
  await waiting
  assert.equal(exited, true)
  t.cleanup()
})

// Relecture adverse : un moteur qui ne sort pas faisait abandonner l'attente EN SILENCE, puis la copie partait avec
// sd.exe actif ; et une création pouvait encore DÉMARRER pendant le déplacement (outil de dessin d'une conversation,
// demande du téléphone arrivée juste avant sa coupure).
test('« Déplacer » : plus aucune création ne démarre ; un moteur qui ne sort pas est signalé, jamais ignoré', async () => {
  const t = await installed({ holdEngine: true })
  const controller = new AbortController()
  const drawing = t.gen.generateImage('cat', () => {}, controller.signal)
  for (const end = Date.now() + 5000; !t.gen.lastSpawn && Date.now() < end; ) await new Promise((r) => setTimeout(r, 5))
  const stuck = t.gen.lastSpawn
  controller.abort()
  await assert.rejects(drawing, /annulé/)
  assert.equal(await t.gen.waitForEngineExit(30), false, 'un moteur encore là doit être signalé à l’appelant')

  t.gen.setEnginesBlocked(true)
  try {
    t.events.length = 0
    await assert.rejects(t.gen.generateImage('dog'), /déplace tes données/)
    assert.throws(() => t.gen.claimEngine('video'), /déplace tes données/)
    await assert.rejects(t.gen.runEngine('sd-cli.exe', [], () => {}), /déplace tes données/)
    assert.deepEqual(t.events, [], 'un moteur a été lancé pendant le déplacement')
  } finally {
    t.gen.setEnginesBlocked(false)
  }
  stuck.emit('exit', 1)
  assert.equal(await t.gen.waitForEngineExit(), true)
  // Déplacement annulé : le moteur se réserve de nouveau.
  t.gen.claimEngine('image')
  t.gen.releaseEngine()
  t.cleanup()
})

test('une image n’est relue que par son NOM, jamais par un chemin venu de l’historique', async () => {
  const t = await installed()
  const image = await t.gen.generateImage('cat')
  assert.match(await t.gen.readGeneratedImageDataUrl(image.fileName), /^data:image\/png;base64,/)
  assert.equal(await t.gen.readGeneratedImageDataUrl('../../profile.png'), null)
  assert.equal(await t.gen.readGeneratedImageDataUrl('C:\\Windows\\x.png'), null)
  t.cleanup()
})

test('mode Image (étape 200) : la liste montre les images dessinées, la suppression refuse tout chemin', async () => {
  const t = await installed()
  const image = await t.gen.generateImage('un chat sur la lune')
  const list = await t.gen.listGeneratedImages()
  assert.equal(list.length, 1)
  assert.equal(list[0].fileName, image.fileName)
  assert.equal(list[0].label, 'Un chat sur la lune')
  for (const bad of ['../../profile.json', '..\\profile.png', 'C:\\Windows\\x.png', 'sous/dossier.png']) {
    await assert.rejects(t.gen.deleteGeneratedImage(bad), /Image inconnue/, bad)
  }
  await t.gen.deleteGeneratedImage(image.fileName)
  assert.deepEqual([...(await t.gen.listGeneratedImages())], [])
  t.cleanup()
})

test('les révisions figées pointent vers des fichiers sous licence libre, tailles et empreintes renseignées', () => {
  const t = loadGenerator()
  const source = readFileSync(join(projectRoot, 'electron/services/imageGenerator.ts'), 'utf8')
  assert.equal(t.gen.SD_ENGINE.url, 'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-920-2f88688/sd-master-2f88688-bin-win-vulkan-x64.zip')
  for (const repo of ['leejet/Z-Image-Turbo-GGUF/resolve/c61c0e4', 'Tongyi-MAI/Z-Image-Turbo/resolve/f332072', 'unsloth/Qwen3-4B-GGUF/resolve/22c9fc8']) {
    assert.ok(source.includes(repo), `${repo} : révision figée attendue (jamais « main »)`)
  }
  assert.ok(!/\/resolve\/main\//.test(source))
  // Le moteur, six niveaux du dessinateur, le décodeur et le lecteur.
  assert.equal((source.match(/sha256: '[0-9a-f]{64}'/g) ?? []).length, 9)
  for (const [id, file] of Object.entries(t.gen.IMAGE_QUALITY_FILES)) {
    assert.ok(file.url.endsWith(file.fileName), `${id} : le fichier téléchargé porte le nom de celui publié`)
  }
  t.cleanup()
})

// --- Conversation : le résultat d'une image n'est jamais reformulé par le modèle ---

function loadConverse(chat, execute, onExecutorArgs) {
  const config = { ollama: { model: 'test', visionModel: 'vision', numCtx: 8192 } }
  const noteExports = {}
  vm.runInNewContext(transpile('electron/services/notepad.ts'), { exports: noteExports, require: (name) => (name === 'util' ? { promisify: () => {} } : {}) })
  const modules = {
    '../config': { config },
    './ollama': { chatWithOllama: chat, listInstalledModels: async () => ['test'] },
    './systemPrompt': systemPromptModule,
    './memoryStore': { listMemoryTitles: async () => [] },
    './profileStore': { getProfile: async () => null },
    './notepad': { notepadRequest: noteExports.notepadRequest, requestedNotepadText: noteExports.requestedNotepadText, openNotepadText: async () => '' },
    './appLauncher': { didAppLaunch: (r) => r.endsWith('a été lancé.'), launchedAppName: (r) => (r.endsWith(' a été lancé.') ? r.slice(0, -' a été lancé.'.length) : undefined) },
    './hardwareScan': { GPU_TEMP_LIMIT_C: 85 },
    './modelChoice': modelChoiceModule,
    // Journal des demandes (étape 245) : rien n'est écrit sur le disque pendant les tests.
    // Recherche ouverte dans le navigateur (étape 248) : jamais déclenchée par les phrases de ces tests.
    './browserSearch': { directBrowserSearch: () => undefined, openBrowserSearch: async () => assert.fail('navigateur ouvert à tort') },
    './requestJournal': { startJournalEntry: () => ({ line() {}, timed() {}, end: async () => {} }), describeModelCall: () => '' },
    './resourceMonitor': { checkOverloadWarning: async () => null },
    './tools': {
      TOOLS: [],
      createToolExecutor: (...args) => {
        onExecutorArgs(args)
        return execute
      }
    }
  }
  const exports = {}
  vm.runInNewContext(transpile('electron/services/assistant.ts'), { exports, Error, require: withI18n((name) => modules[name]) })
  return exports.converse
}

for (const channel of ['chat', 'voice']) {
  test(`${channel} : « dessine-moi… » → generate_image, réponse finale sans nouvel appel au modèle`, async () => {
    let modelCalls = 0
    let executorArgs = null
    const onImage = () => {}
    const converse = loadConverse(
      async () => {
        modelCalls++
        return { role: 'assistant', content: '', tool_calls: [{ function: { name: 'generate_image', arguments: { prompt: 'a ginger cat' } } }] }
      },
      async (name) => (name === 'generate_image' ? 'Voilà ton image.' : assert.fail(name)),
      (args) => (executorArgs = args)
    )
    const reply = await converse('dessine-moi un chat roux', null, () => {}, undefined, [], undefined, undefined, channel, undefined, undefined, onImage)
    assert.equal(reply, 'Voilà ton image.')
    assert.equal(modelCalls, 1, 'le modèle de conversation n’est pas rechargé sur la carte qu’on vient de libérer')
    assert.equal(executorArgs[4], onImage, 'l’image est transmise à l’appelant (Chat ou voix)')
  })
}

test('les copies du test des modèles (outils + consignes) connaissent generate_image', async () => {
  const { TOOLS } = await import('./benchmark-cases.mjs')
  assert.ok(TOOLS.some((t) => t.function.name === 'generate_image'))
  assert.match(systemPromptModule.buildSystemPrompt(null, [], 'voice'), /generate_image, description en anglais/)
})

// --- Étape 174 : le modèle d'image seulement si la machine a la puissance ---

test('étape 494 : les niveaux proposés suivent la carte graphique (tailles de cartes telles que Windows les lit)', () => {
  const { availableImageQualities, pickImageModel, IMAGE_MODEL } = imageModel
  assert.equal(IMAGE_MODEL, 'Z-Image-Turbo')
  for (const [vram, expected] of [
    [3.9, ['q2']],
    [4.8, ['q2', 'q3']],
    [5.8, ['q2', 'q3', 'q4']],
    [7.9, ['q2', 'q3', 'q4', 'q5', 'q6']],
    [10, ['q2', 'q3', 'q4', 'q5', 'q6', 'q8']],
    [24, ['q2', 'q3', 'q4', 'q5', 'q6', 'q8']]
  ]) {
    assert.deepEqual([...availableImageQualities(vram, 32).qualities], expected, `carte ${vram} Go`)
  }
  assert.equal(pickImageModel(7.9, 15.8).model, 'Z-Image-Turbo Q6', 'une carte « 8 Go » et un PC « 16 Go » tels que lus par Windows')
  assert.equal(pickImageModel(7.9, 15.8).quality, 'q6')
  assert.equal(pickImageModel(12, 32).model, 'Z-Image-Turbo Q8')
  for (const [vram, ram, why] of [[null, 32, /aucune carte graphique/], [3, 32, /trop petite \(3 Go/], [12, 8, /pas assez de RAM \(8 Go/]]) {
    const pick = pickImageModel(vram, ram)
    assert.equal(pick.model, null)
    assert.equal(pick.quality, null)
    assert.match(pick.reason, why)
  }
})

test('étape 494 : le poids annoncé de chaque niveau (Options → Modèles) correspond aux vrais fichiers', () => {
  const t = loadGenerator()
  // Tailles figées dans imageGenerator.ts (lues sur le disque : loadGenerator les remplace pour simuler les téléchargements).
  const source = readFileSync(join(projectRoot, 'electron/services/imageGenerator.ts'), 'utf8')
  const bytesOf = (name) => Number(source.match(new RegExp(`fileName: '${name.replace(/\./g, '\\.')}'[^}]*?bytes: ([\\d_]+)`))[1].replaceAll('_', ''))
  const engine = Number(source.match(/bytes: ([\d_]+),\s*sha256: '63e8/)[1].replaceAll('_', ''))
  const shared = bytesOf('z-image-vae.safetensors') + bytesOf('Qwen3-4B-Q4_K_M.gguf')
  for (const level of imageModel.IMAGE_QUALITIES) {
    const total = engine + shared + bytesOf(t.gen.IMAGE_QUALITY_FILES[level.id].fileName)
    assert.equal(level.downloadGb, Math.round(total / 1e9), `${level.label} : ${total} octets`)
  }
  t.cleanup()
})

test('étape 494 : un niveau trop lourd pour la machine est refusé AVANT tout téléchargement, avec ce qu’il demande', async () => {
  const t = loadGenerator({ vramGb: 7.9 })
  await assert.rejects(t.gen.installImageModel('q8'), /La qualité Q8 demande une carte graphique de 10 Go et 16 Go de RAM/)
  assert.equal(t.downloads.length, 0)
  await t.gen.installImageModel('q6')
  await assert.rejects(t.gen.generateImage('cat', () => {}, undefined, undefined, 'q8'), /La qualité Q8 demande/)
  assert.ok(!t.events.includes('spawn'))
  t.cleanup()
})

test('étape 494 : le niveau choisi dessine ; sans choix (Chat, voix, Duel), le plus fidèle déjà installé', async () => {
  const t = await installed({ vramGb: 7.9 }, 'q2')
  await t.gen.installImageModel('q4')
  const model = () => t.gen.lastSpawn.spawnArgs.args[t.gen.lastSpawn.spawnArgs.args.indexOf('--diffusion-model') + 1]
  await t.gen.generateImage('cat', () => {})
  assert.match(model(), /z_image_turbo-Q4_K\.gguf$/, 'Q6 n’est pas téléchargé : le meilleur installé est Q4')
  await t.gen.generateImage('cat', () => {}, undefined, undefined, 'q2')
  assert.match(model(), /z_image_turbo-Q2_K\.gguf$/)
  await assert.rejects(t.gen.generateImage('cat', () => {}, undefined, undefined, 'q6'), /La qualité Q6 du modèle d'image n'est pas encore téléchargée/)
  assert.equal(await t.gen.isImageQualityInstalled('q6'), false)
  assert.equal(await t.gen.imageDrawingAvailable(), true)
  t.cleanup()
})

test('étape 494 : l’état du mode Image liste les niveaux de la machine, installés ou à télécharger', async () => {
  const t = await installed({ vramGb: 5.8 }, 'q3')
  const status = await t.gen.getImageStudioStatus()
  assert.equal(status.capable, true)
  assert.equal(status.installed, true)
  assert.deepEqual(status.qualities.map((q) => [q.id, q.label, q.installed]), [['q2', 'Q2', false], ['q3', 'Q3', true], ['q4', 'Q4', false]])
  // Il ne reste que le dessinateur à télécharger pour Q4 : le moteur, le décodeur et le lecteur sont déjà là.
  assert.equal(status.qualities[2].downloadLabel, `${t.gen.IMAGE_QUALITY_FILES.q4.bytes} o`)
  t.cleanup()
})

test('étape 494 : une fois Z-Image installé, les fichiers de FLUX.2 klein sont effacés, le lecteur commun reste', async () => {
  const t = loadGenerator()
  const models = join(t.env.LOCALAPPDATA, 'Jaris', 'image-generation', 'models')
  mkdirSync(join(models, 'video'), { recursive: true })
  for (const name of [...t.gen.LEGACY_IMAGE_FILES, 'video/fastwan.gguf']) writeFileSync(join(models, name), 'ancien')
  await t.gen.installImageModel('q6')
  for (const name of t.gen.LEGACY_IMAGE_FILES) assert.equal(existsSync(join(models, name)), false, `${name} aurait dû être effacé`)
  assert.equal(existsSync(join(models, 'Qwen3-4B-Q4_K_M.gguf')), true)
  assert.equal(existsSync(join(models, 'video', 'fastwan.gguf')), true, 'la vidéo n’est pas touchée')
  t.cleanup()
})

test('étape 494 : un téléchargement raté ne fait jamais perdre klein (rien n’est effacé avant la fin)', async () => {
  const t = loadGenerator({ corruptFile: 'Qwen3-4B' })
  const models = join(t.env.LOCALAPPDATA, 'Jaris', 'image-generation', 'models')
  mkdirSync(models, { recursive: true })
  for (const name of t.gen.LEGACY_IMAGE_FILES) writeFileSync(join(models, name), 'ancien')
  await assert.rejects(t.gen.installImageModel('q6'))
  for (const name of t.gen.LEGACY_IMAGE_FILES) assert.equal(existsSync(join(models, name)), true)
  t.cleanup()
})

test('pas assez de puissance : refus lisible AVANT tout téléchargement (plusieurs Go jamais perdus)', async () => {
  const t = loadGenerator({ vramGb: 3 })
  await assert.rejects(t.gen.generateImage('a cat'), /Ton PC n'a pas assez de puissance pour dessiner des images : carte graphique trop petite/)
  await assert.rejects(t.gen.installImageModel('q2'), /carte graphique trop petite/)
  assert.equal(t.downloads.length, 0)
  assert.deepEqual(t.events, [])
  // Et le refus ne bloque pas la suite (verrou jamais posé).
  t.cleanup()
})

test('isImageModelInstalled : vrai seulement avec le moteur ET les trois fichiers à la bonne taille', async () => {
  const t = loadGenerator()
  assert.equal(await t.gen.isImageModelInstalled(), false)
  await t.gen.installImageModel('q6')
  assert.equal(await t.gen.isImageModelInstalled(), true)
  rmSync(join(t.env.LOCALAPPDATA, 'Jaris', 'image-generation', 'bin', 'sd-cli.exe'))
  assert.equal(await t.gen.isImageModelInstalled(), false, 'moteur absent = pas installé')
  t.cleanup()
})

// Étape 292 (Léo, capture à l'appui : « je lui ai envoyé "chat" comme prompt, voici ce qu'il m'a fait » — un homme
// souriant à un bureau) : le modèle de dessin lit l'anglais, « un chat » y devient « a chat », une conversation.
test('une demande tapée en français est traduite AVANT le dessin, le nom du fichier garde les mots de Léo', async () => {
  const t = await installed()
  t.events.length = 0
  const logs = []
  const translated = []
  const image = await t.gen.generateImage('un chat', (m) => logs.push(m), undefined, async (text) => {
    translated.push(text)
    t.events.push('translate')
    return { text: 'a cat', translated: true }
  })
  assert.deepEqual(translated, ['un chat'])
  // La traduction utilise un modèle d'Ollama : elle passe AVANT de libérer la carte graphique pour le dessin.
  assert.deepEqual(t.events, ['translate', 'unload', 'spawn'])
  assert.match(image.fileName, /-un-chat\.png$/, 'la liste doit dire « Un chat », pas « A cat »')
  assert.ok(logs.includes('Demande traduite pour le dessin : « a cat »'), 'Léo voit ce qui part vraiment au dessin')
  t.cleanup()
})

test('le texte TRADUIT est celui qui part à sd-cli, et une traduction impossible garde la demande telle quelle', async () => {
  for (const [answer, expected] of [
    [{ text: 'a cat', translated: true }, 'a cat'],
    [{ text: 'un chat', translated: false }, 'un chat'],
    [{ text: '   ', translated: true }, 'un chat']
  ]) {
    const t = await installed()
    await t.gen.generateImage('un chat', () => {}, undefined, async () => answer)
    const { args } = t.gen.lastSpawn.spawnArgs
    assert.equal(args[args.indexOf('-p') + 1], expected)
    t.cleanup()
  }
})

test('sans traduction demandée (l’outil du Chat écrit déjà en anglais), rien ne change', async () => {
  const t = await installed()
  t.events.length = 0
  await t.gen.generateImage('a ginger cat on a blue sofa', () => {})
  assert.deepEqual(t.events, ['unload', 'spawn'])
  const { args } = t.gen.lastSpawn.spawnArgs
  assert.equal(args[args.indexOf('-p') + 1], 'a ginger cat on a blue sofa')
  t.cleanup()
})
