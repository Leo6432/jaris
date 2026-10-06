import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { modelChoiceModule } from './load-model-choice.mjs'
import { systemPromptModule } from './load-system-prompt.mjs'

/**
 * Étape 245 (Léo : « ouvre Firefox et cherche une recette de tiramisu » → 2 minutes avant Firefox, puis plus rien
 * de visible) : chaque demande laisse dans un fichier texte ses étapes, le temps écoulé, et pour chaque appel au
 * modèle où Ollama a passé ce temps (chargement, lecture, écriture). Ces tests passent par la VRAIE boucle
 * converse() et écrivent pour de vrai dans un dossier temporaire — pas un faux journal.
 */
const nodeRequire = createRequire(import.meta.url)
const transpile = (path) =>
  ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText

function load(path, modules = {}, extra = {}) {
  const module = { exports: {} }
  const names = Object.keys(extra)
  vm.runInThisContext(`(function (exports, require, module${names.map((n) => `, ${n}`).join('')}) {\n${transpile(path)}\n})`)(
    module.exports,
    (name) => modules[name] ?? nodeRequire(name),
    module,
    ...names.map((n) => extra[n])
  )
  return module.exports
}

function journalModule() {
  const root = mkdtempSync(join(tmpdir(), 'jaris-journal-'))
  const journal = load('electron/services/requestJournal.ts', { './dataLocation': { getDataRoot: () => root } })
  return { journal, path: join(root, 'journal-demandes.txt') }
}

function converseWith(journal, chat, execute) {
  const config = { ollama: { model: 'granite4.2:8b', visionModel: 'vision', numCtx: 8192 } }
  return load('electron/services/assistant.ts', {
    '../config': { config },
    './ollama': { chatWithOllama: chat, listInstalledModels: async () => ['granite4.2:8b'], getModelThinking: async () => null },
    './systemPrompt': systemPromptModule,
    '../../shared/effort': load('shared/effort.ts'),
    './memoryStore': { listMemoryTitles: async () => [] },
    './profileStore': { getProfile: async () => null },
    './notepad': { requestedNotepadText: () => undefined, openNotepadText: async () => '' },
    './appLauncher': { didAppLaunch: (result) => result.endsWith('a été lancé.') },
    './hardwareScan': { GPU_TEMP_LIMIT_C: 85, isScreenQuestion: () => false, pickSafeModel: (_f, _i, m) => m },
    './modelChoice': modelChoiceModule,
    './resourceMonitor': { checkOverloadWarning: async () => null },
    './requestJournal': journal,
    './tools': { TOOLS: [], createToolExecutor: (_fire, _vision, onLog) => (name, args) => execute(name, args, onLog) }
  }).converse
}

