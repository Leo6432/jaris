import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { i18nModules } from './load-ts-module.mjs'

/**
 * Écran « Configuration de Jaris » : le téléchargement d'un modèle n'affichait qu'« … 35% » et un rond qui tourne.
 * pullModelIfMissing transmet maintenant l'avancement en octets (reçus / taille) pour une vraie barre, sur le TOTAL du
 * modèle : Ollama l'envoie couche par couche (le gros fichier, puis quelques petits), et un pourcentage par couche
 * retombait à 0 % juste après le gros fichier. À la fin du téléchargement, réussi ou non, `null` efface la barre.
 */
const GB = 1024 ** 3

function load(pullLines) {
  const source = ts.transpileModule(readFileSync(new URL('../electron/services/ollama.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  const modules = {
    ...i18nModules(),
    '../config': { config: { ollama: { host: 'http://ollama', model: 'm', numCtx: 8192 } } },
    '../../shared/effort': { parseModelThinking: () => null },
    './systemResources': { DISK_SAFETY_MARGIN_GB: 5, detectFreeDiskGb: () => 100, getDownloadBudgetGb: async () => 100 },
    './huggingFaceImport': { importHuggingFaceModel: async () => {} }
  }
  const fetch = async (url) => {
    if (String(url).endsWith('/api/tags')) return { ok: true, status: 200, json: async () => ({ models: [{ name: 'autre:1b' }] }) }
    if (String(url).endsWith('/api/pull')) {
      // Une ligne JSON par morceau, comme le flux réel d'Ollama.
      const chunks = pullLines.map((line) => new TextEncoder().encode(`${JSON.stringify(line)}\n`))
      return { ok: true, status: 200, body: { getReader: () => ({ read: async () => (chunks.length ? { done: false, value: chunks.shift() } : { done: true }) }) } }
    }
    throw new Error(`appel inattendu : ${url}`)
  }
  vm.runInThisContext(`(function (exports, require, module, fetch) {\n${source}\n})`)(module.exports, (name) => {
    if (!(name in modules)) throw new Error(`Import non fourni au test : ${name}`)
    return modules[name]
  }, module, fetch)
  return module.exports
}

const layer = (digest, total, completed) => ({ status: `pulling ${digest}`, digest, total, completed })

test('avancement en octets sur tout le modèle, sans retomber à 0 % après le gros fichier, puis null à la fin', async () => {
  const big = 3.4 * GB
  const ollama = load([
    { status: 'pulling manifest' },
    layer('sha256:gros', big, 0),
    layer('sha256:gros', big, 0.35 * big),
    layer('sha256:gros', big, big),
    layer('sha256:petit', 12_000, 0),
    layer('sha256:petit', 12_000, 12_000),
    { status: 'verifying sha256 digest' },
    { status: 'success' }
  ])
  const progress = []
  const lines = []
  await ollama.pullModelIfMissing('qwen3.5:4b', (line) => lines.push(line), (p) => progress.push(p))

  assert.equal(progress.at(-1), null, 'la barre disparaît à la fin du téléchargement')
  const steps = progress.slice(0, -1)
  assert.ok(steps.length >= 3, JSON.stringify(steps))
  assert.ok(steps.every((p) => p.model === 'qwen3.5:4b'))
  // Un petit fichier qui commence fait passer le total d'un cheveu au-dessus (100 → 99 → 100), jamais retomber à 0 %.
  const neverFallsBack = (values) => values.every((value, i) => i === 0 || value >= values[i - 1] - 1)
  const stepPercents = steps.map((p) => Math.floor((p.completed / p.total) * 100))
  assert.ok(neverFallsBack(stepPercents), `le pourcentage ne retombe pas : ${stepPercents.join(', ')}`)
  assert.equal(steps[1].completed, 0.35 * big)
  assert.equal(steps[1].total, big)
  // Les petits fichiers s'ajoutent au total au lieu de repartir de zéro.
  assert.equal(steps.at(-1).total, big + 12_000)
  assert.equal(steps.at(-1).completed, big + 12_000)
  const percents = lines.map((line) => line.match(/(\d+)\s*%/)?.[1]).filter(Boolean).map(Number)
  assert.ok(neverFallsBack(percents), `le texte ne repart pas à 0 % : ${percents.join(', ')}`)
})

test('un téléchargement qui échoue efface aussi la barre (sinon elle resterait figée pendant la suite)', async () => {
  const big = 2 * GB
  const ollama = load([layer('sha256:gros', big, 0), layer('sha256:gros', big, big / 2), { error: 'connexion perdue' }])
  const progress = []
  await assert.rejects(ollama.pullModelIfMissing('granite4.2:8b', () => {}, (p) => progress.push(p)), /connexion perdue/)
  assert.equal(progress.at(-1), null)
  assert.equal(progress.at(-2).completed, big / 2)
})

test('modèle déjà installé : aucun avancement annoncé', async () => {
  const ollama = load([])
  const progress = []
  await ollama.pullModelIfMissing('autre:1b', () => {}, (p) => progress.push(p))
  assert.deepEqual(progress, [])
})
