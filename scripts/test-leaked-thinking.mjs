import { withI18n } from './i18n-test-module.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { stripLeakedThinking as simulatorCopy } from './benchmark-scenarios.mjs'

/**
 * Étape 314 : K2 Horizon 7B a laissé « </ifm|think> » au début de 3 réponses des demandes complètes de Léo
 * (14/10/2026) — « </ifm|think> Ton code wifi est TROMPETTE-42. ». Lue à voix haute, la balise devient du charabia, et
 * chez la 0.9B toute la réflexion en anglais la précédait. Le vrai requestChat (ollama.ts), en bloc et en streaming.
 */
function load(respond) {
  const source = ts.transpileModule(readFileSync(new URL('../electron/services/ollama.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  const modules = {
    '../config': { config: { ollama: { host: 'http://ollama', model: 'm', numCtx: 8192 } } },
    '../../shared/effort': { parseModelThinking: () => null },
    './systemResources': { DISK_SAFETY_MARGIN_GB: 5, detectFreeDiskGb: () => 100, getDownloadBudgetGb: async () => 100 },
    './huggingFaceImport': { importHuggingFaceModel: async () => {} }
  }
  const fetch = async (url, init) => {
    if (String(url).endsWith('/api/show')) return { ok: true, status: 200, json: async () => ({ model_info: {} }) }
    return respond(JSON.parse(init.body))
  }
  vm.runInThisContext(`(function (exports, require, module, fetch) {\n${source}\n})`)(module.exports, withI18n((name) => modules[name]), module, fetch)
  return module.exports
}

/** Une réponse streamée d'Ollama, découpée exactement en ces fragments de texte. */
function streamed(pieces) {
  const lines = [...pieces.map((content) => ({ message: { role: 'assistant', content } })), { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', eval_count: 5 }]
  const bytes = new TextEncoder().encode(lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  let sent = false
  return { ok: true, status: 200, body: { getReader: () => ({ read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: bytes })) }) } }
}

const SAMPLES = [
  ['</ifm|think> Ton code wifi est TROMPETTE-42.', 'Ton code wifi est TROMPETTE-42.'],
  ["</ifm|think>D'accord, ton rappel est programmé pour 10:30.", "D'accord, ton rappel est programmé pour 10:30."],
  ['The user wants Spotify. So the tool call is:\n\n</ifm|think>\nDimanche, 10:00. Je lance Spotify.', 'Dimanche, 10:00. Je lance Spotify.'],
  ['réflexion</think>\nBonjour', 'Bonjour'],
  ['a</ifm|think>b</ifm|think> c', 'c'],
  ['Bonjour, 3 < 5 et <b>gras</b>.', 'Bonjour, 3 < 5 et <b>gras</b>.'],
  ['  Réponse normale  ', '  Réponse normale  '],
  ['</ifm|think>', '']
]

test('la réflexion fuitée est retirée, une réponse normale reste intacte', () => {
  const { stripLeakedThinking } = load(() => assert.fail('aucun appel'))
  for (const [raw, expected] of SAMPLES) assert.equal(stripLeakedThinking(raw), expected, raw)
})

test('la copie du simulateur du test (benchmark-scenarios.mjs) donne exactement la même chose', () => {
  const { stripLeakedThinking } = load(() => assert.fail('aucun appel'))
  for (const [raw] of SAMPLES) assert.equal(simulatorCopy(raw), stripLeakedThinking(raw), raw)
})

test('réponse d’un bloc (voix) : la balise et ce qui la précède ne reviennent jamais', async () => {
  const { chatWithOllama } = load(() => ({
    ok: true,
    status: 200,
    json: async () => ({ message: { role: 'assistant', content: '</ifm|think> Ton code wifi est TROMPETTE-42.' }, done_reason: 'stop' })
  }))
  const message = await chatWithOllama([{ role: 'user', content: 'x' }], [], 'hf.co/IFM/K2-Horizon-7B-GGUF:Q4_K_M')
  assert.equal(message.content, 'Ton code wifi est TROMPETTE-42.')
})

test('streaming (Chat) : la balise coupée en morceaux n’apparaît jamais à l’écran, même un instant', async () => {
  const { chatWithOllama } = load(() => streamed(['</', 'ifm', '|th', 'ink>', 'Ton code ', 'wifi est', ' TROMPETTE-42.']))
  const shown = []
  const message = await chatWithOllama([{ role: 'user', content: 'x' }], [], 'k2', 'medium', undefined, 8192, (delta) => shown.push(delta))
  assert.equal(message.content, 'Ton code wifi est TROMPETTE-42.')
  assert.equal(shown.join(''), 'Ton code wifi est TROMPETTE-42.')
  assert.ok(shown.every((d) => !d.includes('<') && !d.includes('ifm')), JSON.stringify(shown))
})

test('streaming : un « < » ordinaire est retenu un fragment, puis affiché normalement', async () => {
  const { chatWithOllama } = load(() => streamed(['3 <', ' 5, et ', '<b>', 'gras</b>.']))
  const shown = []
  const message = await chatWithOllama([{ role: 'user', content: 'x' }], [], 'm', 'medium', undefined, 8192, (delta) => shown.push(delta))
  assert.equal(message.content, '3 < 5, et <b>gras</b>.')
  assert.equal(shown.join(''), '3 < 5, et <b>gras</b>.')
})

test('une réponse qui n’est QUE la balise compte comme une réponse vide (pas comme « </ifm|think> » lu à voix haute)', async () => {
  const { chatWithOllama } = load(() => streamed(['</ifm|think>']))
  await assert.rejects(chatWithOllama([{ role: 'user', content: 'x' }], [], 'k2', 'medium', undefined, 8192, () => {}))
})
