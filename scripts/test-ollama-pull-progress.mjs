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
 *
 * Additionner les couches ne suffit pas quand un SECOND gros fichier suit : Ollama télécharge les fichiers l'un après
 * l'autre sans annoncer les suivants (server/images.go, PullModel → downloadBlob, vérifié dans son code), donc le total
 * grandit en route. Le pourcentage AFFICHÉ (`percent`) ne recule jamais, reste sous 100 tant que ce n'est pas fini, et
 * `nextFile` dit qu'un fichier de plus est en cours. Cas réel ci-dessous : le manifeste de MAI-UI 8B (modèle de
 * pilotage d'écran), relevé sur hf.co le 17/10/2026, dans l'ordre où Ollama le télécharge.
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
const PILOT = 'hf.co/mradermacher/MAI-UI-8B-GGUF:Q4_K_M'

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
  assert.equal(steps[1].percent, 35)
  assert.ok(steps.every((p) => p.nextFile === false), 'de tout petits fichiers après le gros ne sont pas annoncés')
  assert.equal(Math.max(...steps.map((p) => p.percent)), 99, 'jamais 100 % avant la fin (Ollama vérifie encore les fichiers)')
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

test('un second GROS fichier (MAI-UI 8B : 5,0 Go puis 0,75 Go) : le pourcentage affiché ne recule jamais, et le dit', async () => {
  // Manifeste réel de hf.co/mradermacher/MAI-UI-8B-GGUF:Q4_K_M, dans l'ordre des couches puis la config.
  const model = 5_027_785_216
  const template = 182
  const projector = 752_289_760
  const lines = [{ status: 'pulling manifest' }]
  for (let i = 0; i <= 20; i++) lines.push(layer('sha256:modele', model, Math.round((model * i) / 20)))
  lines.push(layer('sha256:gabarit', template, template))
  for (let i = 0; i <= 10; i++) lines.push(layer('sha256:lecteur', projector, Math.round((projector * i) / 10)))
  lines.push(layer('sha256:reglages', 57, 57), layer('sha256:config', 632, 632), { status: 'verifying sha256 digest' }, { status: 'success' })
  const ollama = load(lines)
  const progress = []
  const texts = []
  await ollama.pullModelIfMissing(PILOT, (line) => texts.push(line), (p) => progress.push(p))

  const steps = progress.slice(0, -1)
  const shown = steps.map((p) => p.percent)
  assert.ok(shown.every((v, i) => i === 0 || v >= shown[i - 1]), `le pourcentage affiché ne recule jamais : ${shown.join(', ')}`)
  assert.ok(shown.every((v) => v <= 99), 'jamais 100 % tant que le second fichier se télécharge')
  // Le pourcentage brut, lui, retombe (100 → 86) : c'est exactement ce que l'affichage ne doit pas montrer.
  const raw = steps.map((p) => Math.floor((p.completed / p.total) * 100))
  assert.ok(Math.min(...raw.slice(raw.indexOf(100))) < 90, `le cas teste bien un recul du brut : ${raw.join(', ')}`)
  // Pendant le second fichier, la barre attend : on le dit, et la taille reçue continue d'avancer (vraie, pas figée).
  const during = steps.filter((p) => p.nextFile)
  assert.ok(during.length >= 5, `fichier suivant annoncé pendant le lecteur d'images : ${JSON.stringify(steps.map((p) => p.nextFile))}`)
  assert.ok(during.every((p) => p.total === model + template + projector))
  const received = during.map((p) => p.completed)
  assert.ok(received.every((v, i) => i === 0 || v > received[i - 1]), 'la taille reçue avance pendant que la barre attend')
  assert.equal(steps.at(-1).completed, steps.at(-1).total)
  // Même chose dans la ligne de texte : jamais de recul de pourcentage, et « fichier suivant » une seule fois.
  const percents = texts.map((line) => line.match(/(\d+)\s*%/)?.[1]).filter(Boolean).map(Number)
  assert.ok(percents.every((v, i) => i === 0 || v >= percents[i - 1]), `texte : ${percents.join(', ')}`)
  assert.equal(texts.filter((line) => line.includes('fichier suivant')).length, 1, texts.join(' / '))
  // Chaque ligne une seule fois : le mode Code empile ces lignes dans sa conversation (« 99 % » redit = une de trop).
  assert.equal(new Set(texts).size, texts.length, texts.join(' / '))
})

test('createPullPercent : suit les octets, ne recule jamais, plafonne à 99 et dit quand il attend un fichier de plus', () => {
  const ollama = load([])
  const next = ollama.createPullPercent()
  assert.deepEqual({ ...next(0, 100) }, { percent: 0, nextFile: false })
  assert.deepEqual({ ...next(42, 100) }, { percent: 42, nextFile: false })
  assert.deepEqual({ ...next(100, 100) }, { percent: 99, nextFile: false })
  // Un fichier de plus : le total grandit, le brut retombe à 50 — l'affiché reste à 99 et dit pourquoi.
  assert.deepEqual({ ...next(100, 200) }, { percent: 99, nextFile: true })
  assert.deepEqual({ ...next(190, 200) }, { percent: 99, nextFile: true })
  assert.deepEqual({ ...next(200, 200) }, { percent: 99, nextFile: false })
  // Taille encore inconnue : 0, jamais une division par zéro.
  assert.deepEqual({ ...ollama.createPullPercent()(5, 0) }, { percent: 0, nextFile: false })
})
