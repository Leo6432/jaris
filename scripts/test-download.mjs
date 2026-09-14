import assert from 'node:assert/strict'
import nodeEvents from 'node:events'
import nodeFs, { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import nodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * electron/services/download.ts (étape 98) — le téléchargement partagé par les trois installeurs de Jaris
 * (Jaris lui-même, Ollama, Docker Desktop).
 *
 * Écrit après le retour de Léo : "quand on demande une mise à jour on ne sait pas quand c'est terminé et
 * des fois c'est bloqué et ça fait rien". Ce que ce test verrouille, dans l'ordre d'importance :
 *  - l'avancement est vraiment émis au fil de l'eau (sinon on revient au bouton figé) ;
 *  - un téléchargement TRONQUÉ échoue au lieu de laisser un .exe incomplet sur le disque — c'est lui qui
 *    "ne fait rien" une fois lancé ;
 *  - un plafond d'inactivité, jamais un plafond de durée totale : un fichier de 1,5 Go qui avance lentement
 *    ne doit plus jamais être coupé en pleine réussite ;
 *  - les messages d'erreur sont en français et actionnables (ils sont affichés TELS QUELS à Léo).
 */
function loadModule(relativePath, requireShim) {
  const source = ts.transpileModule(readFileSync(new URL(relativePath, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const exports = {}
  vm.runInThisContext(`(function (exports, module, require) { ${source} })`)(exports, { exports }, requireShim)
  return exports
}

const sharedFormat = loadModule('../shared/formatBytes.ts', () => ({}))
const { downloadToFile, describeDownloadFailure, DownloadError } = loadModule('../electron/services/download.ts', (id) => {
  if (id === 'fs') return nodeFs
  if (id === 'fs/promises') return nodeFsPromises
  if (id === 'events') return nodeEvents
  if (id.endsWith('formatBytes')) return sharedFormat
  throw new Error(`module non simulé dans le test : ${id}`)
})

const outDir = mkdtempSync(join(tmpdir(), 'jaris-download-'))
let served = null

/**
 * Faux serveur : renvoie les paquets demandés, avec la taille annoncée qu'on veut (y compris fausse, pour
 * simuler une connexion coupée en cours de route). `hang: true` = le serveur ne renvoie plus rien du tout
 * après les premiers paquets, sans fermer la connexion — exactement le cas "c'est bloqué" de Léo, qu'un
 * plafond de durée totale ne distingue pas d'un téléchargement simplement lent.
 */
globalThis.fetch = (url, init) => {
  const { status = 200, chunks = [], announced, hang = false, neverAnswers = false } = served
  const signal = init?.signal
  const abortError = () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })

  if (neverAnswers) {
    return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(abortError())))
  }
  if (status !== 200) return Promise.resolve({ ok: false, status, headers: { get: () => null }, body: null })

  const queue = [...chunks]
  const total = announced === undefined ? chunks.reduce((sum, c) => sum + c.length, 0) : announced
  return Promise.resolve({
    ok: true,
    status,
    headers: { get: (name) => (name.toLowerCase() === 'content-length' && total !== null ? String(total) : null) },
    body: {
      getReader: () => ({
        read: () =>
          new Promise((resolve, reject) => {
            if (signal?.aborted) return reject(abortError())
            if (queue.length) return resolve({ done: false, value: queue.shift() })
            if (!hang) return resolve({ done: true, value: undefined })
            signal?.addEventListener('abort', () => reject(abortError()))
          })
      })
    }
  })
}

function chunk(size, fill) {
  return new Uint8Array(size).fill(fill)
}

test('le téléchargement rapporte son avancement au fil de l\'eau, pas seulement à la fin', async () => {
  served = { chunks: [chunk(4000, 1), chunk(4000, 2), chunk(2000, 3)] }
  const destination = join(outDir, 'ok.bin')
  const events = []

  // PROGRESS_INTERVAL_MS (200 ms) limite le débit d'évènements : sans attente entre les paquets, seuls le
  // premier et le dernier sortiraient. On vérifie donc la mécanique (premier appel, appel final complet),
  // pas un nombre d'évènements qui dépendrait de la vitesse de la machine.
  const written = await downloadToFile('https://exemple/fichier.exe', destination, {
    onProgress: (progress) => events.push({ ...progress })
  })

  assert.equal(written, 10000)
  assert.equal(readFileSync(destination).length, 10000)
  assert.ok(events.length >= 2, `aucun avancement rapporté : ${events.length} évènement(s)`)
  assert.deepEqual(events[0], { receivedBytes: 0, totalBytes: 10000, percent: 0 })
  assert.deepEqual(events.at(-1), { receivedBytes: 10000, totalBytes: 10000, percent: 100 })
})