test('une demande à outil : étapes, durée de chaque appel au modèle et fin, dans le fichier', async () => {
  const { journal, path } = journalModule()
  let round = 0
  // Les mesures d'Ollama sont rendues par le 9e argument, comme le fait le vrai chatWithOllama.
  const chat = async (_messages, _tools, _model, _think, _signal, _ctx, _onToken, _onThinking, onMetrics) => {
    round++
    if (round === 1) {
      onMetrics({ loadMs: 41000, promptTokens: 4300, promptMs: 2200, outputTokens: 1200, outputMs: 48000, thinkingChars: 5100 })
      return { role: 'assistant', content: '', tool_calls: [{ function: { name: 'computer_use_task', arguments: { goal: 'tiramisu' } } }] }
    }
    onMetrics({ loadMs: 0, promptTokens: 4500, promptMs: 300, outputTokens: 40, outputMs: 1500, thinkingChars: 0 })
    return { role: 'assistant', content: 'Voici une recette de tiramisu.' }
  }
  const shown = []
  const converse = converseWith(journal, chat, async (_name, _args, onLog) => {
    // Une étape annoncée par l'outil lui-même (pilotage de l'écran) doit aussi arriver dans le journal.
    onLog('Étape 1/20 : clic sur la barre de recherche')
    return 'Tâche terminée.'
  })
  const reply = await converse('ouvre Firefox et cherche une recette de tiramisu', null, () => {}, (m) => shown.push(m), [], undefined, undefined, 'voice')
  assert.equal(reply, 'Voici une recette de tiramisu.')
  await journal.appendJournal([])
  const text = readFileSync(path, 'utf8')

  assert.match(text, /===== \d\d\/\d\d\/\d{4} \d\d:\d\d:\d\d — voix =====/)
  assert.match(text, /Demande : ouvre Firefox et cherche une recette de tiramisu/)
  assert.match(text, /Modèle granite4\.2:8b : demande computer_use_task — chargement du modèle 41,0 s, lecture 2,2 s \(4300 tokens\), écriture 48,0 s \(1200 tokens\), dont réflexion 5100 caractères — a pris/)
  assert.match(text, /\] Étape 1\/20 : clic sur la barre de recherche/)
  assert.match(text, /\] Résultat de l'outil : Tâche terminée\./)
  assert.match(text, /Modèle granite4\.2:8b : répond \(30 caractères\) — lecture 0,3 s/)
  assert.ok(!/répond \(30 caractères\) — chargement/.test(text), 'un modèle déjà chargé ne doit pas afficher de chargement')
  assert.match(text, /\] Fin : réponse donnée — Voici une recette de tiramisu\./)
  // Chaque ligne d'étape porte le temps écoulé depuis le début de la demande.
  for (const line of text.split('\n').filter((l) => l.startsWith('[+'))) assert.match(line, /^\[\+\d+,\d s\] /)
  // L'écran reçoit exactement les mêmes étapes qu'avant : le journal s'ajoute, il ne remplace rien.
  assert.ok(shown.includes('Étape 1/20 : clic sur la barre de recherche'))
  assert.ok(shown.some((m) => m.startsWith('Outil appelé : computer_use_task')))
  assert.ok(!shown.some((m) => m.startsWith('Modèle granite4.2:8b :')), 'les mesures du modèle ne vont que dans le fichier')
})

test('une erreur et une demande annulée sont notées comme telles, et l’erreur remonte toujours', async () => {
  const { journal, path } = journalModule()
  const failing = converseWith(journal, async () => { throw new Error('Impossible de joindre Ollama') }, async () => '')
  await assert.rejects(failing('quelle heure est-il', null, () => {}), /Impossible de joindre Ollama/)
  const controller = new AbortController()
  const aborted = converseWith(journal, async () => {
    controller.abort()
    const err = new Error('aborted')
    err.name = 'AbortError'
    throw err
  }, async () => '')
  await assert.rejects(aborted('cherche la météo', null, () => {}, undefined, [], controller.signal, undefined, 'chat'))
  await journal.appendJournal([])
  const text = readFileSync(path, 'utf8')
  assert.match(text, /Fin : erreur — Impossible de joindre Ollama/)
  assert.match(text, /— chat =====\nDemande : cherche la météo/)
  assert.match(text, /Fin : annulée/)
})

test('un journal impossible à écrire ne casse jamais la demande', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jaris-journal-'))
  const blocker = join(root, 'pas-un-dossier')
  writeFileSync(blocker, 'x')
  // Le « dossier de données » est un fichier : toute écriture échoue.
  const journal = load('electron/services/requestJournal.ts', { './dataLocation': { getDataRoot: () => join(blocker, 'sous') } })
  const converse = converseWith(journal, async () => ({ role: 'assistant', content: 'Il est midi.' }), async () => '')
  assert.equal(await converse('quelle heure est-il', null, () => {}), 'Il est midi.')
  await journal.appendJournal(['encore'])
})

