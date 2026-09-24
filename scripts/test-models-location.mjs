import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { EventEmitter } from 'node:events'

const nodeRequire = createRequire(import.meta.url)

/**
 * Étape 143, Léo : « ça doit tout déplacer, jamais une partie ». Les dossiers lourds (modèles ET programme
 * Ollama, données d'Ollama, Python, voix) basculent en TOUT OU RIEN : copie de tout, puis bascule de tout
 * (défaite entièrement au moindre échec), puis seulement l'effacement des anciens emplacements.
 *
 * Historique : "Déplacer" (Options -> Modèles, étape 44) : redirige les modèles Ollama, l'environnement Python et le
 * cache HuggingFace vers un dossier choisi via des jonctions NTFS (`mklink /J`, transparentes pour Ollama/
 * Python, qui continuent de lire/écrire au même chemin habituel sans rien savoir du changement).
 *
 * Léo, en usage réel : "regarde qu'on clique sur déplacer, dans les options ça déplace bien tout les
 * fichiers plus ollama et quand il y a une mise à jour c'est dans le dossier choisi" — deux vérifications :
 * (1) que les modèles OLLAMA sont bien l'une des trois briques déplacées (pas seulement Python/HuggingFace) ;
 * (2) que mettre à jour Ollama (bouton "Mettre à jour", dependencyServices.ts) ne touche jamais directement
 * au dossier des modèles — seulement à l'application Ollama elle-même —, donc que le prochain modèle
 * téléchargé après une mise à jour continue de passer par la jonction déjà posée. Ce fichier n'a JAMAIS eu
 * de test de régression avant cette vérification (grep confirmé avant d'écrire celui-ci).
 *
 * `createJunction` (modelsLocation.ts) lance `cmd.exe`/`mklink /J` : le `child_process.spawn` mocké ci-dessous
 * pose un VRAI lien équivalent à la place (jonction sur Windows, lien symbolique sur Linux). Une jonction ne
 * demande pas le privilège spécial exigé par les symlinks Windows ; le test peut donc tourner sur la machine
 * de développement comme dans le runner Linux. Tout le reste (cp/mkdir/rm/lstat/readlink) est du VRAI fs sur
 * un VRAI dossier temporaire, pas un mock — seule la commande Windows elle-même est feinte.
 * `process` est shadowé (paramètre de la fonction wrapper, pas le global Node) pour forcer `process.platform`
 * à 'win32' (sinon `moveModelsLocation` ressort immédiatement, "Windows pour l'instant") et contrôler
 * `process.env.USERPROFILE`/`LOCALAPPDATA` sans toucher au vrai environnement du process de test.
 */
