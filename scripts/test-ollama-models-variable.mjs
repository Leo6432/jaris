import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
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
const { decideModelsVariable, alignOllamaModelsVariable, countOllamaModels, samePath, repairOllamaModelsView } = mod.exports

const HOME_MODELS = 'C:\\Users\\leo\\.ollama\\models'
const JARIS = 'D:\\jaris\\ollama-models'

/**
 * Faux Windows : variables, dossier de Jaris, chemins réels (jonctions) et nombre de modèles par dossier. Comme sur la
 * machine de Léo, l'emplacement habituel est une jonction vers le dossier de Jaris, et un dossier existant a pour
 * chemin réel lui-même ; `real` complète ou remplace ces chemins réels.
 */
function fakeWindows({ user = null, machine = null, jaris = JARIS, defaultDir = HOME_MODELS, real = {}, counts = {}, writeError = null } = {}) {
  const realPaths = { [defaultDir]: jaris, [jaris]: jaris, ...real }
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
      realPath: async (p) => realPaths[p] ?? null,
      countModels: async (dir) => counts[dir] ?? 0,
      defaultModelsDir: () => defaultDir
    }
  }
}
const LEO = { user: 'D:\\ollama-models', counts: { 'D:\\ollama-models': 0, 'D:\\jaris\\ollama-models': 7 } }

test('la machine de Léo : la variable désigne un dossier vide, celui de Jaris a les modèles -> à corriger', async () => {
  assert.deepEqual(await decideModelsVariable(fakeWindows(LEO).deps), {
    action: 'fix', from: 'D:\\ollama-models', to: 'D:\\jaris\\ollama-models', fromCount: 0, toCount: 7
  })
})

test('rien à corriger : pas de jonction, même dossier (casse, barre finale), ou dossier choisi mieux rempli', async () => {
  // Modèles rangés à l'emplacement habituel, sans jonction : rien à faire.
  assert.deepEqual(await decideModelsVariable(fakeWindows({ jaris: HOME_MODELS }).deps), { action: 'none', current: null })
  // Compté à 0 pour la variable : seule la reconnaissance du MÊME dossier évite une « correction ».
  assert.equal((await decideModelsVariable(fakeWindows({ user: 'd:\\JARIS\\ollama-models\\', counts: { [JARIS]: 7 } }).deps)).action, 'none')
  // Un dossier choisi par l'utilisateur et au moins aussi rempli : son choix, on n'y touche pas.
  const chosen = fakeWindows({ user: 'E:\\ia', real: { 'E:\\ia': 'E:\\ia' }, counts: { 'E:\\ia': 9, [JARIS]: 7 } })
  assert.deepEqual(await decideModelsVariable(chosen.deps), { action: 'none', current: 'E:\\ia' })
  assert.equal(samePath('D:\\a\\', 'd:\\A'), true)
})

// Étape 289 (Léo, après la mise à jour d'Ollama : « model 'qwen3.8:27b' not found » juste après un téléchargement
// « réussi », et tous les modèles « pas installés ») : Ollama 0.40+ ne relit plus un modèle à travers une jonction.
// Avant cette étape, ces deux cas comptaient comme « rien à corriger ».
test('le bon dossier, mais à travers une jonction : la variable reçoit son vrai chemin', async () => {
  // Sans variable : Ollama prend l'emplacement habituel, qui est la jonction posée par Jaris.
  assert.deepEqual(await decideModelsVariable(fakeWindows().deps), { action: 'resolve', from: HOME_MODELS, to: JARIS })
  // Variable posée sur la jonction elle-même.
  const viaJunction = fakeWindows({ user: 'C:\\Users\\minar\\.ollama\\models', real: { 'C:\\Users\\minar\\.ollama\\models': JARIS } })
  assert.deepEqual(await decideModelsVariable(viaJunction.deps), { action: 'resolve', from: 'C:\\Users\\minar\\.ollama\\models', to: JARIS })
  // Variable posée pour toute la machine : celle de l'utilisateur l'emporte, aucun droit administrateur nécessaire.
  assert.equal((await decideModelsVariable(fakeWindows({ machine: HOME_MODELS }).deps)).action, 'resolve')
})

