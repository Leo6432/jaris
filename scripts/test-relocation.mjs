import { withI18n } from './i18n-test-module.mjs'
import { loadTsModule } from './load-ts-module.mjs'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const nodeRequire = createRequire(import.meta.url)
const formatBytesModule = loadTsModule('shared/formatBytes.ts')
const codeConversationsModule = loadTsModule('shared/codeConversations.ts')
const conversationsDataModule = loadTsModule('shared/conversationsData.ts')
const atomicFileModule = loadTsModule('electron/services/atomicFile.ts', { fs: nodeRequire('fs'), 'fs/promises': nodeRequire('fs/promises'), path: nodeRequire('path') })

/**
 * relocation.ts — étape 143, Léo : « si il veut changer dans les options ça doit tout déplacer, jamais une
 * partie ». Le vrai enchaînement (storageRoot, dataLocation, modelsLocation RÉELS sur un vrai dossier
 * temporaire) ; seuls Docker, le téléchargement et `mklink` sont simulés. Vérifie que chaque refus ou échec
 * laisse la machine EXACTEMENT comme avant, et qu'un succès emporte tout.
 */
function transpile(path) {
  return ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
}

function setup({ dockerPlan = { action: 'none' }, dockerUninstallOk = true, dockerInstallOk = true, onDockerUninstall = null } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'jaris-relocation-'))
  const env = { USERPROFILE: join(base, 'user'), LOCALAPPDATA: join(base, 'local'), SystemDrive: 'C:' }
  const userData = join(base, 'roaming', 'Jaris')
  mkdirSync(userData, { recursive: true })
  writeFileSync(join(userData, 'profile.json'), '{"name":"Léo"}')
  mkdirSync(join(env.USERPROFILE, '.ollama', 'models'), { recursive: true })
  writeFileSync(join(env.USERPROFILE, '.ollama', 'models', 'poids'), 'modèle')
  mkdirSync(join(env.LOCALAPPDATA, 'Programs', 'Ollama'), { recursive: true })
  writeFileSync(join(env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe'), 'programme')

  const paths = { userData, exe: join(base, 'app', 'Jaris') }
  const app = { isPackaged: false, getPath: (n) => paths[n], setPath: (n, v) => (paths[n] = v), getVersion: () => '0.15.53' }
  const platform = { value: 'win32' }
  const fakeProcess = { get platform() { return platform.value }, env }
  const spawn = (_cmd, args) => {
    const emitter = new EventEmitter()
    emitter.stderr = new EventEmitter()
    queueMicrotask(() => {
      nodeRequire('fs').symlinkSync(args[4], args[3], process.platform === 'win32' ? 'junction' : undefined)
      emitter.emit('close', 0)
    })
    return emitter
  }
  const calls = { dockerUninstall: 0, dockerInstall: [] }
  const load = (path, modules) => {
    const exports = {}
    vm.runInThisContext(`(function (exports, module, require, process) { ${transpile(path)} })`)(
      exports,
      { exports },
      // Étape 293 : relocation.ts écrit les tailles avec le VRAI formatBytes partagé (unités traduites).
      withI18n((name) => modules[name] ?? (name === '../../shared/formatBytes' ? formatBytesModule : nodeRequire(name))),
      fakeProcess
    )
    return exports
  }
  const storageRoot = load('../electron/services/storageRoot.ts', {
    electron: { app },
    '../../shared/codeConversations': codeConversationsModule,
    '../../shared/conversationsData': conversationsDataModule,
    './atomicFile': atomicFileModule
  })
  const dataLocation = load('../electron/services/dataLocation.ts', { electron: { app }, './storageRoot': storageRoot })
  const modelsLocation = load('../electron/services/modelsLocation.ts', { child_process: { spawn } })
  const dockerLocation = {
    DOCKER_APP_SUBDIR: 'docker',
    DOCKER_DATA_SUBDIR: 'docker-data',
    // Même règle que le vrai isInside : séparateur du système (\\ sous Windows, où tourne la CI).
    isInside: (c, p) => {
      const rel = nodeRequire('path').relative(p, c)
      return rel === '' || (!rel.startsWith('..') && !nodeRequire('path').isAbsolute(rel))
    },
    planDockerMove: async () => {
      if (dockerPlan instanceof Error) throw dockerPlan
      return dockerPlan
    },
    uninstallDockerForMove: async () => {
      calls.dockerUninstall++
      // La fenêtre d'autorisation de Windows peut rester ouverte des minutes : Jaris, lui, continue d'écrire.
      onDockerUninstall?.()
      return dockerUninstallOk
    }
  }
  const relocation = load('../electron/services/relocation.ts', {
    electron: { app },
    './storageRoot': storageRoot,
    './dataLocation': dataLocation,
    './modelsLocation': modelsLocation,
    './dockerLocation': dockerLocation,
    './download': { downloadToFile: async () => 0 }
  })
  return { base, env, userData, relocation, calls, platform, dockerInstallOk }
}

const run = (t, newRoot) => t.relocation.relocateEverything(newRoot, {
  onProgress: () => {},
  startDocker: async () => {},
  installDocker: async (root) => {
    t.calls.dockerInstall.push(root)
    return t.dockerInstallOk
  }
})

function assertUntouched(t, newRoot) {
  assert.equal(readFileSync(join(t.userData, 'profile.json'), 'utf8'), '{"name":"Léo"}', 'conversations/réglages intacts')
  assert.ok(!lstatSync(join(t.env.USERPROFILE, '.ollama', 'models')).isSymbolicLink(), 'modèles non basculés')
  assert.equal(readFileSync(join(t.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe'), 'utf8'), 'programme')
  assert.ok(!existsSync(join(t.userData, 'storage-location.json')), 'aucun nouveau dossier enregistré')
  assert.ok(!existsSync(join(newRoot, 'ollama-models')) && !existsSync(join(newRoot, 'jaris-data')), 'aucune copie laissée')
}

test('succès : conversations, modèles et programme Ollama partent TOUS, et Jaris est redirigé', async () => {
  const t = setup()
  const newRoot = join(t.base, 'D', 'Jaris')
  const result = await run(t, newRoot)

  assert.equal(readFileSync(join(newRoot, 'jaris-data', 'profile.json'), 'utf8'), '{"name":"Léo"}')
  assert.ok(!existsSync(join(t.userData, 'profile.json')), 'plus rien de nos données à l’ancien endroit')
  assert.equal(readFileSync(join(newRoot, 'ollama-app', 'ollama.exe'), 'utf8'), 'programme')
  assert.ok(lstatSync(join(t.env.LOCALAPPDATA, 'Programs', 'Ollama')).isSymbolicLink())
  assert.equal(JSON.parse(readFileSync(join(t.userData, 'storage-location.json'), 'utf8')).root, newRoot)
  assert.equal(result.dockerUninstalled, false)
  rmSync(t.base, { recursive: true, force: true })
})

/**
 * Relecture croisée : les petites données étaient copiées AVANT la longue copie des modèles et de Python (souvent des
 * dizaines de minutes, Jaris restant ouvert). Tout ce qui était écrit dans l'ancien dossier pendant ce temps — une
 * conversation du mode Code, un jeton GitHub renouvelé — restait derrière, puis était effacé avec lui.
 */
const isDataCopyMessage = (message) => message.includes('conversations et réglages')

test('les conversations et réglages sont copiés APRÈS les modèles : ce qui est écrit pendant la longue copie part aussi', async () => {
  const t = setup()
  const newRoot = join(t.base, 'D', 'Jaris')
  const messages = []
  let wroteDuringCopy = false
  await t.relocation.relocateEverything(newRoot, {
    onProgress: (message) => {
      messages.push(message)
      // Pendant la copie des modèles, Léo continue de se servir de Jaris.
      if (!wroteDuringCopy && message.startsWith('Copie') && !isDataCopyMessage(message)) {
        wroteDuringCopy = true
        writeFileSync(join(t.userData, 'code-conversations.json'), '{"version":1,"repos":[],"conversations":{}}')
        writeFileSync(join(t.userData, 'profile.json'), '{"name":"Léo","voix":"M3"}')
      }
    },
    startDocker: async () => {},
    installDocker: async () => true
  })
  assert.ok(wroteDuringCopy, 'la copie des modèles n’a pas été vue')
  const lastHeavyCopy = messages.findLastIndex((message) => message.startsWith('Copie') && !isDataCopyMessage(message))
  const firstDataCopy = messages.findIndex(isDataCopyMessage)
  assert.ok(firstDataCopy > lastHeavyCopy, `ordre des copies : ${messages.join(' | ')}`)
  assert.equal(readFileSync(join(newRoot, 'jaris-data', 'code-conversations.json'), 'utf8'), '{"version":1,"repos":[],"conversations":{}}')
  assert.equal(readFileSync(join(newRoot, 'jaris-data', 'profile.json'), 'utf8'), '{"name":"Léo","voix":"M3"}')
  rmSync(t.base, { recursive: true, force: true })
})

test('la copie des conversations échoue APRÈS celle des modèles : tout ou rien, rien n’est laissé derrière', async () => {
  const t = setup()
  const newRoot = join(t.base, 'D', 'Jaris')
  await assert.rejects(
    t.relocation.relocateEverything(newRoot, {
      onProgress: (message) => {
        // Un fichier à la place du dossier des données : sa copie, la dernière, échoue.
        const dest = join(newRoot, 'jaris-data')
        if (message.startsWith('Copie') && !isDataCopyMessage(message) && !existsSync(dest)) writeFileSync(dest, 'bloque')
      },
      startDocker: async () => {},
      installDocker: async () => true
    }),
    /copie/i
  )
  assertUntouched(t, newRoot)
  rmSync(t.base, { recursive: true, force: true })
})

/**
 * Relecture croisée : entre la copie des données et l'effacement de l'ancien dossier, il restait la désinstallation de
 * Docker (fenêtre d'autorisation de Windows, laissée ouverte autant qu'on veut), l'effacement des anciens modèles et la
 * réinstallation de Docker (plusieurs minutes). Jaris écrit toujours dans l'ancien dossier jusqu'à sa relance : un
 * message du Chat envoyé pendant ce temps était effacé avec lui.
 */
const DOCKER_ELSEWHERE = { action: 'uninstall', installDir: 'C:\\Program Files\\Docker\\Docker' }

test('ce qui est écrit pendant la désinstallation puis la réinstallation de Docker part aussi (rattrapage final)', async () => {
  let t = null
  t = setup({
    dockerPlan: DOCKER_ELSEWHERE,
    onDockerUninstall: () => {
      // Pendant la fenêtre d'autorisation : un message du Chat et un réglage modifié.
      mkdirSync(join(t.userData, 'conversations'), { recursive: true })
      writeFileSync(join(t.userData, 'conversations', 'fil-1.json'), '{"messages":["pendant l’autorisation"]}')
      writeFileSync(join(t.userData, 'profile.json'), '{"name":"Léo","voix":"M3"}')
    }
  })
  writeFileSync(join(t.userData, 'reminders.json'), '{"rappels":[1]}')
  const newRoot = join(t.base, 'D', 'Jaris')
  const result = await t.relocation.relocateEverything(newRoot, {
    onProgress: () => {},
    startDocker: async () => {},
    installDocker: async () => {
      // Pendant la réinstallation de Docker, après la bascule : encore un message.
      writeFileSync(join(t.userData, 'conversations', 'fil-2.json'), '{"messages":["pendant la réinstallation"]}')
      // Un fichier qui n'a PAS changé depuis la première copie n'est pas recopié (les vidéos ne repartent pas en
      // entier) : sa copie, marquée ici, doit rester telle quelle.
      writeFileSync(join(newRoot, 'jaris-data', 'reminders.json'), '{"rappels":[2]}')
      return true
    }
  })
  const data = join(newRoot, 'jaris-data')
  assert.equal(readFileSync(join(data, 'conversations', 'fil-1.json'), 'utf8'), '{"messages":["pendant l’autorisation"]}')
  assert.equal(readFileSync(join(data, 'conversations', 'fil-2.json'), 'utf8'), '{"messages":["pendant la réinstallation"]}')
  assert.equal(readFileSync(join(data, 'profile.json'), 'utf8'), '{"name":"Léo","voix":"M3"}')
  assert.equal(readFileSync(join(data, 'reminders.json'), 'utf8'), '{"rappels":[2]}', 'fichier inchangé recopié pour rien')
  // L'ancien dossier est bien effacé ensuite, rien ne reste à effacer à la main.
  assert.ok(!existsSync(join(t.userData, 'conversations')) && !existsSync(join(t.userData, 'profile.json')))
  assert.deepEqual(result.leftovers, [])
  rmSync(t.base, { recursive: true, force: true })
})

test('si ce rattrapage final échoue, l’ancien dossier des données n’est PAS effacé (signalé à la place)', async () => {
  let t = null
  let newRoot = null
  t = setup({
    dockerPlan: DOCKER_ELSEWHERE,
    onDockerUninstall: () => {
      mkdirSync(join(t.userData, 'conversations'), { recursive: true })
      writeFileSync(join(t.userData, 'conversations', 'fil-1.json'), '{"messages":["dernier message"]}')
      // Un fichier à la place du dossier de destination : la recopie de ce dossier échoue.
      writeFileSync(join(newRoot, 'jaris-data', 'conversations'), 'bloque')
    }
  })
  newRoot = join(t.base, 'D', 'Jaris')
  const result = await run(t, newRoot)
  // La bascule était faite : le déplacement réussit, mais rien de l'ancien dossier n'est perdu.
  assert.equal(JSON.parse(readFileSync(join(t.userData, 'storage-location.json'), 'utf8')).root, newRoot)
  assert.equal(readFileSync(join(t.userData, 'conversations', 'fil-1.json'), 'utf8'), '{"messages":["dernier message"]}')
  assert.equal(readFileSync(join(t.userData, 'profile.json'), 'utf8'), '{"name":"Léo"}')
  assert.deepEqual(result.leftovers, ['anciennes conversations'])
  rmSync(t.base, { recursive: true, force: true })
})

test('Docker contient autre chose : refus AVANT d’avoir touché à quoi que ce soit', async () => {
  const t = setup({ dockerPlan: new Error("Docker Desktop contient d'autres projets") })
  const newRoot = join(t.base, 'D', 'Jaris')
  await assert.rejects(run(t, newRoot), /autres projets/)
  assertUntouched(t, newRoot)
  assert.equal(t.calls.dockerUninstall, 0)
  rmSync(t.base, { recursive: true, force: true })
})

test('désinstallation de Docker refusée (autorisation Windows) : TOUT est remis comme avant', async () => {
  const t = setup({ dockerPlan: { action: 'uninstall', installDir: 'C:\\Program Files\\Docker\\Docker' }, dockerUninstallOk: false })
  const newRoot = join(t.base, 'D', 'Jaris')
  await assert.rejects(run(t, newRoot), /remis comme avant/)
  assertUntouched(t, newRoot)
  assert.equal(t.calls.dockerUninstall, 1)
  rmSync(t.base, { recursive: true, force: true })
})

test('Docker installé ailleurs et ne contenant que Jaris : désinstallé, pour être réinstallé dans le dossier', async () => {
  const t = setup({ dockerPlan: { action: 'uninstall', installDir: 'C:\\Program Files\\Docker\\Docker' } })
  const newRoot = join(t.base, 'D', 'Jaris')
  const result = await run(t, newRoot)
  assert.equal(result.dockerUninstalled, true)
  assert.equal(result.dockerReinstalled, true)
  assert.deepEqual(t.calls.dockerInstall, [newRoot])
  assert.equal(JSON.parse(readFileSync(join(t.userData, 'storage-location.json'), 'utf8')).root, newRoot)
  rmSync(t.base, { recursive: true, force: true })
})

test('si Docker refuse sa réinstallation, le résultat ne prétend pas que tout a été déplacé', async () => {
  const t = setup({ dockerPlan: { action: 'uninstall', installDir: 'C:\\Program Files\\Docker\\Docker' }, dockerInstallOk: false })
  const newRoot = join(t.base, 'D', 'Jaris')
  const result = await run(t, newRoot)
  assert.equal(result.dockerUninstalled, true)
  assert.equal(result.dockerReinstalled, false)
  assert.deepEqual(t.calls.dockerInstall, [newRoot])
  rmSync(t.base, { recursive: true, force: true })
})

test('un dossier DANS un dossier déjà utilisé par Jaris est refusé (copie dans soi-même, ou effacé par une mise à jour)', async () => {
  const t = setup()
  const inside = join(t.env.USERPROFILE, '.ollama', 'models', 'ici')
  await assert.rejects(run(t, inside), /Choisis un dossier en dehors/)
  assertUntouched(t, inside)
  rmSync(t.base, { recursive: true, force: true })
})

test('les arguments de réinstallation du programme : silencieux, relancé, et /D= en dernier, sans guillemets', () => {
  const t = setup()
  assert.equal(t.relocation.programMoveCommandLine('D:\\Mes Jeux\\Jaris'), '/S --updated --force-run /D=D:\\Mes Jeux\\Jaris')
  assert.equal(t.relocation.installerUrlForVersion('0.15.53'), 'https://github.com/Leo6432/jaris/releases/download/v0.15.53/Jaris-Setup-0.15.53.exe')
  rmSync(t.base, { recursive: true, force: true })
})

test('hors Windows : refus net, rien n’est touché (les chemins Windows y seraient vides)', async () => {
  const t = setup()
  const newRoot = join(t.base, 'D', 'Jaris')
  t.platform.value = 'linux'
  await assert.rejects(run(t, newRoot), /que sur Windows/)
  assertUntouched(t, newRoot)
  rmSync(t.base, { recursive: true, force: true })
})
