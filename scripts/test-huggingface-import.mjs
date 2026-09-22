import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * electron/services/huggingFaceImport.ts — étape 139, contournement du bug d'Ollama 0.34.2 ("blocked redirect
 * to a different host" sur tout `pull hf.co/...`). Jaris refait lui-même le pull : manifeste du registre Hugging
 * Face, envoi de chaque GGUF à Ollama (`/api/blobs`), puis `/api/create` avec le gabarit et les paramètres du
 * manifeste. Ici, Hugging Face et Ollama sont simulés par un faux `fetch` ; le faux Ollama recalcule
 * l'empreinte SHA-256 de chaque fichier reçu et le refuse s'il ne correspond pas — comme le vrai.
 */
const source = ts.transpileModule(readFileSync(new URL('../electron/services/huggingFaceImport.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

const sha = (buf) => `sha256:${createHash('sha256').update(buf).digest('hex')}`

class ModelTooLargeError extends Error {}
class DiskFullError extends Error {}

function setup({ layers, template = '{{ .Prompt }}', params = { stop: ['<|im_end|>'] }, budgetGb = 100, freeDiskGb = 500, corrupt = false, alreadyStored = [], cutAfter = 0 }) {
  const blobs = new Map(layers.map((l) => [sha(l.data), l.data]))
  const manifest = {
    layers: [
      ...layers.map((l) => ({ digest: sha(l.data), mediaType: l.mediaType, size: l.data.length })),
      { digest: sha(Buffer.from(template)), mediaType: 'application/vnd.ollama.image.template', size: template.length },
      { digest: sha(Buffer.from(JSON.stringify(params))), mediaType: 'application/vnd.ollama.image.params', size: 10 }
    ]
  }
  blobs.set(sha(Buffer.from(template)), Buffer.from(template))
  blobs.set(sha(Buffer.from(JSON.stringify(params))), Buffer.from(JSON.stringify(params)))

  const stored = new Set(alreadyStored)
  const cutDone = new Set()
  const uploads = []
  const creates = []
  const requests = []

  async function fakeFetch(url, init = {}) {
    requests.push(`${init.method ?? 'GET'} ${url}`)
    const hf = url.match(/^https:\/\/huggingface\.co\/v2\/([^/]+\/[^/]+)\/(manifests|blobs)\/(.+)$/)
    if (hf) {
      if (hf[2] === 'manifests') return new Response(JSON.stringify(manifest), { status: 200 })
      let data = blobs.get(hf[3])
      if (!data) return new Response('', { status: 404 })
      const range = init.headers?.Range?.match(/^bytes=(\d+)-$/)
      if (range) return new Response(data.subarray(Number(range[1])), { status: 206 })
      // Coupure réseau simulée : la PREMIÈRE lecture d'un gros fichier s'arrête net après `cutAfter` octets.
      if (cutAfter && data.length > 100 && !cutDone.has(hf[3])) {
        cutDone.add(hf[3])
        const head = data.subarray(0, cutAfter)
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array(head))
              c.error(new Error('other side closed'))
            }
          }),
          { status: 200 }
        )
      }
      if (corrupt && data.length > 100) data = Buffer.concat([data.subarray(0, 10), Buffer.from('X'), data.subarray(11)])
      return new Response(data, { status: 200 })
    }
    const blob = url.match(/^http:\/\/ollama\/api\/blobs\/(.+)$/)
    if (blob && init.method === 'HEAD') return new Response(null, { status: stored.has(blob[1]) ? 200 : 404 })
    if (blob && init.method === 'POST') {
      const received = Buffer.from(await new Response(init.body).arrayBuffer())
      if (sha(received) !== blob[1]) return new Response('digest mismatch', { status: 400 })
      stored.add(blob[1])
      uploads.push(blob[1])
      return new Response(null, { status: 201 })
    }
    if (url === 'http://ollama/api/create') {
      creates.push(JSON.parse(init.body))
      return new Response(JSON.stringify({ status: 'success' }), { status: 200 })
    }
    throw new Error(`requête inattendue : ${url}`)
  }

  const modules = {
    '../config': { config: { ollama: { host: 'http://ollama' } } },
    './systemResources': { DISK_SAFETY_MARGIN_GB: 10, detectFreeDiskGb: () => freeDiskGb, getDownloadBudgetGb: async () => budgetGb },
    './ollama': { ModelTooLargeError, DiskFullError }
  }
  const exports = {}
  const context = { exports, module: { exports }, require: (id) => modules[id], fetch: fakeFetch, Response, ReadableStream, TransformStream, AbortController, setTimeout, clearTimeout, JSON }
  vm.runInNewContext(source, context)
  return { ...exports, uploads, creates, requests, statuses: [] }
}

const MODEL = 'application/vnd.ollama.image.model'
const PROJECTOR = 'application/vnd.ollama.image.projector'
const weights = Buffer.alloc(4096, 7)
const projector = Buffer.alloc(2048, 3)

