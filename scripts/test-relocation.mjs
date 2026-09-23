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

function setup({ dockerPlan = { action: 'none' }, dockerUninstallOk = true } = {}) {
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
  const calls = { dockerUninstall: 0 }
  const load = (path, modules) => {
    const exports = {}
    vm.runInThisContext(`(function (exports, module, require, process) { ${transpile(path)} })`)(
      exports,
      { exports },
      (name) => modules[name] ?? nodeRequire(name),
      fakeProcess
    )
    return exports
  }
  const storageRoot = load('../electron/services/storageRoot.ts', { electron: { app } })
  const dataLocation = load('../electron/services/dataLocation.ts', { electron: { app }, './storageRoot': storageRoot })
  const modelsLocation = load('../electron/services/modelsLocation.ts', { child_process: { spawn } })
  const dockerLocation = {
    DOCKER_APP_SUBDIR: 'docker',
    DOCKER_DATA_SUBDIR: 'docker-data',
    isInside: (c, p) => c === p || c.startsWith(p + '/'),
    planDockerMove: async () => {
      if (dockerPlan instanceof Error) throw dockerPlan
      return dockerPlan
    },
    uninstallDockerForMove: async () => {
      calls.dockerUninstall++
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
  return { base, env, userData, relocation, calls, platform }
}

const run = (t, newRoot) => t.relocation.relocateEverything(newRoot, { onProgress: () => {}, startDocker: async () => {} })

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
  assert.equal(JSON.parse(readFileSync(join(t.userData, 'storage-location.json'), 'utf8')).root, newRoot)
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
