import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * Étape 254 : sur la machine de Léo, la variable Windows OLLAMA_MODELS (D:\ollama-models) désignait un autre dossier
 * que celui de Jaris (D:\jaris\ollama-models, 36,3 Go) : `ollama list` vide, tous les modèles « pas installés ».
 */
const nodeRequire = createRequire(import.meta.url)
const source = ts.transpileModule(readFileSync(new URL('../electron/services/ollamaModelsVariable.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const mod = { exports: {} }
vm.runInThisContext(`(function (exports, require, module) {\n${source}\n})`)(
  mod.exports,
  (name) => (name === './modelsLocation' ? { currentRealDir: async () => null } : nodeRequire(name)),
  mod
)
const { decideModelsVariable, alignOllamaModelsVariable, countOllamaModels, samePath } = mod.exports

/** Faux Windows : variables, dossier de Jaris, chemins réels (jonctions) et nombre de modèles par dossier. */
function fakeWindows({ user = null, machine = null, jaris = 'D:\\jaris\\ollama-models', real = {}, counts = {}, writeError = null } = {}) {
  const writes = []
  return {
    writes,
    deps: {
      readVar: async (scope) => (scope === 'User' ? user : machine),
      writeUserVar: async (value) => {
        if (writeError) throw new Error(writeError)
        writes.push(value)
      },
      jarisModelsDir: async () => jaris,
      realPath: async (p) => real[p] ?? null,
      countModels: async (dir) => counts[dir] ?? 0
    }
  }
}
const LEO = { user: 'D:\\ollama-models', counts: { 'D:\\ollama-models': 0, 'D:\\jaris\\ollama-models': 7 } }

test('la machine de Léo : la variable désigne un dossier vide, celui de Jaris a les modèles -> à corriger', async () => {
  assert.deepEqual(await decideModelsVariable(fakeWindows(LEO).deps), {
    action: 'fix', from: 'D:\\ollama-models', to: 'D:\\jaris\\ollama-models', fromCount: 0, toCount: 7
  })
})

test('rien à corriger : pas de variable, même dossier (casse, barre finale, jonction), ou dossier choisi mieux rempli', async () => {
  assert.deepEqual(await decideModelsVariable(fakeWindows().deps), { action: 'none', current: null })
  // Compté à 0 pour la variable : seule la reconnaissance du MÊME dossier évite une « correction ».
  assert.equal((await decideModelsVariable(fakeWindows({ user: 'd:\\JARIS\\ollama-models\\', counts: { 'D:\\jaris\\ollama-models': 7 } }).deps)).action, 'none')
  const viaJunction = fakeWindows({ user: 'C:\\Users\\minar\\.ollama\\models', real: { 'C:\\Users\\minar\\.ollama\\models': 'D:\\jaris\\ollama-models' } })
  assert.equal((await decideModelsVariable(viaJunction.deps)).action, 'none')
  // Un dossier choisi par l'utilisateur et au moins aussi rempli : son choix, on n'y touche pas.
  const chosen = fakeWindows({ user: 'E:\\ia', counts: { 'E:\\ia': 9, 'D:\\jaris\\ollama-models': 7 } })
  assert.deepEqual(await decideModelsVariable(chosen.deps), { action: 'none', current: 'E:\\ia' })
  assert.equal(samePath('D:\\a\\', 'd:\\A'), true)
})

test('variable posée pour toute la machine : on prévient, sans rien changer (droits administrateur)', async () => {
  const w = fakeWindows({ machine: 'D:\\ollama-models', counts: LEO.counts })
  assert.equal((await decideModelsVariable(w.deps)).action, 'warn-machine')
  const logs = []
  let stopped = 0
  assert.equal(await alignOllamaModelsVariable((m) => logs.push(m), async () => { stopped++ }, w.deps, 'win32'), false)
  assert.deepEqual(w.writes, [])
  assert.equal(stopped, 0)
  assert.match(logs[0], /droits administrateur.*D:\\jaris\\ollama-models/)
})

test('correction : la variable pointe vers le dossier de Jaris, Jaris suit, Ollama est arrêté pour relire', async () => {
  const before = process.env.OLLAMA_MODELS
  try {
    const w = fakeWindows(LEO)
    const logs = []
    let stopped = 0
    assert.equal(await alignOllamaModelsVariable((m) => logs.push(m), async () => { stopped++ }, w.deps, 'win32'), true)
    assert.deepEqual(w.writes, ['D:\\jaris\\ollama-models'])
    assert.equal(process.env.OLLAMA_MODELS, 'D:\\jaris\\ollama-models', 'le Ollama que Jaris démarre reçoit la bonne valeur')
    assert.equal(stopped, 1)
    assert.match(logs[0], /D:\\ollama-models \(0 modèle\(s\) là-bas, 7 dans D:\\jaris\\ollama-models\).*Rien n'a été effacé/)
  } finally {
    if (before === undefined) delete process.env.OLLAMA_MODELS
    else process.env.OLLAMA_MODELS = before
  }
})

test('réglage déjà corrigé à la main pendant que Jaris tournait : Jaris reprend la vraie valeur, sans rien arrêter', async () => {
  const before = process.env.OLLAMA_MODELS
  try {
    process.env.OLLAMA_MODELS = 'D:\\ollama-models' // hérité au lancement de Jaris
    let stopped = 0
    await alignOllamaModelsVariable(() => {}, async () => { stopped++ }, fakeWindows().deps, 'win32')
    assert.equal(process.env.OLLAMA_MODELS, undefined)
    assert.equal(stopped, 0)
  } finally {
    if (before === undefined) delete process.env.OLLAMA_MODELS
    else process.env.OLLAMA_MODELS = before
  }
})

test('écriture refusée : la vraie raison est dite, rien n’est arrêté ; hors Windows : rien du tout', async () => {
  const w = fakeWindows({ ...LEO, writeError: 'accès refusé' })
  const logs = []
  let stopped = 0
  assert.equal(await alignOllamaModelsVariable((m) => logs.push(m), async () => { stopped++ }, w.deps, 'win32'), false)
  assert.match(logs[0], /n'a pas pu corriger le réglage : accès refusé/)
  assert.equal(stopped, 0)
  assert.equal(await alignOllamaModelsVariable(() => assert.fail(), async () => assert.fail(), fakeWindows(LEO).deps, 'linux'), false)
})

test('compte des modèles : un fichier de manifeste par modèle, sur un vrai dossier', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jaris-ollama-'))
  mkdirSync(join(dir, 'manifests', 'registry.ollama.ai', 'library', 'granite4.2'), { recursive: true })
  mkdirSync(join(dir, 'manifests', 'hf.co', 'mradermacher', 'MAI-UI-8B-GGUF'), { recursive: true })
  mkdirSync(join(dir, 'blobs'), { recursive: true })
  writeFileSync(join(dir, 'manifests', 'registry.ollama.ai', 'library', 'granite4.2', '8b'), '{}')
  writeFileSync(join(dir, 'manifests', 'hf.co', 'mradermacher', 'MAI-UI-8B-GGUF', 'Q4_K_M'), '{}')
  writeFileSync(join(dir, 'blobs', 'sha256-abc'), 'x')
  assert.equal(await countOllamaModels(dir), 2, 'les blobs ne comptent pas')
  assert.equal(await countOllamaModels(join(dir, 'absent')), 0)
})

test('au démarrage, la correction passe AVANT le lancement d’Ollama', () => {
  const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8')
  const start = main.slice(main.indexOf('async function startVoicePipeline'))
  const align = start.indexOf('await alignOllamaModelsVariable(log, stopOllamaCompletely)')
  assert.ok(align > -1 && align < start.indexOf('ensureOllamaRunning(log)'))
})

test('lecture réelle de la variable sous Windows (CI Windows)', { skip: process.platform === 'win32' ? false : 'Windows seulement (vérifié par la CI)' }, async () => {
  const value = await mod.exports.windowsModelsVariableDeps.readVar('User')
  assert.ok(value === null || typeof value === 'string')
})