test('jonction : réglage écrit, Ollama arrêté pour relire, et le Ollama de Jaris reçoit le vrai chemin même si l’écriture échoue', async () => {
  const before = process.env.OLLAMA_MODELS
  try {
    for (const writeError of [null, 'accès refusé']) {
      delete process.env.OLLAMA_MODELS
      const w = fakeWindows({ writeError })
      const logs = []
      let stopped = 0
      assert.equal(await alignOllamaModelsVariable((m) => logs.push(m), async () => { stopped++ }, w.deps, 'win32'), true)
      assert.deepEqual(w.writes, writeError ? [] : [JARIS])
      assert.equal(process.env.OLLAMA_MODELS, JARIS)
      assert.equal(stopped, 1)
      assert.match(logs.join('\n'), /vrai emplacement, D:\\jaris\\ollama-models, et redémarre\. Rien n'a été déplacé ni effacé/)
      if (writeError) assert.match(logs[0], /accès refusé/)
    }
  } finally {
    if (before === undefined) delete process.env.OLLAMA_MODELS
    else process.env.OLLAMA_MODELS = before
  }
})

test('une variable vers un dossier disparu (déplacé, effacé) revient au dossier de Jaris, même sans modèles', async () => {
  // Sinon Ollama recréerait ce dossier vide et y rangerait les prochains modèles, invisibles au reste.
  const gone = fakeWindows({ user: 'E:\\ancien\\ollama-models' })
  assert.deepEqual(await decideModelsVariable(gone.deps), { action: 'fix', from: 'E:\\ancien\\ollama-models', to: JARIS, fromCount: 0, toCount: 0 })
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
    await alignOllamaModelsVariable(() => {}, async () => { stopped++ }, fakeWindows({ jaris: HOME_MODELS }).deps, 'win32')
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
  // Étape 289 : depuis Ollama 0.40, un modèle téléchargé n'a son manifeste QUE dans manifests-v2 (un lien vers son
  // blob hors Windows). Sans le compter, un dossier bien rempli passerait pour vide.
  mkdirSync(join(dir, 'manifests-v2', 'ollama.com', 'library', 'qwen3.8'), { recursive: true })
  writeFileSync(join(dir, 'manifests-v2', 'ollama.com', 'library', 'qwen3.8', '27b'), '{}')
  mkdirSync(join(dir, 'manifests-v2', 'ollama.com', 'library', 'qwen3.5'), { recursive: true })
  symlinkSync(join(dir, 'blobs', 'sha256-abc'), join(dir, 'manifests-v2', 'ollama.com', 'library', 'qwen3.5', '9b'))
  assert.equal(await countOllamaModels(dir), 4)
})

/** Faux Ollama pour la vérification « voit-il les modèles ? » : `seen` = modèles annoncés, avant puis après relance. */
function fakeOllama({ onDisk = 7, seen = [0, 7], dir = JARIS } = {}) {
  const calls = { restarts: 0 }
  const answers = [...seen]
  return {
    calls,
    deps: {
      modelsDir: async () => dir,
      countModels: async () => onDisk,
      serverModelCount: async () => (answers.length > 1 ? answers.shift() : answers[0]),
      restartOllama: async () => {
        calls.restarts++
      }
    }
  }
}
let clock = 0
/** Chaque essai à plus d'une minute du précédent : la limite d'une réparation par minute ne s'en mêle pas. */
const later = () => (clock += 120_000)

test('Ollama ne voit aucun modèle alors que le disque en a : relancé avec le vrai dossier, et il les revoit', async () => {
  const before = process.env.OLLAMA_MODELS
  try {
    const o = fakeOllama()
    const logs = []
    assert.equal(await repairOllamaModelsView((m) => logs.push(m), o.deps, 'win32', later()), true)
    assert.equal(o.calls.restarts, 1)
    assert.equal(process.env.OLLAMA_MODELS, JARIS)
    assert.match(logs[0], /aucun de tes 7 modèles, pourtant bien rangés dans D:\\jaris\\ollama-models/)
    assert.match(logs[1], /voit de nouveau tes modèles \(7\)/)
  } finally {
    if (before === undefined) delete process.env.OLLAMA_MODELS
    else process.env.OLLAMA_MODELS = before
  }
})

test('rien à réparer : Ollama voit des modèles, le disque est vide, Ollama ne répond pas, ou hors Windows', async () => {
  for (const o of [fakeOllama({ seen: [3] }), fakeOllama({ onDisk: 0 }), fakeOllama({ seen: [null] }), fakeOllama({ dir: null })]) {
    assert.equal(await repairOllamaModelsView(() => assert.fail('aucun message attendu'), o.deps, 'win32', later()), false)
    assert.equal(o.calls.restarts, 0)
  }
  const linux = fakeOllama()
  assert.equal(await repairOllamaModelsView(() => {}, linux.deps, 'linux', later()), false)
  assert.equal(linux.calls.restarts, 0)
})

test('toujours rien après relance : la vraie situation est dite, et jamais deux relances dans la même minute', async () => {
  const before = process.env.OLLAMA_MODELS
  try {
    const o = fakeOllama({ seen: [0, 0] })
    const logs = []
    const at = later()
    assert.equal(await repairOllamaModelsView((m) => logs.push(m), o.deps, 'win32', at), false)
    assert.match(logs.at(-1), /ne voit toujours pas tes modèles, rangés dans D:\\jaris\\ollama-models\. Redémarre l'ordinateur/)
    assert.equal(await repairOllamaModelsView(() => {}, o.deps, 'win32', at + 30_000), false)
    assert.equal(o.calls.restarts, 1, 'une seconde relance moins d’une minute après')
    // Deux demandes en même temps (le démarrage et un téléchargement) : une seule relance, et le téléchargement
    // ATTEND son résultat — sinon il repartirait aussitôt sur un Ollama encore aveugle.
    const twice = fakeOllama()
    const now = later()
    const results = await Promise.all([repairOllamaModelsView(() => {}, twice.deps, 'win32', now), repairOllamaModelsView(() => {}, twice.deps, 'win32', now)])
    assert.deepEqual(results, [true, true])
    assert.equal(twice.calls.restarts, 1)
  } finally {
    if (before === undefined) delete process.env.OLLAMA_MODELS
    else process.env.OLLAMA_MODELS = before
  }
})

test('branché : au démarrage après Ollama, et avant de retélécharger un modèle « absent »', () => {
  const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8')
  const start = main.slice(main.indexOf('async function startVoicePipeline'))
  assert.match(start, /setModelsViewRepair\(repairModelsView\)/)
  assert.match(start, /ensureOllamaRunning\(log\)\.then\(repairModelsView\)/)
  const ollama = readFileSync(new URL('../electron/services/ollama.ts', import.meta.url), 'utf8')
  const pull = ollama.slice(ollama.indexOf('export async function pullModelIfMissing'))
  assert.ok(pull.indexOf('modelsViewRepair()') > -1 && pull.indexOf('modelsViewRepair()') < pull.indexOf('pullWithOllama('), 'la réparation doit passer avant le téléchargement')
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
