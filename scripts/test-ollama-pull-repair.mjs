import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * Étape 289 (Léo, après la mise à jour d'Ollama : « Téléchargement du modèle… success », puis « Ollama a répondu 404 :
 * model 'qwen3.8:27b' not found ») : quand Ollama n'annonce AUCUN modèle, Jaris le fait d'abord revoir ses modèles
 * (réparation branchée par main.ts) au lieu de relancer un téléchargement qui ne changerait rien.
 */
function load({ tagsBefore, tagsAfter = tagsBefore, unreachable = false }) {
  const source = ts.transpileModule(readFileSync(new URL('../electron/services/ollama.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const state = { repaired: false, pulls: 0, repairs: 0 }
  const module = { exports: {} }
  const modules = {
    '../config': { config: { ollama: { host: 'http://ollama', model: 'm', numCtx: 8192 } } },
    '../../shared/effort': { parseModelThinking: () => null },
    './systemResources': { DISK_SAFETY_MARGIN_GB: 5, detectFreeDiskGb: () => 100, getDownloadBudgetGb: async () => 100 },
    './huggingFaceImport': { importHuggingFaceModel: async () => {} },
    '../../shared/i18n': { t: (key, vars) => `${key} ${JSON.stringify(vars ?? {})}`, formatDecimal: String }
  }
  const fetch = async (url) => {
    // Rien n'écoute à l'adresse d'Ollama : c'est exactement ce que lève le fetch de Node.
    if (unreachable) throw new TypeError('fetch failed')
    if (String(url).endsWith('/api/tags')) {
      const names = state.repaired ? tagsAfter : tagsBefore
      return { ok: true, status: 200, json: async () => ({ models: names.map((name) => ({ name })) }) }
    }
    if (String(url).endsWith('/api/pull')) {
      state.pulls++
      const body = new TextEncoder().encode('{"status":"success"}\n')
      let sent = false
      return { ok: true, status: 200, body: { getReader: () => ({ read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: body })) }) } }
    }
    throw new Error(`appel inattendu : ${url}`)
  }
  vm.runInThisContext(`(function (exports, require, module, fetch) {\n${source}\n})`)(module.exports, (name) => modules[name], module, fetch)
  return { ollama: module.exports, state }
}

test('Ollama ne voit aucun modèle : réparé d’abord, et le modèle déjà là n’est pas retéléchargé', async () => {
  const { ollama, state } = load({ tagsBefore: [], tagsAfter: ['qwen3.8:27b'] })
  ollama.setModelsViewRepair(async () => {
    state.repairs++
    state.repaired = true
    return true
  })
  await ollama.pullModelIfMissing('qwen3.8:27b')
  assert.deepEqual({ repairs: state.repairs, pulls: state.pulls }, { repairs: 1, pulls: 0 })
})

test('la réparation n’y change rien (vraiment rien sur le disque) : le téléchargement a lieu comme avant', async () => {
  const { ollama, state } = load({ tagsBefore: [] })
  ollama.setModelsViewRepair(async () => {
    state.repairs++
    return false
  })
  await ollama.pullModelIfMissing('qwen3.8:27b')
  assert.deepEqual({ repairs: state.repairs, pulls: state.pulls }, { repairs: 1, pulls: 1 })
})

test('Ollama voit déjà des modèles : aucune réparation tentée', async () => {
  const { ollama, state } = load({ tagsBefore: ['granite4.2:8b'] })
  ollama.setModelsViewRepair(async () => {
    state.repairs++
    return true
  })
  await ollama.pullModelIfMissing('granite4.2:8b')
  assert.deepEqual({ repairs: state.repairs, pulls: state.pulls }, { repairs: 0, pulls: 0 })
})

test('Ollama ne répond pas du tout : un message qui le dit, jamais « fetch failed » (Léo, Retester la configuration)', async () => {
  const { ollama } = load({ tagsBefore: [], unreachable: true })
  await assert.rejects(ollama.pullModelIfMissing('qwen3.8:27b'), (err) => {
    assert.notEqual(err.message, 'fetch failed')
    assert.match(err.message, /^ollama\.unreachable .*http:\/\/ollama/)
    return true
  })
})

test('une autre erreur réseau garde son vrai message', async () => {
  const { ollama } = load({ tagsBefore: [] })
  const other = new TypeError('Invalid URL')
  assert.equal(ollama.explainOllamaUnreachable(other), other)
})
