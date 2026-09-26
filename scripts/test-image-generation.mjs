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

/**
 * Génération d'images en local (étape 173 : stable-diffusion.cpp + FLUX.2 klein 4B).
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
  vm.runInThisContext(`(function (exports, module) { ${transpile(relativePath)} })`)(module.exports, module)
  return module.exports
}
const nodeRequire = createRequire(import.meta.url)

function transpile(relativePath) {
  return ts.transpileModule(readFileSync(join(projectRoot, relativePath), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
}

const imageModel = loadPure('shared/imageModel.ts')

/** Lignes réelles de sd-cli (génération FLUX.2 klein sur ce conteneur), barres de progression comprises. */
const REAL_OUTPUT = [
  '[INFO   ] image.cpp:524  - get_learned_condition completed, taking 17.34s',
  '  |#######################                           | 67/149 - 3.31GB/s',
  '  |##################################################| 149/149 - 830.58MB/s',
  '  |============>                                     | 1/4 - 82.29s/it',
  '  |=========================>                        | 2/4 - 79.24s/it',
  '  |=====================================>            | 3/4 - 79.37s/it',
  '  |==================================================| 4/4 - 79.10s/it',
  "[INFO   ] main.cpp:497  - save result image 0 to 'out.png' (success)"
]

function sha(content) {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Charge imageGenerator.ts avec des faux : téléchargement (écrit un contenu connu), tar.exe (pose sd-cli.exe),
 * sd-cli (écrit la vraie sortie ci-dessus puis l'image), Ollama (note le déchargement).
 */
function loadGenerator({ corruptFile = null, engineExitCode = 0, engineOutput = REAL_OUTPUT, holdEngine = false, vramGb = 8, ramGb = 32 } = {}) {
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
      if (!holdEngine) {
        setImmediate(() => {
          for (const line of engineOutput) proc.stdout.emit('data', Buffer.from(`${line}\r`))
          if (engineExitCode === 0) writeFileSync(args[args.indexOf('-o') + 1], 'png')
          proc.emit('close', engineExitCode)
        })
      }
      return proc
    }
  }

  const contents = new Map()
  const modules = {
    child_process: fakeChildProcess,
    './dataLocation': { getDataRoot: () => dataRoot },
    './ollama': {
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
    '../../shared/imageModel': imageModel
  }
  const fakeProcess = { platform: 'win32', env }
  const module = { exports: {} }
  vm.runInThisContext(`(function (exports, module, require, process) { ${transpile('electron/services/imageGenerator.ts')} })`)(
    module.exports,
    module,
    (id) => modules[id] ?? nodeRequire(id),
    fakeProcess
  )
  const loaded = module.exports

  // Contenus simulés à la bonne taille/empreinte : les constantes figées sont remplacées pour ce test seulement.
  const engineContent = 'moteur'
  contents.set(loaded.SD_ENGINE.url, engineContent)
  Object.assign(loaded.SD_ENGINE, { bytes: engineContent.length, sha256: sha(engineContent) })
  for (const file of loaded.IMAGE_MODEL_FILES) {
    const content = `poids ${file.role}`
    contents.set(file.url, content)
    Object.assign(file, { bytes: content.length, sha256: sha(content) })
  }
  return { gen: loaded, root, env, dataRoot, events, downloads, killed, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('premier dessin : tout se télécharge, la carte graphique est libérée AVANT de lancer sd-cli, l’image est créée', async () => {
  const t = loadGenerator()
  const logs = []
  const image = await t.gen.generateImage('a ginger cat on a blue sofa', (m) => logs.push(m))

  assert.equal(t.downloads.length, 4, 'le moteur + les trois fichiers du modèle')
  assert.deepEqual(t.events, ['extract', 'unload', 'spawn'])
  assert.ok(existsSync(image.path), 'le PNG existe')
  assert.equal(dirname(image.path), join(t.dataRoot, 'generated-images'), 'rangé avec les données de Léo')
  assert.match(image.fileName, /^\d{4}-\d{2}-\d{2}T[\d-]+-a-ginger-cat-on-a-blue-sofa\.png$/)
  // Avancement lu sur la vraie sortie : les étapes de dessin, jamais les compteurs du chargement des poids.
  assert.deepEqual(logs.filter((l) => l.startsWith('Dessin')), ['Dessin : étape 1 sur 4', 'Dessin : étape 2 sur 4', 'Dessin : étape 3 sur 4', 'Dessin : étape 4 sur 4'])
  assert.ok(logs.some((l) => l.includes('Carte graphique libérée')))
  t.cleanup()
})

test('deuxième dessin : rien n’est retéléchargé', async () => {
  const t = loadGenerator()
  await t.gen.generateImage('first')
  const before = t.downloads.length
  await t.gen.generateImage('second')
  assert.equal(t.downloads.length, before)
  t.cleanup()
})

test('la description passe en UN argument (jamais un shell), avec la commande documentée pour FLUX.2 klein', async () => {
  const t = loadGenerator()
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
  assert.equal(args[args.indexOf('--steps') + 1], '4')
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
  await assert.rejects(t.gen.generateImage('cat'), /ne correspond pas à l'original/)
  assert.ok(!t.events.includes('spawn'))
  const models = join(t.env.LOCALAPPDATA, 'Jaris', 'image-generation', 'models')
  assert.deepEqual(readdirSync(models).filter((f) => f.startsWith('Qwen3')), [], 'ni fichier final, ni fichier partiel')
  t.cleanup()
})

test('un manque de mémoire devient une phrase lisible par Léo', async () => {
  const t = loadGenerator({ engineExitCode: 1, engineOutput: ['ggml_vulkan: Device memory allocation failed', 'ErrorOutOfDeviceMemory'] })
  await assert.rejects(t.gen.generateImage('cat'), /Pas assez de mémoire pour dessiner/)
  t.cleanup()
})

test('une seule image à la fois, et un arrêt demandé tue vraiment sd-cli', async () => {
  const t = loadGenerator({ holdEngine: true })
  const controller = new AbortController()
  const first = t.gen.generateImage('cat', () => {}, controller.signal)
  while (!t.gen.lastSpawn) await new Promise((r) => setImmediate(r))
  await assert.rejects(t.gen.generateImage('dog'), /déjà en train de dessiner/)
  controller.abort()
  await assert.rejects(first, /annulé/)
  assert.deepEqual(t.killed[0], ['/PID', '4242', '/T', '/F'], 'tout l’arbre de processus est arrêté')
  t.cleanup()
})

test('une image n’est relue que par son NOM, jamais par un chemin venu de l’historique', async () => {
  const t = loadGenerator()
  const image = await t.gen.generateImage('cat')
  assert.match(await t.gen.readGeneratedImageDataUrl(image.fileName), /^data:image\/png;base64,/)
  assert.equal(await t.gen.readGeneratedImageDataUrl('../../profile.png'), null)
  assert.equal(await t.gen.readGeneratedImageDataUrl('C:\\Windows\\x.png'), null)
  t.cleanup()
})

test('les révisions figées pointent vers des fichiers sous licence libre, tailles et empreintes renseignées', () => {
  const t = loadGenerator()
  const source = readFileSync(join(projectRoot, 'electron/services/imageGenerator.ts'), 'utf8')
  assert.equal(t.gen.SD_ENGINE.url, 'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-920-2f88688/sd-master-2f88688-bin-win-vulkan-x64.zip')
  for (const repo of ['leejet/FLUX.2-klein-4B-GGUF/resolve/3b1f5a9', 'black-forest-labs/FLUX.2-klein-4B/resolve/e7b7dc2', 'unsloth/Qwen3-4B-GGUF/resolve/22c9fc8']) {
    assert.ok(source.includes(repo), `${repo} : révision figée attendue (jamais « main »)`)
  }
  assert.ok(!/\/resolve\/main\//.test(source))
  assert.equal((source.match(/sha256: '[0-9a-f]{64}'/g) ?? []).length, 4)
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
    './notepad': { requestedNotepadText: noteExports.requestedNotepadText, openNotepadText: async () => '' },
    './appLauncher': { didAppLaunch: (r) => r.endsWith('a été lancé.') },
    './hardwareScan': { GPU_TEMP_LIMIT_C: 85 },
    './modelChoice': modelChoiceModule,
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
  vm.runInNewContext(transpile('electron/services/assistant.ts'), { exports, Error, require: (name) => modules[name] })
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

test('un seul modèle d’image, ou aucun si la machine n’a pas la puissance', () => {
  const { pickImageModel, IMAGE_MODEL } = imageModel
  assert.equal(IMAGE_MODEL, 'FLUX.2 klein 4B')
  assert.equal(pickImageModel(8, 32).model, 'FLUX.2 klein 4B')
  assert.equal(pickImageModel(5.8, 15.8).model, 'FLUX.2 klein 4B', 'une carte « 6 Go » et un PC « 16 Go » tels que lus par Windows')
  for (const [vram, ram, why] of [[null, 32, /aucune carte graphique/], [4, 32, /trop petite \(4 Go/], [12, 8, /pas assez de RAM \(8 Go/]]) {
    const pick = pickImageModel(vram, ram)
    assert.equal(pick.model, null)
    assert.match(pick.reason, why)
  }
})

test('pas assez de puissance : refus lisible AVANT tout téléchargement (5 Go jamais perdus)', async () => {
  const t = loadGenerator({ vramGb: 4 })
  await assert.rejects(t.gen.generateImage('a cat'), /Ton PC n'a pas assez de puissance pour dessiner des images : carte graphique trop petite/)
  assert.equal(t.downloads.length, 0)
  assert.deepEqual(t.events, [])
  // Et le refus ne bloque pas la suite (verrou jamais posé).
  t.cleanup()
})

test('isImageModelInstalled : vrai seulement quand les trois fichiers sont là, à la bonne taille', async () => {
  const t = loadGenerator()
  assert.equal(await t.gen.isImageModelInstalled(), false)
  await t.gen.generateImage('a cat')
  assert.equal(await t.gen.isImageModelInstalled(), true)
  t.cleanup()
})
