import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const nodeRequire = createRequire(import.meta.url)

/**
 * Curseur de longueur de contexte (Options -> Modèles), demande de Léo devant une capture de l'app Ollama :
 * "jaris voit les model et regarde la vram et propose une barre comme sur ollama mais qui est personnaliser
 * a chacun pour que le dernier ne dépasse pas la vram". Contrairement au curseur d'Ollama (4k à 256k fixe
 * pour tout le monde), le MAXIMUM ici est calculé pour la VRAM libre réelle et le modèle du palier Puissant
 * (le plus gros modèle de conversation, donc celui qui laisse le moins de marge pour le cache K/V).
 *
 * Chargé dans le realm COURANT (`runInThisContext`), pas `runInNewContext` : ce test compare de vrais objets
 * avec `assert.deepEqual`, et `vm.runInNewContext` leur donnerait des prototypes différents — piège déjà
 * documenté dans ce dépôt (voir test-ollama-update-progress.mjs, même technique reprise ici).
 */
function loadHardwareScan({ freeVramMib, tempC = 40, modelInfo, sizeBytes }) {
  const source = ts.transpileModule(readFileSync(new URL('../electron/services/hardwareScan.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText

  // Voir le même piège déjà documenté ailleurs dans ce dépôt : exec = promisify(exec) a besoin de la marque
  // [util.promisify.custom] pour résoudre vers {stdout, stderr}, sinon getLiveGpuStatus() retombe
  // silencieusement sur freeVramGb: null en ignorant la valeur simulée.
  const exec = (_cmd, opts, cb) => {
    const callback = typeof opts === 'function' ? opts : cb
    callback(null, `${freeVramMib}, ${tempC}\n`, '')
  }
  exec[promisify.custom] = () => Promise.resolve({ stdout: `${freeVramMib}, ${tempC}\n`, stderr: '' })

  const modules = {
    child_process: { exec },
    fs: {
      readFileSync: () => {
        const err = new Error('ENOENT')
        err.code = 'ENOENT'
        throw err
      }
    },
    '../paths': { resourcesRoot: () => '/fake/resources' },
    './systemResources': { RESOURCE_SAFETY_MARGIN_GB: 4, detectRamGb: () => 32 },
    './ollama': {
      getModelInfo: async () => modelInfo ?? null,
      getInstalledModelSizeBytes: async () => sizeBytes ?? null
    }
  }
  const exports = {}
  vm.runInThisContext(`(function (exports, module, require) { ${source} })`)(exports, { exports }, (name) => modules[name] ?? nodeRequire(name))
  return exports
}

// Config "8B-like" réaliste (32 couches, 32 têtes, 8 têtes K/V, 4096 de dimension) — proche d'une vraie
// architecture Llama-3-8B, pas des chiffres arbitraires : sert à vérifier que le calcul donne des ordres de
// grandeur connus (8192 tokens -> exactement 1 Gio de cache K/V pour cette config, calcul fait à la main
// avant d'écrire ce test).
const ARCH_8B = { 'llama.block_count': 32, 'llama.attention.head_count': 32, 'llama.attention.head_count_kv': 8, 'llama.embedding_length': 4096, 'llama.context_length': 131072 }

test('parseModelArchInfo lit les clés par SUFFIXE, quelle que soit l’architecture', () => {
  const { parseModelArchInfo } = loadHardwareScan({ freeVramMib: 8000 })
  // Deux préfixes d'architecture différents pour le même schéma de champs : rien à maintenir à la main par
  // famille de modèle, contrairement à une liste d'architectures connues.
  const llama = parseModelArchInfo(ARCH_8B)
  const gemma = parseModelArchInfo({
    'gemma3.block_count': 32,
    'gemma3.attention.head_count': 32,
    'gemma3.attention.head_count_kv': 8,
    'gemma3.embedding_length': 4096,
    'gemma3.context_length': 131072
  })
  assert.deepEqual(llama, { blockCount: 32, headCount: 32, headCountKv: 8, embeddingLength: 4096, maxContextLength: 131072 })
  assert.deepEqual(gemma, llama)
})

test('parseModelArchInfo renvoie null si un champ manque ou si model_info est absent', () => {
  const { parseModelArchInfo } = loadHardwareScan({ freeVramMib: 8000 })
  assert.equal(parseModelArchInfo(null), null)
  const { 'llama.context_length': _omitted, ...incomplete } = ARCH_8B
  assert.equal(parseModelArchInfo(incomplete), null)
})

test('kvCacheBytesPerToken retrouve le chiffre calculé à la main pour une config 8B réaliste', () => {
  const { parseModelArchInfo, kvCacheBytesPerToken } = loadHardwareScan({ freeVramMib: 8000 })
  const arch = parseModelArchInfo(ARCH_8B)
  // 2 (K+V) x 32 couches x 8 têtes K/V x (4096/32 = 128 dim) x 2 octets (f16) = 131072 octets/token = 128 Kio.
  assert.equal(kvCacheBytesPerToken(arch), 131072)
})

test('computeMaxSafeContext retombe sur le palier attendu pour un budget VRAM connu', () => {
  const { parseModelArchInfo, computeMaxSafeContext, roundDownToContextStep } = loadHardwareScan({ freeVramMib: 8000 })
  const arch = parseModelArchInfo(ARCH_8B)
  // 8 Go libres - 0.5 Go de marge - 5 Go de poids modèle = 2.5 Go pour le cache K/V.
  // 2.5 * 1024^3 / 131072 = 20480 tokens exactement (calculé à la main avant d'écrire ce test).
  const maxTokens = computeMaxSafeContext(arch, 5, 8)
  assert.equal(maxTokens, 20480)
  assert.equal(roundDownToContextStep(maxTokens), 16384)
})

test('computeMaxSafeContext ne dépasse jamais le maximum natif du modèle, même avec toute la VRAM du monde', () => {
  const { parseModelArchInfo, computeMaxSafeContext } = loadHardwareScan({ freeVramMib: 8000 })
  const arch = parseModelArchInfo(ARCH_8B)
  assert.equal(computeMaxSafeContext(arch, 5, 100000), arch.maxContextLength)
})

test('computeMaxSafeContext renvoie 0 si le modèle seul dépasse déjà la VRAM libre', () => {
  const { parseModelArchInfo, computeMaxSafeContext } = loadHardwareScan({ freeVramMib: 8000 })
  const arch = parseModelArchInfo(ARCH_8B)
  assert.equal(computeMaxSafeContext(arch, 20, 8), 0)
})

test('roundDownToContextStep ne descend jamais sous le plancher historique de 4096', () => {
  const { roundDownToContextStep, CONTEXT_LENGTH_STEPS } = loadHardwareScan({ freeVramMib: 8000 })
  assert.equal(roundDownToContextStep(0), 4096)
  assert.equal(roundDownToContextStep(4095), 4096)
  assert.equal(roundDownToContextStep(10_000), 8192)
  assert.equal(roundDownToContextStep(300_000), CONTEXT_LENGTH_STEPS.at(-1))
})

test('computeContextLengthOptions propose un maximum plus grand quand la VRAM/le modèle sont bien identifiés', async () => {
  const { computeContextLengthOptions } = loadHardwareScan({ freeVramMib: 8000, modelInfo: ARCH_8B, sizeBytes: 5 * 1024 ** 3 })
  const result = await computeContextLengthOptions('qwen3.5:9b', 8192)
  assert.equal(result.max, 16384, `attendu 16384, reçu ${JSON.stringify(result)}`)
  assert.equal(result.current, 8192, 'la valeur déjà en usage ne doit pas bouger toute seule')
  assert.deepEqual(result.availableSteps, [4096, 8192, 16384])
})

test('computeContextLengthOptions ne propose JAMAIS plus que le palier déjà en usage sans donnée fiable', async () => {
  // Ollama injoignable (getModelInfo renvoie null) : aucune preuve que monter le curseur soit sûr.
  const { computeContextLengthOptions } = loadHardwareScan({ freeVramMib: 8000, modelInfo: null, sizeBytes: null })
  const result = await computeContextLengthOptions('qwen3.5:9b', 8192)
  assert.deepEqual(result, { current: 8192, max: 8192, availableSteps: [4096, 8192] })
})

test('computeContextLengthOptions redescend le palier actuel si la VRAM libre ne le permet plus', async () => {
  // Le curseur avait été monté à 32k lors d'un lancement précédent (plus de VRAM libre alors) ; cette
  // fois-ci, seul 16384 tient encore réellement — `current` doit suivre, jamais rester au-dessus de `max`.
  const { computeContextLengthOptions } = loadHardwareScan({ freeVramMib: 8000, modelInfo: ARCH_8B, sizeBytes: 5 * 1024 ** 3 })
  const result = await computeContextLengthOptions('qwen3.5:9b', 32768)
  assert.equal(result.max, 16384)
  assert.equal(result.current, 16384, `current ne doit jamais dépasser max, reçu ${JSON.stringify(result)}`)
})
