import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { modelChoiceModule } from './load-model-choice.mjs'

/**
 * Étape 159 (Léo) : une application générée, puis une demande de correction → « Réponse vide d'Ollama
 * (modèle 'qwen3.6:35b-a3b' bien installé ?) ». Reproduit avec un vrai Ollama et un modèle qwen3.5 : le code
 * existant + la réflexion cachée remplissaient la fenêtre de contexte FIXE (16384) avant le premier
 * caractère de réponse (`done_reason: "length"`, 0 caractère). Ici : la fenêtre suit la taille réelle de la
 * demande, une fenêtre pleine est reconnue comme telle (plus « bien installé ? »), et une seule nouvelle
 * tentative avec une fenêtre plus grande a lieu.
 */

function transpile(path) {
  return ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
}

/** Charge un module dans le realm courant, avec ses faux imports et un `fetch` au choix. */
function load(path, modules, fetchImpl = fetch) {
  const module = { exports: {} }
  vm.runInThisContext(`(function (exports, require, module, fetch) {${transpile(path)}\n})`)(
    module.exports,
    (name) => {
      if (!(name in modules)) throw new Error(`faux import manquant : ${name}`)
      return modules[name]
    },
    module,
    fetchImpl
  )
  return module.exports
}

// ---------------------------------------------------------------------------------------------------------
// ollama.ts : une fenêtre pleine sans réponse devient ContextFullError, jamais « bien installé ? »
// ---------------------------------------------------------------------------------------------------------

function loadOllama(fetchImpl) {
  return load(
    '../electron/services/ollama.ts',
    {
      '../config': { config: { ollama: { host: 'http://ollama.test', numCtx: 8192, model: 'm' } } },
      './systemResources': { DISK_SAFETY_MARGIN_GB: 5, detectFreeDiskGb: async () => 100, getDownloadBudgetGb: async () => 100 },
      './huggingFaceImport': { importHuggingFaceModel: async () => {} }
    },
    fetchImpl
  )
}

/** Réponse NDJSON telle qu'Ollama la renvoie en streaming. */
function ndjson(chunks) {
  return new Response(chunks.map((c) => JSON.stringify(c)).join('\n') + '\n', { status: 200 })
}

// Ce qu'a renvoyé le vrai Ollama 0.34.4 avec qwen3.5:0.8b (fenêtre 2048, demande de modification) :
// uniquement de la réflexion, puis un arrêt sur « length ».
const THINKING_ONLY_THEN_LENGTH = [
  { message: { role: 'assistant', content: '', thinking: 'Je dois réécrire tout le fichier…' }, done: false },
  { message: { role: 'assistant', content: '', thinking: ' puis ajouter le bouton.' }, done: false },
  { message: { role: 'assistant', content: '' }, done: true, done_reason: 'length' }
]

test('ollama : fenêtre pleine pendant la réflexion → ContextFullError avec la taille de la fenêtre', async () => {
  const bodies = []
  const ollama = loadOllama(async (_url, init) => {
    bodies.push(JSON.parse(init.body))
    return ndjson(THINKING_ONLY_THEN_LENGTH)
  })
  await assert.rejects(
    ollama.chatWithOllama([{ role: 'user', content: 'x' }], undefined, 'qwen3.6:35b-a3b', 'high', undefined, 16384, () => {}),
    (err) => {
      assert.equal(err.name, 'ContextFullError')
      assert.match(err.message, /16384 tokens/)
      assert.doesNotMatch(err.message, /bien installé/)
      return true
    }
  )
  // Pas de second essai « sans think » : même fenêtre, même modèle, il la remplirait pareil.
  assert.equal(bodies.length, 1)
})