test('au-delà de la taille maximale, seules les dernières demandes ENTIÈRES sont gardées', async () => {
  const { journal, path } = journalModule()
  const max = journal.JOURNAL_MAX_BYTES
  for (let i = 0; i < 40; i++) {
    const entry = journal.startJournalEntry('voice', `demande ${i}`)
    entry.line('x'.repeat(590))
    for (let j = 0; j < 30; j++) entry.line(`étape ${j} ${'y'.repeat(500)}`)
    await entry.end(`fin ${i}`)
  }
  const text = readFileSync(path, 'utf8')
  assert.ok(Buffer.byteLength(text) <= max, 'le fichier reste sous la limite')
  assert.ok(text.startsWith('====='), 'le fichier commence par le début d’une demande, jamais au milieu')
  assert.match(text, /Fin : fin 39\n$/)
  const kept = [...text.matchAll(/Demande : demande (\d+)/g)].map((m) => Number(m[1]))
  const ends = [...text.matchAll(/Fin : fin (\d+)/g)].map((m) => Number(m[1]))
  assert.deepEqual(kept, ends, 'chaque demande gardée a sa fin')
})

test('durées lisibles et lignes trop longues coupées', () => {
  const { journal } = journalModule()
  assert.equal(journal.formatElapsed(1234), '1,2 s')
  assert.equal(journal.formatElapsed(125000), '2 min 05 s')
  assert.equal(journal.describeModelCall('m', { content: 'ok' }), 'Modèle m : répond (2 caractères)')
})

function loadOllama(response) {
  const modules = {
    '../config': { config: { ollama: { host: 'http://ollama', model: 'm', numCtx: 8192 } } },
    '../../shared/effort': { parseModelThinking: () => null },
    './systemResources': { DISK_SAFETY_MARGIN_GB: 5, detectFreeDiskGb: () => 100, getDownloadBudgetGb: async () => 100 },
    './huggingFaceImport': { importHuggingFaceModel: async () => {} }
  }
  return load('electron/services/ollama.ts', modules, { fetch: async () => response }).chatWithOllama
}

const ollamaFinal = { load_duration: 41e9, prompt_eval_count: 4300, prompt_eval_duration: 2.2e9, eval_count: 1200, eval_duration: 48e9 }

test('chatWithOllama transmet les mesures d’Ollama (réponse d’un bloc, comme à la voix)', async () => {
  const data = { message: { role: 'assistant', content: 'ok', thinking: 'abcdef' }, done_reason: 'stop', ...ollamaFinal }
  const chat = loadOllama({ ok: true, status: 200, json: async () => data })
  let metrics
  await chat([{ role: 'user', content: 'x' }], [], 'm', 'medium', undefined, 8192, undefined, undefined, (m) => (metrics = m))
  assert.equal(JSON.stringify(metrics), JSON.stringify({ loadMs: 41000, promptTokens: 4300, promptMs: 2200, outputTokens: 1200, outputMs: 48000, thinkingChars: 6 }))
})

test('chatWithOllama transmet les mesures d’Ollama en streaming (Chat), réflexion comptée', async () => {
  const lines = [
    { message: { role: 'assistant', content: '', thinking: 'abc' } },
    { message: { role: 'assistant', content: '', thinking: 'de' } },
    { message: { role: 'assistant', content: 'Bonjour' } },
    { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', ...ollamaFinal }
  ]
  const body = new Response(lines.map((l) => JSON.stringify(l)).join('\n') + '\n').body
  const chat = loadOllama({ ok: true, status: 200, body })
  let metrics
  const reply = await chat([{ role: 'user', content: 'x' }], [], 'm', 'medium', undefined, 8192, () => {}, undefined, (m) => (metrics = m))
  assert.equal(reply.content, 'Bonjour')
  assert.equal(metrics.loadMs, 41000)
  assert.equal(metrics.outputTokens, 1200)
  assert.equal(metrics.thinkingChars, 5)
})

test('voix : le temps de correction de la transcription est noté, et le journal suit les données lors d’un « Déplacer »', () => {
  const pipeline = readFileSync(new URL('../electron/services/voicePipeline.ts', import.meta.url), 'utf8')
  assert.match(pipeline, /appendJournal\(\[[\s\S]{0,200}correction de la transcription[\s\S]{0,80}formatElapsed\(Date\.now\(\) - correctionStart\)/)
  const storage = readFileSync(new URL('../electron/services/storageRoot.ts', import.meta.url), 'utf8')
  assert.match(storage, /OWNED_ENTRIES = \[[^\]]*'journal-demandes\.txt'/)
})