test('parseHuggingFaceModel : dépôt et tag, "latest" par défaut, rien pour un tag Ollama normal', () => {
  const { parseHuggingFaceModel } = setup({ layers: [{ mediaType: MODEL, data: weights }] })
  assert.deepEqual({ ...parseHuggingFaceModel('hf.co/bartowski/ai9stars_G9v3-3B-GGUF') }, { repo: 'bartowski/ai9stars_G9v3-3B-GGUF', tag: 'latest' })
  assert.deepEqual({ ...parseHuggingFaceModel('hf.co/ggml-org/GLM-4.6V-Flash-GGUF:Q4_K_M') }, { repo: 'ggml-org/GLM-4.6V-Flash-GGUF', tag: 'Q4_K_M' })
  assert.equal(parseHuggingFaceModel('qwen3.5:4b'), null)
  assert.equal(parseHuggingFaceModel('hf.co/../etc:x'), null, 'un identifiant bizarre ne doit jamais construire une URL')
})

test('G9v3-3B : envoie le GGUF à Ollama puis crée le modèle sous le même nom, avec gabarit et paramètres', async () => {
  const t = setup({ layers: [{ mediaType: MODEL, data: weights }], template: 'T', params: { stop: ['<|im_end|>'] } })
  await t.importHuggingFaceModel('hf.co/bartowski/ai9stars_G9v3-3B-GGUF')
  assert.deepEqual(t.uploads, [sha(weights)])
  assert.equal(t.creates.length, 1)
  const create = t.creates[0]
  assert.equal(create.model, 'hf.co/bartowski/ai9stars_G9v3-3B-GGUF', 'même nom que le pull : le reste de Jaris le retrouve tel quel')
  assert.deepEqual(create.files, { 'model.gguf': sha(weights) })
  assert.equal(create.template, 'T')
  assert.deepEqual(create.parameters, { stop: ['<|im_end|>'] })
})

test('GLM-4.6V-Flash : le projecteur de vision est envoyé aussi, sinon le modèle ne verrait plus les images', async () => {
  const t = setup({ layers: [{ mediaType: MODEL, data: weights }, { mediaType: PROJECTOR, data: projector }] })
  await t.importHuggingFaceModel('hf.co/ggml-org/GLM-4.6V-Flash-GGUF:Q4_K_M')
  assert.deepEqual(t.creates[0].files, { 'model.gguf': sha(weights), 'projector.gguf': sha(projector) })
  assert.ok(t.requests.includes('GET https://huggingface.co/v2/ggml-org/GLM-4.6V-Flash-GGUF/manifests/Q4_K_M'))
})

test('un fichier déjà présent dans Ollama n\'est pas retéléchargé', async () => {
  const t = setup({ layers: [{ mediaType: MODEL, data: weights }], alreadyStored: [sha(weights)] })
  await t.importHuggingFaceModel('hf.co/bartowski/ai9stars_G9v3-3B-GGUF')
  assert.deepEqual(t.uploads, [])
  assert.ok(!t.requests.some((r) => r.includes(`/blobs/${sha(weights)}`) && r.startsWith('GET')), 'aucun téléchargement du gros fichier')
  assert.equal(t.creates.length, 1)
})

test('un fichier corrompu en route est refusé et le modèle n\'est JAMAIS créé', async () => {
  const t = setup({ layers: [{ mediaType: MODEL, data: weights }], corrupt: true })
  await assert.rejects(t.importHuggingFaceModel('hf.co/bartowski/ai9stars_G9v3-3B-GGUF'), /corrompu/)
  assert.equal(t.creates.length, 0)
})

test('trop gros pour la machine ou pour le disque : refusé AVANT de télécharger quoi que ce soit', async () => {
  const big = setup({ layers: [{ mediaType: MODEL, data: weights }], budgetGb: 0 })
  await assert.rejects(big.importHuggingFaceModel('hf.co/bartowski/ai9stars_G9v3-3B-GGUF'), ModelTooLargeError)
  assert.deepEqual(big.uploads, [])
  const full = setup({ layers: [{ mediaType: MODEL, data: weights }], freeDiskGb: 0 })
  await assert.rejects(full.importHuggingFaceModel('hf.co/bartowski/ai9stars_G9v3-3B-GGUF'), DiskFullError)
  assert.deepEqual(full.uploads, [])
})

test('une coupure réseau en plein téléchargement reprend là où elle s\'était arrêtée, sans tout recommencer', async () => {
  const t = setup({ layers: [{ mediaType: MODEL, data: weights }], cutAfter: 1000 })
  await t.importHuggingFaceModel('hf.co/bartowski/ai9stars_G9v3-3B-GGUF')
  assert.deepEqual(t.uploads, [sha(weights)], 'le fichier reçu par Ollama doit être complet et intact malgré la coupure')
  assert.equal(t.creates.length, 1)
})