test('ollama : une réponse vide qui ne vient PAS d’une fenêtre pleine garde le message d’origine', async () => {
  const ollama = loadOllama(async () => ndjson([{ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' }]))
  await assert.rejects(
    ollama.chatWithOllama([{ role: 'user', content: 'x' }], undefined, 'm', 'high', undefined, 16384, () => {}),
    /Réponse vide d'Ollama/
  )
})

test('ollama : même sans streaming, une fenêtre pleine sans réponse est reconnue', async () => {
  const ollama = loadOllama(
    async () =>
      new Response(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'length' }), {
        status: 200
      })
  )
  await assert.rejects(ollama.chatWithOllama([{ role: 'user', content: 'x' }], undefined, 'm', 'medium', undefined, 8192), (err) => {
    assert.equal(err.name, 'ContextFullError')
    return true
  })
})

// ---------------------------------------------------------------------------------------------------------
// codeGenerator.ts : fenêtre calculée d'après la demande, et une nouvelle tentative plus grande
// ---------------------------------------------------------------------------------------------------------

const VALID_HTML =
  '```html\n<!DOCTYPE html>\n<html>\n<head><style>body { margin: 0; }</style></head>\n' +
  '<body><button id="go">Jouer</button><script>\n' +
  "document.getElementById('go').addEventListener('click', function () {});\n" +
  '</script></body>\n</html>\n```'

class FakeContextFullError extends Error {
  constructor(numCtx) {
    super(`Le modèle 'm' a rempli toute sa mémoire de travail (${numCtx} tokens) en réfléchissant, avant d'écrire sa réponse.`)
    this.name = 'ContextFullError'
  }
}

/**
 * `answer(numCtx, callIndex)` décide de chaque réponse simulée : une chaîne (réponse du modèle) ou `'full'`
 * (fenêtre pleine). `modelMax` : la limite que renverrait `/api/show`.
 */
function setupCodegen(answer, { modelMax = 262144 } = {}) {
  const numCtxs = []
  const statusLines = []
  const exports = load('../electron/services/codeGenerator.ts', {
    electron: { app: { getPath: () => '/tmp' } },
    './dataLocation': { getDataRoot: () => '/tmp' },
    'fs/promises': { mkdir: async () => {}, writeFile: async () => {}, readdir: async () => [], readFile: async () => '', rm: async () => {} },
    path: { join: (...parts) => parts.join('/'), isAbsolute: () => true, relative: () => '', resolve: (p) => p, sep: '/' },
    './ollama': {
      chatWithOllama: async (_messages, _tools, _model, _think, _signal, numCtx) => {
        numCtxs.push(numCtx)
        const next = answer(numCtx, numCtxs.length - 1)
        if (next === 'full') throw new FakeContextFullError(numCtx)
        if (next === undefined) throw new Error('plus de réponse simulée')
        return { role: 'assistant', content: next }
      },
      getModelInfo: async () => (modelMax === null ? null : { 'qwen35moe.context_length': modelMax, 'general.architecture': 'qwen35moe' }),
      listInstalledModels: async () => ['test-model'],
      pullModelIfMissing: async () => {},
      ModelTooLargeError: class extends Error {},
      DiskFullError: class extends Error {}
    },
    './hardwareScan': { pickBestCodeModel: async () => 'test-model' },
    './modelChoice': modelChoiceModule,
    './profileStore': { getProfile: async () => ({ codeModel: 'test-model' }) },
    '../config': { config: { ollama: { visionModel: 'v' } } },
    './vision': { IMAGE_FOR_CODE_SYSTEM_PROMPT: '', describeImage: async () => '' }
  })
  return {
    exports,
    numCtxs,
    statusLines,
    generateApp: (description, currentHtml) => exports.generateApp(description, (line) => statusLines.push(line), currentHtml)
  }
}

/** Une « vraie » application d'une taille donnée (surtout du CSS et du JavaScript, comme les vraies). */
function bigApp(chars) {
  const rule = '.bouton-jouer { background: #37e2ff; border-radius: 8px; padding: 12px 20px; }\n'
  return `<!DOCTYPE html><html><head><style>\n${rule.repeat(Math.ceil(chars / rule.length))}</style></head><body></body></html>`
}

test('nouvelle application : même fenêtre qu’avant l’étape 159 (16384), celle qui fonctionnait déjà', async () => {
  const app = setupCodegen(() => VALID_HTML)
  await app.generateApp('une todo list')
  assert.equal(app.numCtxs[0], 16384)
})

test('computeCodeNumCtx : modifier une grosse application agrandit la fenêtre pour que TOUT y tienne', () => {
  const { exports } = setupCodegen(() => undefined)
  const current = bigApp(30000)
  const messages = [
    { role: 'system', content: 'x'.repeat(6000) },
    { role: 'user', content: `Voici le fichier actuel :\n${current}\nModification demandée : corrige le score` }
  ]
  const numCtx = exports.computeCodeNumCtx(messages, current.length)
  assert.ok(numCtx > 16384, `fenêtre ${numCtx} : pas agrandie`)
  // La demande entière (au pire rythme mesuré, 2,9 caractères/token pour du CSS) + le fichier à réécrire +
  // la réflexion doivent tenir : sinon Ollama coupe la demande sans prévenir, ou la réponse avant la fin.
  const promptTokens = messages.reduce((n, m) => n + m.content.length, 0) / 2.9
  assert.ok(numCtx >= promptTokens + current.length / 2.9 + 8192, `fenêtre ${numCtx} trop petite`)
  assert.equal(numCtx % 4096, 0)
})

test('computeCodeNumCtx : jamais au-delà de la limite du modèle, ni du plafond général', () => {
  const { exports } = setupCodegen(() => undefined)
  const huge = [{ role: 'user', content: 'x'.repeat(1_000_000) }]
  assert.equal(exports.computeCodeNumCtx(huge, 1_000_000, 32768), 32768)
  assert.equal(exports.computeCodeNumCtx(huge, 1_000_000, null), 65536)
  // Un modèle qui annonce moins que le plancher : le plancher reste (comportement d'avant l'étape 159).
  assert.equal(exports.computeCodeNumCtx([{ role: 'user', content: 'x' }], 10, 8192), 16384)
})

test('modification : la fenêtre envoyée à Ollama suit la taille de l’application existante', async () => {
  const app = setupCodegen(() => VALID_HTML)
  await app.generateApp('corrige le score', bigApp(30000))
  assert.ok(app.numCtxs[0] > 16384, `fenêtre ${app.numCtxs[0]} pour une application de 30 000 caractères`)
})

test('fenêtre pleine malgré tout : UNE nouvelle tentative avec le double, qui aboutit', async () => {
  const app = setupCodegen((_numCtx, i) => (i === 0 ? 'full' : VALID_HTML))
  const result = await app.generateApp('corrige le score', bigApp(30000))
  assert.match(result.html, /<!DOCTYPE html>/)
  assert.ok(app.numCtxs[1] > app.numCtxs[0])
  assert.equal(app.numCtxs[1], Math.min(app.numCtxs[0] * 2, 65536))
  assert.ok(app.statusLines.some((line) => /mémoire de travail/.test(line)))
})

test('fenêtre pleine deux fois : message clair qui dit quoi faire, jamais « bien installé ? »', async () => {
  const app = setupCodegen(() => 'full')
  await assert.rejects(app.generateApp('corrige le score', bigApp(30000)), (err) => {
    assert.match(err.message, /mémoire de travail/)
    assert.match(err.message, /changement plus petit|nouvelle application/)
    assert.doesNotMatch(err.message, /bien installé/)
    return true
  })
  assert.equal(app.numCtxs.length, 2)
})

test('déjà à la limite du modèle : pas de nouvelle tentative inutile', async () => {
  const app = setupCodegen(() => 'full', { modelMax: 16384 })
  await assert.rejects(app.generateApp('corrige le score', bigApp(30000)), /mémoire de travail/)
  assert.equal(app.numCtxs.length, 1)
  assert.equal(app.numCtxs[0], 16384)
})

test('limite du modèle inconnue (/api/show indisponible) : plafond général, et la génération marche', async () => {
  const app = setupCodegen(() => VALID_HTML, { modelMax: null })
  const result = await app.generateApp('une todo list')
  assert.match(result.html, /<!DOCTYPE html>/)
  assert.ok(app.numCtxs.every((n) => n >= 16384 && n <= 65536))
})
