import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { EventEmitter } from 'node:events'

const nodeRequire = createRequire(import.meta.url)

/**
 * "Déplacer" (Options -> Modèles, étape 44) : redirige les modèles Ollama, l'environnement Python et le
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
function loadModelsLocation(env) {
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
  return { root, userProfile, localAppData }
}

test('moveModelsLocation déplace les 3 briques, OLLAMA COMPRIS (pas seulement Python/HuggingFace)', async () => {
  const { root, userProfile, localAppData } = setupFakeHome()
  const { moveModelsLocation, getModelsLocationStatus } = loadModelsLocation({ USERPROFILE: userProfile, LOCALAPPDATA: localAppData })

  // Contenu réel préexistant pour les 3 briques, comme sur une vraie installation.
  mkdirSync(join(userProfile, '.ollama', 'models'), { recursive: true })
  writeFileSync(join(userProfile, '.ollama', 'models', 'qwen3.5-9b.gguf'), 'faux poids de modèle')
  mkdirSync(join(localAppData, 'Jaris', 'python-runtime'), { recursive: true })
  writeFileSync(join(localAppData, 'Jaris', 'python-runtime', 'python.exe'), 'faux binaire python')
  mkdirSync(join(userProfile, '.cache', 'huggingface'), { recursive: true })
  writeFileSync(join(userProfile, '.cache', 'huggingface', 'stt-model.bin'), 'faux modèle de transcription')

  const newDir = join(root, 'D-disque', 'jaris-data')
  const progress = []
  const result = await moveModelsLocation(newDir, (m) => progress.push(m))

  assert.equal(result.success, true, `déplacement attendu réussi, reçu : ${JSON.stringify(result)}`)
  assert.ok(result.message.includes(newDir), 'le message doit citer le dossier de destination')

  // Les 3 fichiers doivent être RÉELLEMENT arrivés sur le nouveau disque — Ollama comme les deux autres.
  assert.equal(readFileSync(join(newDir, 'ollama-models', 'qwen3.5-9b.gguf'), 'utf8'), 'faux poids de modèle')
  assert.equal(readFileSync(join(newDir, 'python-runtime', 'python.exe'), 'utf8'), 'faux binaire python')
  assert.equal(readFileSync(join(newDir, 'huggingface-cache', 'stt-model.bin'), 'utf8'), 'faux modèle de transcription')

  // L'ancien emplacement des modèles Ollama doit maintenant être une jonction (symlink ici) vers le nouveau
  // disque, PAS un dossier normal laissé en place avec une copie en double.
  const ollamaLink = join(userProfile, '.ollama', 'models')
  assert.ok(lstatSync(ollamaLink).isSymbolicLink(), "l'ancien chemin Ollama doit être redirigé (jonction), pas un dossier ordinaire")

  // getModelsLocationStatus doit refléter le VRAI dossier (celui du nouveau disque), pas l'ancien chemin.
  const status = await getModelsLocationStatus()
  assert.equal(status.ollamaModelsDir, join(newDir, 'ollama-models'))
  assert.equal(status.pythonRuntimeDir, join(newDir, 'python-runtime'))
  assert.equal(status.hfCacheDir, join(newDir, 'huggingface-cache'))

  rmSync(root, { recursive: true, force: true })
})

test('un problème sur une seule brique ne bloque pas les deux autres', async () => {
  const { root, userProfile, localAppData } = setupFakeHome()
  const { moveModelsLocation } = loadModelsLocation({ USERPROFILE: userProfile, LOCALAPPDATA: localAppData })

  mkdirSync(join(userProfile, '.ollama', 'models'), { recursive: true })
  writeFileSync(join(userProfile, '.ollama', 'models', 'model.gguf'), 'poids ollama')
  mkdirSync(join(localAppData, 'Jaris', 'python-runtime'), { recursive: true })
  writeFileSync(join(localAppData, 'Jaris', 'python-runtime', 'python.exe'), 'binaire python')
  mkdirSync(join(userProfile, '.cache', 'huggingface'), { recursive: true })
  writeFileSync(join(userProfile, '.cache', 'huggingface', 'stt.bin'), 'modèle vocal')

  const newDir = join(root, 'D-disque', 'jaris-data')
  // Un FICHIER (pas un dossier) à l'endroit exact où le cache HuggingFace devrait être copié : mkdir()
  // dessus échoue (ENOTDIR), forçant un échec RÉEL et ciblé sur cette seule brique, sans mock du fs.
  mkdirSync(newDir, { recursive: true })
  writeFileSync(join(newDir, 'huggingface-cache'), 'bloque volontairement cette brique')

  const result = await moveModelsLocation(newDir, () => {})

  assert.equal(result.success, false, 'un échec partiel doit être signalé, pas un faux succès')
  assert.ok(result.message.includes('huggingface') || result.message.toLowerCase().includes('cache'), `le message doit nommer la brique en échec : ${result.message}`)

  // Ollama ET Python, eux, doivent avoir quand même réussi malgré l'échec du cache HuggingFace.
  assert.equal(readFileSync(join(newDir, 'ollama-models', 'model.gguf'), 'utf8'), 'poids ollama')
  assert.equal(readFileSync(join(newDir, 'python-runtime', 'python.exe'), 'utf8'), 'binaire python')
  assert.ok(lstatSync(join(userProfile, '.ollama', 'models')).isSymbolicLink(), 'Ollama doit être redirigé même si le cache HuggingFace a échoué')

  rmSync(root, { recursive: true, force: true })
})

test("rien à copier (première installation, rien encore téléchargé) n'empêche pas de poser la jonction", async () => {
  const { root, userProfile, localAppData } = setupFakeHome()
  const { moveModelsLocation } = loadModelsLocation({ USERPROFILE: userProfile, LOCALAPPDATA: localAppData })
  // Aucun des 3 dossiers sources n'existe : cas d'un déplacement fait AVANT le premier téléchargement.

  const newDir = join(root, 'D-disque', 'jaris-data')
  const result = await moveModelsLocation(newDir, () => {})

  assert.equal(result.success, true, `attendu un succès même sans rien à copier, reçu : ${JSON.stringify(result)}`)
  assert.ok(lstatSync(join(userProfile, '.ollama', 'models')).isSymbolicLink(), 'la jonction doit être posée même sans données préexistantes')
  assert.ok(existsSync(join(newDir, 'ollama-models')), 'le dossier de destination doit exister, prêt à recevoir le premier modèle téléchargé')

  rmSync(root, { recursive: true, force: true })
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
