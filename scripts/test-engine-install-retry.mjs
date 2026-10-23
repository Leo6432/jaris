import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { realpath, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Étape 346 : un antivirus qui inspecte le nouveau moteur d'Ollama le tient ouvert quelques secondes. Le renommage
 * unique échouait (EPERM), le paquet de 1,6 Go déjà vérifié était effacé, et la mise à jour arrêtait l'ancien moteur
 * avant d'avoir pu noter le nouveau — Jaris restait sans Ollama.
 */
const { createRequire } = await import('node:module')
const nodeRequire = createRequire(import.meta.url)
const engine = loadTsModule('electron/services/ollamaEngine.ts', {
  crypto: nodeRequire('crypto'),
  child_process: nodeRequire('child_process'),
  fs: nodeRequire('fs'),
  'fs/promises': nodeRequire('fs/promises'),
  os: nodeRequire('os'),
  path: nodeRequire('path'),
  './download': { downloadToFile: async () => undefined },
  './ollamaModelsVariable': { countOllamaModels: async () => 0 }
})

const refused = (code = 'EPERM') => Object.assign(new Error(`${code}: operation not permitted`), { code })

test('un refus passager de Windows est réessayé ; un refus qui dure est expliqué ; une autre erreur remonte', async () => {
  let attempts = 0
  await engine.renameWithRetries('a', 'b', [0, 0, 0], async () => {
    if (++attempts < 3) throw refused()
  })
  assert.equal(attempts, 3)
  await assert.rejects(
    engine.renameWithRetries('a', 'b', [0], async () => {
      throw refused('EBUSY')
    }),
    /antivirus/
  )
  await assert.rejects(
    engine.renameWithRetries('a', 'b', [0], async () => {
      throw refused('ENOENT')
    }),
    { code: 'ENOENT' }
  )
})

test('mise en place refusée : le paquet vérifié est gardé, et le nouvel essai ne le retélécharge pas', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jaris-engine-'))
  try {
    const release = { version: '0.41.0', url: 'https://example.test/ollama.zip', sha256: 'a'.repeat(64) }
    let downloads = 0
    const deps = (move) => ({
      download: async (_url, destination) => {
        downloads++
        writeFileSync(destination, 'paquet')
      },
      hash: async () => 'a'.repeat(64),
      extract: async (_zip, destination) => {
        mkdirSync(destination, { recursive: true })
        writeFileSync(join(destination, 'ollama.exe'), 'exe')
      },
      renameDelays: [],
      move
    })
    await assert.rejects(
      engine.installEngineVersion(release, () => {}, { root, deps: deps(async () => { throw refused() }) }),
      /antivirus/
    )
    assert.ok(existsSync(join(root, 'download', 'ollama-0.41.0.zip')), 'le paquet vérifié reste')
    const installed = await engine.installEngineVersion(release, () => {}, { root, deps: deps(rename) })
    assert.equal(downloads, 1, 'aucun second téléchargement de 1,6 Go')
    assert.ok(existsSync(installed.exe))
    assert.ok(!existsSync(join(root, 'download', 'ollama-0.41.0.zip')), 'effacé une fois le moteur en place')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('mise à jour : la nouvelle version est notée AVANT d’arrêter l’ancienne', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../electron/services/dependencyServices.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const flow = source.slice(source.indexOf('async function updateOllamaInner'))
  assert.ok(flow.indexOf('await setCurrentEngine(root, fresh.version)') < flow.indexOf('if (previous) await stopEmbeddedProcess()'))
})

test('un téléchargement de modèle interrompu n’est pas effacé au démarrage suivant d’Ollama', () => {
  const env = engine.engineEnv('/modeles', { PATH: 'x' })
  assert.equal(env.OLLAMA_NOPRUNE, '1')
  assert.equal(env.OLLAMA_MODELS, '/modeles')
  assert.equal(env.PATH, 'x')
})

test('dossier du moteur relié à un disque débranché : une phrase qui dit quoi rebrancher, jamais « ENOENT »', async () => {
  const { symlinkSync } = await import('node:fs')
  const base = mkdtempSync(join(tmpdir(), 'jaris-link-'))
  try {
    const link = join(base, 'ollama-engine')
    const gone = join(base, 'disque-externe', 'Jaris-data', 'ollama-engine')
    symlinkSync(gone, link, process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(engine.engineRoot(link), (err) => {
      assert.match(err.message, /débranché/)
      assert.doesNotMatch(err.message, /ENOENT/)
      return true
    })
    assert.ok(!existsSync(gone), 'rien n’est recréé à la place du disque absent')
    // engineRoot rend le chemin RÉEL : sous Windows, tmpdir() peut être un nom court (« RUNNER~1 »)
    // que realpath déplie en nom long. On compare avec la MÊME fonction que engineRoot (fs/promises) :
    // realpathSync, lui, ne déplie pas les noms courts sous Windows et donnait encore « RUNNER~1 ».
    const plain = join(base, 'normal')
    const got = await engine.engineRoot(plain)
    assert.equal(got, await realpath(plain))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