test('un téléchargement tronqué échoue et ne laisse AUCUN fichier derrière lui', async () => {
  // Le cas qui "ne fait rien" en usage réel : un .exe incomplet se lance sans la moindre erreur visible.
  // Avant l'étape 98, ce fichier était écrit puis lancé, Jaris étant déjà fermé pour le signaler.
  served = { chunks: [chunk(3000, 1)], announced: 9000 }
  const destination = join(outDir, 'tronque.bin')

  await assert.rejects(
    () => downloadToFile('https://exemple/fichier.exe', destination),
    (err) => {
      assert.ok(err instanceof DownloadError)
      assert.match(err.message, /incomplet/i)
      assert.match(err.message, /3 Ko reçus sur 9 Ko/)
      return true
    }
  )
  assert.equal(existsSync(destination), false, 'un fichier partiel est resté sur le disque')
})

test('une connexion qui se tait est abandonnée sur son INACTIVITÉ, pas sur une durée totale', async () => {
  // 1,5 Go (OllamaSetup.exe, mesuré) : aucun plafond de durée totale ne peut convenir à la fois à une
  // fibre et à une connexion modeste. Ici le délai ne court que tant qu'AUCUN octet n'arrive.
  served = { chunks: [chunk(2048, 1)], announced: 999_999, hang: true }
  const destination = join(outDir, 'bloque.bin')

  await assert.rejects(
    () => downloadToFile('https://exemple/fichier.exe', destination, { stallTimeoutMs: 60 }),
    (err) => {
      assert.match(err.message, /Téléchargement interrompu après 2 Ko/)
      assert.match(err.message, /vérifie ta connexion internet/i)
      return true
    }
  )
  assert.equal(existsSync(destination), false)
})

test("un serveur qui ne répond pas du tout le dit en français, pas en 'AbortError'", async () => {
  served = { neverAnswers: true }
  await assert.rejects(
    () => downloadToFile('https://exemple/fichier.exe', join(outDir, 'muet.bin'), { connectTimeoutMs: 50 }),
    (err) => {
      assert.match(err.message, /Le serveur n'a pas répondu au bout de 0 secondes|n'a pas répondu/)
      assert.doesNotMatch(err.message, /AbortError|aborted/)
      return true
    }
  )
})

test('une réponse HTTP en erreur ne crée aucun fichier', async () => {
  served = { status: 404 }
  const destination = join(outDir, 'introuvable.bin')
  await assert.rejects(() => downloadToFile('https://exemple/fichier.exe', destination), /HTTP 404/)
  assert.equal(existsSync(destination), false)
})

test('les messages d\'échec sont rédigés pour Léo, pas pour un développeur', () => {
  const base = { receivedBytes: 0, totalBytes: null, stalledAfterMs: null }

  assert.match(describeDownloadFailure(new Error('fetch failed'), base), /pas de connexion internet/i)
  assert.match(
    describeDownloadFailure(Object.assign(new Error('x'), { code: 'ENOSPC' }), base),
    /plus assez de place sur le disque/i
  )
  assert.match(
    describeDownloadFailure(Object.assign(new Error('x'), { code: 'EBUSY' }), base),
    /antivirus|installation déjà en cours/i
  )
  // Rien reçu du tout pendant 30 s = le serveur n'a jamais répondu ; des octets déjà reçus = coupure en route.
  assert.match(describeDownloadFailure(new Error('x'), { ...base, stalledAfterMs: 30_000 }), /au bout de 30 secondes/)
  assert.match(
    describeDownloadFailure(new Error('x'), { receivedBytes: 1024 * 1024, totalBytes: null, stalledAfterMs: 60_000 }),
    /interrompu après 1 Mo/
  )
})

test('les tailles sont affichées en français, jamais en octets bruts', () => {
  assert.equal(sharedFormat.formatBytes(102_711_850), '98 Mo')
  assert.equal(sharedFormat.formatBytes(1_574_272_976), '1,5 Go')
  assert.equal(sharedFormat.formatBytes(2048), '2 Ko')
  assert.equal(sharedFormat.formatBytes(0), '0 o')
})

test.after(() => rmSync(outDir, { recursive: true, force: true }))
