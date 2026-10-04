import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * Étape 232 : chatWithOllama retente sans réflexion quand le premier appel échoue. Vu en vrai le 04/10/2026 avec
 * ministral-3:3b (qui refuse la réflexion) : le second appel a échoué pour une AUTRE raison (appel d'outil mal formé,
 * erreur 500), mais Jaris affichait « does not support thinking » — un message qui ne disait rien du vrai problème.
 */
function load(responses) {
  const source = ts.transpileModule(readFileSync(new URL('../electron/services/ollama.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const calls = []
  const module = { exports: {} }
  const modules = {
    '../config': { config: { ollama: { host: 'http://ollama', model: 'm', numCtx: 8192 } } },
    '../../shared/effort': { parseModelThinking: () => null },
    './systemResources': { DISK_SAFETY_MARGIN_GB: 5, detectFreeDiskGb: () => 100, getDownloadBudgetGb: async () => 100 },
    './huggingFaceImport': { importHuggingFaceModel: async () => {} }
  }
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    calls.push(body)
    const [status, payload] = responses.shift()
    return { ok: status === 200, status, text: async () => payload, json: async () => JSON.parse(payload) }
  }
  vm.runInThisContext(`(function (exports, require, module, fetch) {\n${source}\n})`)(module.exports, (name) => modules[name], module, fetch)
  return { chat: module.exports.chatWithOllama, calls }
}

test('réflexion refusée puis vraie erreur : c’est la vraie erreur qui remonte', async () => {
  const { chat, calls } = load([
    [400, '{"error":"\\"ministral-3:3b\\" does not support thinking"}'],
    [500, '{"error":"error parsing tool call"}']
  ])
  await assert.rejects(chat([{ role: 'user', content: 'x' }], [], 'ministral-3:3b'), /500.*error parsing tool call/)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].think, 'medium')
  assert.equal(calls[1].think, undefined)
})

test('autre première erreur : elle reste celle qui remonte (comportement d’avant)', async () => {
  const { chat } = load([
    [500, '{"error":"model runner has unexpectedly stopped"}'],
    [500, '{"error":"autre chose"}']
  ])
  await assert.rejects(chat([{ role: 'user', content: 'x' }], [], 'qwen3.5:4b'), /model runner has unexpectedly stopped/)
})

test('réflexion refusée puis réponse : la réponse arrive normalement', async () => {
  const { chat } = load([
    [400, '{"error":"\\"granite4.2:3b\\" does not support thinking"}'],
    [200, '{"message":{"role":"assistant","content":"Bonjour"},"done_reason":"stop"}']
  ])
  const message = await chat([{ role: 'user', content: 'x' }], [], 'granite4.2:3b')
  assert.equal(message.content, 'Bonjour')
})