function loadModelsLocation(env, { failJunctionFor = null } = {}) {
  const source = ts.transpileModule(readFileSync(new URL('../electron/services/modelsLocation.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText

  const fakeProcess = { platform: 'win32', env }

  const fakeChildProcess = {
    spawn: (_cmd, args) => {
      // args: ['/c', 'mklink', '/J', link, target] (voir createJunction, modelsLocation.ts)
      const link = args[3]
      const target = args[4]
      const emitter = new EventEmitter()
      emitter.stderr = new EventEmitter()
      queueMicrotask(() => {
        try {
          if (failJunctionFor && link.endsWith(failJunctionFor)) throw new Error('mklink refusé (simulé)')
          nodeRequire('fs').symlinkSync(target, link, process.platform === 'win32' ? 'junction' : undefined)
          emitter.emit('close', 0)
        } catch (err) {
          emitter.stderr.emit('data', Buffer.from(String(err)))
          emitter.emit('close', 1)
        }
      })
      return emitter
    }
  }

  const modules = {
    fs: nodeRequire('fs'),
    'fs/promises': nodeRequire('fs/promises'),
    child_process: fakeChildProcess,
    path: nodeRequire('path')
  }
  const exports = {}
  vm.runInThisContext(`(function (exports, module, require, process) { ${source} })`)(
    exports,
    { exports },
    (name) => modules[name] ?? nodeRequire(name),
    fakeProcess
  )
  return exports
}

function setupFakeHome() {
  const root = mkdtempSync(join(tmpdir(), 'jaris-models-location-'))
  const userProfile = join(root, 'user')
  const localAppData = join(root, 'localappdata')
  mkdirSync(userProfile, { recursive: true })
  mkdirSync(localAppData, { recursive: true })
  return { root, userProfile, localAppData, env: { USERPROFILE: userProfile, LOCALAPPDATA: localAppData } }
}

/** Une machine où tout est installé, sur C, avec un fichier témoin dans chaque dossier. */
function fillEverything({ userProfile, localAppData }) {
  const files = {
    [join(userProfile, '.ollama', 'models', 'blobs', 'sha256-1')]: 'poids du modèle',
    [join(localAppData, 'Programs', 'Ollama', 'ollama.exe')]: 'programme ollama',
    [join(localAppData, 'Ollama', 'server.log')]: 'journal',
    [join(localAppData, 'Jaris', 'python-runtime', 'python.exe')]: 'python',
    [join(userProfile, '.cache', 'huggingface', 'hub', 'model.bin')]: 'voix',
    [join(userProfile, '.cache', 'supertonic3', 'onnx', 'vector_estimator.onnx')]: 'voix de Jaris'
  }
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
  return files
}

const SUBDIRS = ['ollama-models', 'ollama-app', 'ollama-data', 'python-runtime', 'huggingface-cache', 'supertonic-cache']

test('tout part : modèles ET programme Ollama, données d’Ollama, Python et voix — accessibles au même chemin qu’avant', async () => {
  const home = setupFakeHome()
  const files = fillEverything(home)
  const newRoot = join(home.root, 'D', 'Jaris-data')
  const { moveBricksInto, bricks } = loadModelsLocation(home.env)

  await moveBricksInto(newRoot, () => {})

  for (const brick of bricks()) {
    assert.ok(lstatSync(brick.link).isSymbolicLink(), `${brick.label} : l'emplacement habituel doit être une jonction`)
    assert.ok(existsSync(join(newRoot, brick.subdir)), `${brick.label} : doit exister dans le dossier de Jaris`)
    assert.ok(!existsSync(`${brick.link}.jaris-old`), `${brick.label} : aucune sauvegarde ne doit traîner`)
  }
  // Chaque fichier se relit au même chemin qu'avant (à travers la jonction) : Ollama et Python n'y voient rien.
  for (const [path, content] of Object.entries(files)) assert.equal(readFileSync(path, 'utf8'), content)
  assert.deepEqual(SUBDIRS.map((sub) => existsSync(join(newRoot, sub))), SUBDIRS.map(() => true))
  rmSync(home.root, { recursive: true, force: true })
})

test('jamais une partie : si la bascule d’UN dossier échoue, TOUS reviennent comme avant', async () => {
  const home = setupFakeHome()
  const files = fillEverything(home)
  const newRoot = join(home.root, 'D', 'Jaris-data')
  // La 4e bascule (Python) échoue : les 3 premières, déjà faites, doivent être défaites.
  const { moveBricksInto, bricks } = loadModelsLocation(home.env, { failJunctionFor: 'python-runtime' })

  await assert.rejects(moveBricksInto(newRoot, () => {}), /Python/)

  for (const brick of bricks()) {
    assert.ok(!lstatSync(brick.link).isSymbolicLink(), `${brick.label} : doit être redevenu un dossier normal`)
    assert.ok(!existsSync(`${brick.link}.jaris-old`), `${brick.label} : la sauvegarde doit avoir été remise en place`)
  }
  for (const [path, content] of Object.entries(files)) assert.equal(readFileSync(path, 'utf8'), content, `${path} intact`)
  assert.ok(!existsSync(join(newRoot, 'ollama-models')), 'les copies faites pour rien sont effacées')
  rmSync(home.root, { recursive: true, force: true })
})

test('une copie qui échoue ne touche à RIEN à l’origine, et n’efface pas ce qui existait déjà à destination', async () => {
  const home = setupFakeHome()
  const files = fillEverything(home)
  const newRoot = join(home.root, 'D', 'Jaris-data')
  mkdirSync(newRoot, { recursive: true })
  // Un FICHIER là où la copie de Python doit créer un dossier : la copie échoue à mi-chemin.
  writeFileSync(join(newRoot, 'python-runtime'), 'fichier de quelqu’un d’autre')
  const { moveBricksInto, bricks } = loadModelsLocation(home.env)

  await assert.rejects(moveBricksInto(newRoot, () => {}))

  for (const brick of bricks()) assert.ok(!lstatSync(brick.link).isSymbolicLink(), `${brick.label} : non basculé`)
  for (const [path, content] of Object.entries(files)) assert.equal(readFileSync(path, 'utf8'), content)
  assert.ok(!existsSync(join(newRoot, 'ollama-models')), 'les copies créées par cet essai sont effacées')
  assert.equal(readFileSync(join(newRoot, 'python-runtime'), 'utf8'), 'fichier de quelqu’un d’autre', 'un fichier préexistant n’est jamais effacé')
  rmSync(home.root, { recursive: true, force: true })
})

test('un second déplacement emporte tout vers le nouveau dossier et efface l’ancien, sans rien perdre', async () => {
  const home = setupFakeHome()
  const files = fillEverything(home)
  const first = join(home.root, 'D', 'Jaris-data')
  const second = join(home.root, 'E', 'Jaris')
  const { moveBricksInto, bricks } = loadModelsLocation(home.env)

  await moveBricksInto(first, () => {})
  await moveBricksInto(second, () => {})

  for (const brick of bricks()) {
    assert.equal(readlinkSync(brick.link), join(second, brick.subdir))
    assert.ok(!existsSync(join(first, brick.subdir)), `${brick.label} : l'ancien dossier est effacé`)
  }
  for (const [path, content] of Object.entries(files)) assert.equal(readFileSync(path, 'utf8'), content)
  rmSync(home.root, { recursive: true, force: true })
})

test('machine neuve (rien d’installé) : les jonctions sont posées AVANT, Ollama et Python s’installeront directement dans le dossier', async () => {
  const home = setupFakeHome()
  const newRoot = join(home.root, 'D', 'Jaris-data')
  const { moveBricksInto, bricks, planMoves } = loadModelsLocation(home.env)

  await moveBricksInto(newRoot, () => {})

  for (const brick of bricks()) assert.equal(readlinkSync(brick.link), join(newRoot, brick.subdir))
  // Un fichier écrit plus tard au chemin habituel (installation d'Ollama) atterrit dans le dossier de Jaris.
  writeFileSync(join(home.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe'), 'installé ensuite')
  assert.equal(readFileSync(join(newRoot, 'ollama-app', 'ollama.exe'), 'utf8'), 'installé ensuite')
  assert.equal((await planMoves(newRoot)).length, 0, 'au démarrage suivant, plus rien à ranger')
  rmSync(home.root, { recursive: true, force: true })
})

test('réinstaller Python vide son dossier au lieu de le supprimer (sinon la jonction disparaîtrait et Python repartirait sur C)', () => {
  const source = readFileSync(new URL('../electron/services/pythonRuntime.ts', import.meta.url), 'utf8')
  const install = source.slice(source.indexOf('export async function installPythonRuntime('))
  const beforeDownload = install.slice(0, install.indexOf('findPythonArchiveUrl'))
  assert.ok(!/await rm\(dir,/.test(beforeDownload), 'le dossier lui-même ne doit plus être supprimé')
  assert.match(beforeDownload, /readdir\(dir\)/)
})

test("le bouton \"Mettre à jour\" d'Ollama ne touche JAMAIS au dossier des modèles lui-même", () => {
  // Léo : "quand il y a une mise à jour c'est dans le dossier choisi" — vérifié en s'assurant que la mise à
  // jour d'Ollama (dependencyServices.ts) ne fait rien d'autre que redémarrer/réinstaller L'APPLICATION : si
  // elle touchait aussi au chemin des modèles (`.ollama\models`, la jonction posée par modelsLocation.ts),
  // un futur changement pourrait accidentellement recréer un dossier ORDINAIRE par-dessus la jonction et
  // faire perdre le lien vers le disque choisi, sans qu'aucun test ne l'attrape. Un modèle téléchargé APRÈS
  // une mise à jour continue de passer par la jonction déjà posée précisément PARCE QUE rien dans le flux de
  // mise à jour ne la recrée ni ne la supprime.
  const source = readFileSync(new URL('../electron/services/dependencyServices.ts', import.meta.url), 'utf8')
  const updateSectionStart = source.indexOf('export async function updateOllama(')
  assert.ok(updateSectionStart !== -1, 'updateOllama introuvable dans dependencyServices.ts')
  // Toute la fonction, jusqu'à la prochaine fonction de haut niveau exportée après elle (ensureOllamaRunning).
  const nextExportStart = source.indexOf('export async function ensureOllamaRunning(', updateSectionStart)
  assert.ok(nextExportStart !== -1, 'ensureOllamaRunning introuvable après updateOllama')
  const updateFlow = source.slice(updateSectionStart, nextExportStart)

  assert.ok(!/\.ollama[\\/]?models/i.test(updateFlow), 'le flux de mise à jour ne doit jamais référencer le dossier des modèles Ollama directement')
  assert.ok(!/\brmSync\(|['"]rm['"]|\brm\(/i.test(updateFlow.replace(/\bwarm\b/gi, '')), 'le flux de mise à jour ne doit jamais supprimer de dossier')
})

test('pip n’écrit pas son cache sur C : chaque installation Python passe --no-cache-dir', () => {
  // Sans ça, chaque paquet téléchargé finissait aussi dans %LOCALAPPDATA%\pip\cache, quel que soit le disque choisi.
  const source = readFileSync(new URL('../electron/services/pythonRuntime.ts', import.meta.url), 'utf8')
  assert.match(source, /PIP_INSTALL = \['-m', 'pip', 'install', '--no-cache-dir'\]/)
  const installs = [...source.matchAll(/run\(python, \[([^\]]*)/g)].map((m) => m[1]).filter((args) => args.includes('pip') || args.includes('PIP_INSTALL'))
  assert.ok(installs.length >= 1) // une seule depuis l’étape 158 (plus d’installation de torch à part)
  for (const args of installs) assert.ok(args.startsWith('...PIP_INSTALL'), `installation pip sans --no-cache-dir : ${args}`)
})

test('la voix de Jaris (Supertonic) est déplacée elle aussi, et le dossier suit la version installée (étape 155)', () => {
  // Supertonic range son modèle dans ~/.cache/<cache_dir du modèle par défaut>, HORS du cache HuggingFace :
  // « supertonic3 » pour supertonic==1.3.1 (supertonic/config.py, DEFAULT_MODEL = "supertonic-3"). Une autre
  // version pourrait changer ce dossier : ce test oblige alors à revérifier avant de mettre à jour.
  const requirements = readFileSync(new URL('../python/requirements.txt', import.meta.url), 'utf8')
  assert.match(requirements, /^supertonic==1\.3\.1\r?$/m, 'Supertonic a changé de version : revérifier son dossier de cache (modelsLocation.ts)')
  const source = readFileSync(new URL('../electron/services/modelsLocation.ts', import.meta.url), 'utf8')
  assert.match(source, /join\(profile, '\.cache', 'supertonic3'\)/)
})
