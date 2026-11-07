import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import http from 'node:http'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Étape 328 : une entité numérique hors de l'Unicode (« &#99999999; ») faisait lever String.fromCodePoint, et toute
 * la lecture de la page échouait pour un seul caractère. Elle reste maintenant écrite telle quelle.
 */
const require = createRequire(import.meta.url)
const { readWebPage, isPublicAddress, MAX_PAGE_BYTES, MAX_REDIRECTS } = loadTsModule('electron/services/webPage.ts', {
  dns: require('node:dns'),
  net: require('node:net'),
  undici: require('undici')
})

/** Remplace fetch le temps d'un appel ; `route(url, init, n)` rend la réponse du n-ième appel. */
async function withFetch(route, run) {
  const realFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return route(String(url), init, calls.length)
  }
  try {
    return { result: await run(), calls }
  } finally {
    globalThis.fetch = realFetch
  }
}

async function readWith(html) {
  const { result } = await withFetch(
    () => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
    () => readWebPage('https://exemple.fr/page')
  )
  return result
}

test('une entité hors de l’Unicode ne fait plus échouer la lecture de la page', async () => {
  const text = await readWith('<p>Prix&#160;: 12&#x20AC; &#99999999; &#xD800; &#x110000; fin</p>')
  assert.equal(text, 'Prix : 12€ &#99999999; &#xD800; &#x110000; fin')
})

/**
 * Relecture croisée : read_web_page est permis depuis le téléphone (donc depuis internet), et l'adresse vient d'un
 * modèle. Il lisait ce PC (127.0.0.1 : l'Ollama de Jaris, le serveur du téléphone), la box et le réseau local, y compris
 * au bout d'une redirection, et lisait le corps entier sans limite.
 */
test('seules les adresses publiques sont lues : ce PC, le réseau local, les adresses réservées ne le sont jamais', () => {
  const local = [
    '127.0.0.1', '127.8.9.10', '0.0.0.0', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '100.101.102.103', '224.0.0.1', '255.255.255.255', '198.18.0.1',
    '::1', '::', '[::1]', 'fe80::1', 'fe80::1%eth0', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1',
    '::ffff:192.168.0.1', '64:ff9b::a00:1', '2002:c0a8:101::1', '::127.0.0.1', '2001:db8::1', 'pas-une-ip'
  ]
  for (const address of local) assert.equal(isPublicAddress(address), false, address)
  for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808', '2a00:1450:4007:80e::200e']) {
    assert.equal(isPublicAddress(address), true, address)
  }
})

test('une page de ce PC (adresse écrite, nom local, forme numérique) est refusée avant toute connexion', async () => {
  let requests = 0
  const server = http.createServer((_req, res) => {
    requests++
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<p>Ollama de Jaris : secret</p>')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    // Le VRAI fetch et la VRAIE résolution DNS : « localhost » est refusé à la connexion, sur l'adresse obtenue.
    for (const url of [`http://127.0.0.1:${port}/`, `http://localhost:${port}/api/tags`, `http://2130706433:${port}/`, `http://[::ffff:127.0.0.1]:${port}/`]) {
      await assert.rejects(readWebPage(url), (err) => /ne lit pas/.test(err.message) && err.name === 'PageHttpError', url)
    }
    // Un nom d'allure publique qui répond une adresse locale (« DNS rebinding ») : refusé sur l'adresse obtenue.
    const rebinding = loadTsModule('electron/services/webPage.ts', {
      dns: { lookup: (_host, _options, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]) },
      net: require('node:net'),
      undici: require('undici')
    })
    await assert.rejects(rebinding.readWebPage(`http://site-public.example:${port}/`), /ne lit pas/)
    assert.equal(requests, 0, 'une requête est arrivée jusqu’au serveur local')
  } finally {
    server.close()
  }
})

test('une redirection vers une adresse locale est refusée sans être suivie ; trop de redirections aussi', async () => {
  const { calls } = await withFetch(
    () => new Response(null, { status: 302, headers: { location: 'http://192.168.1.1/admin' } }),
    () => assert.rejects(readWebPage('https://exemple.fr/lien'), /ne lit pas http:\/\/192\.168\.1\.1\/admin/)
  )
  assert.deepEqual(calls.map((c) => c.url), ['https://exemple.fr/lien'], 'la redirection locale a été contactée')
  assert.equal(calls[0].init.redirect, 'manual', 'les redirections doivent être suivies à la main, pour être revérifiées')

  const loop = await withFetch(
    (url, _init, n) => new Response(null, { status: 301, headers: { location: `/etape-${n}` } }),
    () => assert.rejects(readWebPage('https://exemple.fr/boucle'), /trop d'autres adresses/)
  )
  assert.equal(loop.calls.length, MAX_REDIRECTS + 1)
  assert.equal(loop.calls[1].url, 'https://exemple.fr/etape-1', 'une redirection relative part de la page qui redirige')

  // Une redirection vers une page publique est suivie normalement.
  const ok = await withFetch(
    (url) =>
      url.endsWith('/ancienne')
        ? new Response(null, { status: 308, headers: { location: 'https://autre.exemple.org/nouvelle' } })
        : new Response('<p>Bonjour</p>', { headers: { 'content-type': 'text/html' } }),
    () => readWebPage('https://exemple.fr/ancienne')
  )
  assert.equal(ok.result, 'Bonjour')
})

test('une page géante n’est lue que jusqu’à la limite : la suite n’est jamais téléchargée', async () => {
  let pulled = 0
  const chunk = new TextEncoder().encode(`<p>${'x'.repeat(65_000)}</p>`)
  const body = new ReadableStream({
    pull(controller) {
      if (pulled >= 40 * 1024 * 1024) return controller.close()
      pulled += chunk.length
      controller.enqueue(chunk)
    }
  })
  const { result } = await withFetch(
    () => new Response(body, { headers: { 'content-type': 'text/html' } }),
    () => readWebPage('https://exemple.fr/enorme')
  )
  assert.ok(pulled <= MAX_PAGE_BYTES + 3 * chunk.length, `${pulled} octets lus pour une limite de ${MAX_PAGE_BYTES}`)
  assert.match(result, /… \(contenu tronqué\)$/)
})
