import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { promisify } from 'node:util'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * Étape 167 : qwen2.5-coder:14b faisait partie des modèles de Jaris mais manquait dans la copie des listes du
 * script de test (benchmark-models.mjs ne peut pas importer hardwareScan.ts) — il n'a donc jamais été testé
 * lors de l'analyse de Léo du 25/09/2026, sans que rien ne le signale. Ce test vérifie que les deux copies
 * restent alignées : tout modèle de Jaris est testable par le script, avec la même règle de débordement RAM.
 */
const nodeRequire = createRequire(import.meta.url)
const hardwareScanSource = readFileSync(new URL('../electron/services/hardwareScan.ts', import.meta.url), 'utf8')
const script = readFileSync(new URL('./benchmark-models.mjs', import.meta.url), 'utf8')

async function jarisModels() {
  const source = ts.transpileModule(hardwareScanSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const exec = (_c, o, cb) => (typeof o === 'function' ? o : cb)(null, 'GPU, 8192\n', '')
  exec[promisify.custom] = () => Promise.resolve({ stdout: 'GPU, 8192\n', stderr: '' })
  const modules = {
    child_process: { exec },
    fs: { readFileSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) } },
    '../paths': { resourcesRoot: () => '/fake' },
    './systemResources': { RESOURCE_SAFETY_MARGIN_GB: 16, detectRamGb: () => 32 },
    './ollama': { getModelInfo: async () => null, getInstalledModelSizeBytes: async () => null, listInstalledModels: async () => [] }
  }
  const exports = {}
  vm.runInNewContext(source, { exports, module: { exports }, require: (n) => modules[n] ?? nodeRequire(n) })
  // Tableau recopié dans ce realm : vm.runInNewContext a ses propres prototypes (deepEqual échouerait sinon).
  return [...(await exports.getModelOverview()).entries].map((e) => String(e.model))
}

function setLiteral(source, name) {
  const match = new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`).exec(source)
  assert.ok(match, `${name} introuvable`)
  const withoutComments = match[1].replace(/\/\/.*$/gm, '')
  return new Set([...withoutComments.matchAll(/'([^']+)'/g)].map((m) => m[1]))
}

test('chaque modèle de Jaris figure dans le script de test', async () => {
  const models = await jarisModels()
  assert.ok(models.length >= 40)
  const missing = models.filter((m) => !script.includes(`'${m}'`))
  assert.deepEqual(missing, [], `modèles jamais testables par benchmark-models.mjs : ${missing.join(', ')}`)
})

test('même règle de débordement sur la RAM des deux côtés', () => {
  assert.deepEqual(
    [...setLiteral(script, 'RAM_OFFLOAD_MODELS')].sort(),
    [...setLiteral(hardwareScanSource, 'LARGE_RAM_OFFLOAD_MODELS')].sort()
  )
})

/**
 * Étape 230 : le test ci-dessus ne vérifiait que la présence du NOM quelque part dans le script — gemma4:26b et
 * qwen3.8:27b, candidats Vision de Jaris, n'étaient que dans la liste de conversation du script et n'avaient donc
 * jamais passé le test de vision. Chaque liste de Jaris est maintenant comparée à SA liste dans le script.
 */
function candidateList(source, name) {
  const match = new RegExp(`const ${name}(?:: ModelCandidate\\[\\])? = \\[([\\s\\S]*?)\\n\\]`).exec(source)
  assert.ok(match, `${name} introuvable`)
  return new Set([...match[1].replace(/\/\/.*$/gm, '').matchAll(/model: '([^']+)'/g)].map((m) => m[1]))
}

function stringList(source, name) {
  const match = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\n\\]`).exec(source)
  assert.ok(match, `${name} introuvable`)
  return new Set([...match[1].replace(/\/\/.*$/gm, '').matchAll(/'([^']+)'/g)].map((m) => m[1]))
}

test('chaque liste de Jaris est dans la BONNE liste du script (conversation, vision, code)', () => {
  const scriptModels = stringList(script, 'MODELS')
  for (const name of ['FLASH_CANDIDATES', 'MEDIUM_CANDIDATES', 'LARGE_CANDIDATES']) {
    const missing = [...candidateList(hardwareScanSource, name)].filter((m) => !scriptModels.has(m))
    assert.deepEqual(missing, [], `${name} : jamais testés en conversation : ${missing.join(', ')}`)
  }
  for (const name of ['VISION_CANDIDATES', 'CODE_CANDIDATES']) {
    const inScript = candidateList(script, name)
    const missing = [...candidateList(hardwareScanSource, name)].filter((m) => !inScript.has(m))
    assert.deepEqual(missing, [], `${name} : jamais testés dans leur épreuve : ${missing.join(', ')}`)
  }
})
