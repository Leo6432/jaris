import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Étape 418 : le moteur MCP de Jaris (mcpHub.ts) branché à un VRAI serveur MCP (scripts/fixtures/mcp-test-server.mjs,
 * kit officiel), lancé comme Léo le ferait en collant sa configuration : outils listés, appelés, échecs lisibles,
 * clés jamais montrées à l'écran, serveur arrêté avec Jaris.
 */
const require = createRequire(import.meta.url)
const SERVER = fileURLToPath(new URL('./fixtures/mcp-test-server.mjs', import.meta.url))
const shared = loadTsModule('shared/mcp.ts')
const catalog = loadTsModule('shared/mcpCatalog.ts', { './textSearch': loadTsModule('shared/textSearch.ts') })

/** Un faux chiffrement réversible (le vrai est celui de Windows) : le fichier ne contient jamais la clé en clair. */
const BOX = {
  encrypt: (text) => Buffer.from(Buffer.from(text, 'utf8').toString('base64').split('').reverse().join(''), 'utf8'),
  decrypt: (data) => Buffer.from(data.toString('utf8').split('').reverse().join(''), 'base64').toString('utf8')
}

/** Un Jaris : son moteur MCP et son module de connexion par compte, sur le dossier de données `root`. */
function loadHub(root) {
  const atomic = loadTsModule('electron/services/atomicFile.ts', { fs: require('fs'), 'fs/promises': require('fs/promises'), path: require('path') })
  const dataLocation = { getDataRoot: () => root }
  const auth = loadTsModule('electron/services/mcpAuth.ts', { http: require('http'), 'fs/promises': require('fs/promises'), path: require('path'), './atomicFile': atomic, './dataLocation': dataLocation })
  auth.setMcpSecretBox(BOX)
  const hub = loadTsModule('electron/services/mcpHub.ts', {
    crypto: require('crypto'),
    fs: require('fs'),
    path: require('path'),
    '@modelcontextprotocol/sdk/client/index.js': require('@modelcontextprotocol/sdk/client/index.js'),
    '@modelcontextprotocol/sdk/client/stdio.js': require('@modelcontextprotocol/sdk/client/stdio.js'),
    '@modelcontextprotocol/sdk/client/streamableHttp.js': require('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    '@modelcontextprotocol/sdk/client/sse.js': require('@modelcontextprotocol/sdk/client/sse.js'),
    '@modelcontextprotocol/sdk/client/auth.js': require('@modelcontextprotocol/sdk/client/auth.js'),
    './atomicFile': atomic,
    './dataLocation': dataLocation,
    './mcpAuth': auth,
    '../../shared/mcp': shared,
    '../../shared/mcpCatalog': catalog
  })
  return { hub, auth }
}

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'jaris-mcp-'))
  const { hub, auth } = loadHub(root)
  let changes = 0
  hub.setMcpChangeListener(() => changes++)
  return { hub, auth, root, changes: () => changes, done: async () => {
    await hub.stopMcpHub()
    rmSync(root, { recursive: true, force: true })
  } }
}

async function waitFor(check, what, timeout = 30_000) {
  const start = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() - start > timeout) throw new Error(`Délai dépassé : ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const config = (args = [], env) => JSON.stringify({ mcpServers: { 'Mes fichiers': { command: process.execPath, args: [SERVER, ...args], ...(env ? { env } : {}) } } })
const ready = (hub) => waitFor(async () => (await hub.listMcpServers()).find((s) => s.status === 'ready' || s.status === 'error'), 'serveur prêt')

test('un vrai serveur collé en JSON : connecté, outils listés (lecture seule dite), configuration enregistrée sans rien montrer des clés', async () => {
  const env = setup()
  try {
    const views = await env.hub.addMcpServers(config([], { SECRET: 'jeton-tres-secret' }), '')
    assert.equal(views.length, 1)
    assert.equal(views[0].name, 'Mes fichiers')
    const server = await ready(env.hub)
    assert.equal(server.status, 'ready', server.error)
    assert.deepEqual(server.tools.map((tool) => tool.name).sort(), ['add_numbers', 'crash', 'fail', 'job_status', 'list_files', 'secret'])
    assert.equal(server.tools.find((tool) => tool.name === 'list_files').readOnly, true)
    assert.equal(server.tools.find((tool) => tool.name === 'add_numbers').readOnly, false)
    assert.deepEqual(server.secretNames, ['SECRET'])
    assert.ok(!JSON.stringify(await env.hub.listMcpServers()).includes('jeton-tres-secret'), 'la valeur d’une clé ne part jamais à l’écran')
    assert.ok(env.changes() > 0, 'l’écran est prévenu')
    const saved = JSON.parse(readFileSync(path.join(env.root, 'mcp-servers.json'), 'utf8'))
    assert.equal(saved.servers[0].transport.env.SECRET, 'jeton-tres-secret', 'la clé est gardée pour relancer le serveur')

    // Le modèle reçoit les outils (au nom préfixé) et peut les appeler ; la clé arrive bien au serveur.
    const offered = env.hub.mcpToolsFor('Additionne 2 et 3')
    const names = offered.tools.map((tool) => tool.function.name)
    assert.ok(names.includes('mcp_mes_fichiers_add_numbers'), names.join())
    const add = offered.tools.find((tool) => tool.function.name === 'mcp_mes_fichiers_add_numbers')
    assert.equal(add.function.parameters.type, 'object')
    assert.ok(add.function.parameters.properties.a, 'le schéma des paramètres suit')
    assert.match(add.function.description, /^\[MCP Mes fichiers\] Add two numbers/)
    assert.equal(await offered.call('mcp_mes_fichiers_add_numbers', { a: 2, b: 3 }), '5')
    assert.equal(await offered.call('mcp_mes_fichiers_secret', {}), 'secret=jeton-tres-secret')
    // Un échec signalé par le serveur : son vrai message, tel quel.
    await assert.rejects(offered.call('mcp_mes_fichiers_fail', {}), /L'outil « fail » du serveur MCP « Mes fichiers » a échoué : Jeton GitHub refusé \(401\)\./)
    // Un nom jamais proposé est refusé.
    await assert.rejects(offered.call('mcp_autre_outil', {}), /n'a pas été proposé/)

    // Un outil décoché n'est plus proposé.
    await env.hub.setMcpToolEnabled(server.id, 'add_numbers', false)
    assert.ok(!env.hub.mcpToolsFor('Additionne').tools.some((tool) => tool.function.name === 'mcp_mes_fichiers_add_numbers'))
    assert.equal((await env.hub.listMcpServers())[0].tools.find((tool) => tool.name === 'add_numbers').enabled, false)
  } finally {
    await env.done()
  }
})

test('un serveur qui plante en cours de route : son dernier message est dit, et « Relancer » le reconnecte', async () => {
  const env = setup()
  try {
    await env.hub.addMcpServers(config(), '')
    const server = await ready(env.hub)
    assert.equal(server.status, 'ready', server.error)
    await env.hub.mcpToolsFor('').call('mcp_mes_fichiers_crash', {})
    const crashed = await waitFor(async () => (await env.hub.listMcpServers()).find((s) => s.status === 'error'), 'arrêt vu')
    assert.match(crashed.error, /s'est arrêté\. Son dernier message : Plantage volontaire du serveur de test\./)
    assert.equal(env.hub.mcpToolsFor('').tools.length, 0, 'plus aucun outil proposé d’un serveur arrêté')
    await env.hub.restartMcpServer(server.id)
    const back = await ready(env.hub)
    assert.equal(back.status, 'ready')
  } finally {
    await env.done()
  }
})

test('un serveur qui échoue au démarrage dit pourquoi (ce qu’il a écrit), une commande absente dit quoi installer', async () => {
  const env = setup()
  try {
    await env.hub.addMcpServers(config(['broken']), 'cassé')
    const broken = await ready(env.hub)
    assert.equal(broken.status, 'error')
    assert.match(broken.error, /Le serveur MCP « cassé » n'a pas démarré : Erreur : la variable API_KEY est manquante\./)

    await env.hub.addMcpServers('commande-introuvable-jaris -y paquet', '')
    const missing = await waitFor(async () => (await env.hub.listMcpServers()).find((s) => s.summary.startsWith('commande-introuvable') && s.status === 'error'), 'échec')
    assert.match(missing.error, /La commande « commande-introuvable-jaris » est introuvable sur ce PC\. Pour « npx », installe Node\.js/)
  } finally {
    await env.done()
  }
})

test('désactiver arrête le serveur ; supprimer l’efface ; la configuration est relue au démarrage suivant', async () => {
  const env = setup()
  try {
    const [first] = await env.hub.addMcpServers(config(), '')
    await ready(env.hub)
    const off = await env.hub.setMcpServerEnabled(first.id, false)
    assert.equal(off[0].status, 'off')
    assert.equal(off[0].enabled, false)
    assert.equal(env.hub.mcpToolsFor('').tools.length, 0)
    // Un nom déjà pris reçoit un numéro : rien n'est remplacé en silence.
    const two = await env.hub.addMcpServers(config(), '')
    assert.deepEqual(two.map((s) => s.name), ['Mes fichiers', 'Mes fichiers 2'])
    // Un autre Jaris (redémarrage) relit le même dossier.
    const { hub: again } = loadHub(env.root)
    const reread = await again.listMcpServers()
    assert.deepEqual(reread.map((s) => [s.name, s.enabled]), [['Mes fichiers', false], ['Mes fichiers 2', true]])
    await again.stopMcpHub()
    await env.hub.removeMcpServer(first.id)
    assert.deepEqual((await env.hub.listMcpServers()).map((s) => s.name), ['Mes fichiers 2'])
    await assert.rejects(env.hub.removeMcpServer('inconnu'), /n'existe plus/)
    await assert.rejects(env.hub.addMcpServers('   ', ''), /Rien de reconnu/)
  } finally {
    await env.done()
  }
})

test('commande cherchée comme Windows le fait (PATH puis PATHEXT : npx → npx.cmd), chemin direct accepté', () => {
  const { hub, done } = setup()
  try {
    const dir = mkdtempSync(path.join(tmpdir(), 'jaris-path-'))
    try {
      writeFileSync(path.join(dir, 'npx.cmd'), '@echo off')
      assert.equal(hub.commandExists('npx', { PATH: `C:\\absent;${dir}`, PATHEXT: '.EXE;.CMD' }, 'win32'), true)
      assert.equal(hub.commandExists('npx', { PATH: dir }, 'linux'), false, 'sans extension, pas de npx.cmd ailleurs que sous Windows')
      assert.equal(hub.commandExists('uvx', { PATH: dir, PATHEXT: '.EXE;.CMD' }, 'win32'), false)
      assert.equal(hub.commandExists(process.execPath), true)
      assert.equal(hub.commandExists(path.join(dir, 'absent.exe')), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  } finally {
    void done()
  }
})

test('étape 419 : « Découvrir » — l’adresse vient du catalogue, la connexion par compte démarre aussitôt, hors ligne elle le dit', async () => {
  // Aucun vrai appel à Canva pendant les tests : le réseau répond « hors ligne », et rien ne s'ouvre.
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('hors ligne (test)')
  }
  const env = setup()
  const opened = []
  env.auth.setMcpBrowserOpener((url) => opened.push(url))
  try {
    await assert.rejects(env.hub.addCatalogServer('inconnu'), /n'existe plus/)
    const views = await env.hub.addCatalogServer('canva')
    assert.equal(views[0].name, 'Canva')
    assert.equal(views[0].catalogId, 'canva')
    assert.equal(views[0].kind, 'online')
    assert.equal(views[0].summary, 'https://mcp.canva.com/mcp')
    const saved = JSON.parse(readFileSync(path.join(env.root, 'mcp-servers.json'), 'utf8'))
    assert.deepEqual(saved.servers[0].transport, { kind: 'http', url: 'https://mcp.canva.com/mcp', headers: {} })
    // Hors ligne : la connexion échoue avec un message, jamais une page ouverte pour rien.
    const failed = await waitFor(async () => (await env.hub.listMcpServers()).find((s) => s.status === 'error'), 'échec hors ligne')
    assert.match(failed.error, /La connexion a échoué : .*hors ligne/)
    assert.deepEqual(opened, [])
  } finally {
    await env.done()
    globalThis.fetch = realFetch
  }
})

test('étape 419 : un serveur en ligne qui refuse la clé (401) le dit clairement', async () => {
  const server = http.createServer((req, res) => {
    req.resume()
    res.writeHead(401, { 'Content-Type': 'text/plain' })
    res.end('bad credentials')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const env = setup()
  try {
    await env.hub.addMcpServers(`http://127.0.0.1:${server.address().port}/mcp`, 'privé')
    const failed = await ready(env.hub)
    assert.equal(failed.status, 'error')
    assert.equal(failed.error, "Le serveur MCP « privé » refuse la connexion : clé manquante ou refusée. Supprime-le puis ajoute-le de nouveau avec une clé valide.")
  } finally {
    await env.done()
    server.close()
  }
})

/**
 * Un vrai petit service en ligne protégé par OAuth, sur 127.0.0.1 : métadonnées publiées, inscription dynamique, page
 * d'autorisation (qui renvoie tout de suite vers Jaris, comme si Léo avait cliqué « Autoriser »), échange du code avec
 * vérification PKCE, puis un VRAI serveur MCP (kit officiel) qui n'accepte que la clé délivrée.
 */
async function startOAuthService() {
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
  const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js')
  const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js')
  const { createHash } = require('crypto')
  const sseSessions = new Map()
  const seen = { registrations: [], tokens: 0, authorize: [] }
  const codes = new Map()
  let base = ''
  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  }
  const readBody = (req) => new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => resolve(data))
  })
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, base)
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp' || url.pathname === '/.well-known/oauth-protected-resource') {
      return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] })
    }
    if (url.pathname === '/.well-known/oauth-protected-resource/sse') {
      return json(res, 200, { resource: `${base}/sse`, authorization_servers: [base] })
    }
    // Étape 424 : un service qui ne parle que l'ancien SSE (Windsor.ai) — même connexion par compte.
    if (url.pathname === '/sse' || url.pathname === '/messages') {
      // Comme le vrai (mesuré : POST sur https://mcp.windsor.ai/sse → 404, même sans clé) : seul GET y répond.
      if (url.pathname === '/sse' && req.method !== 'GET') return res.writeHead(404).end()
      if (req.headers.authorization !== 'Bearer tok-valide') {
        res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/sse"` })
        return res.end()
      }
      if (url.pathname === '/sse' && req.method === 'GET') {
        const mcp = new McpServer({ name: 'service-sse', version: '1' })
        mcp.registerTool('mes_rapports', { description: 'List my reports' }, async () => ({ content: [{ type: 'text', text: 'Rapport Meta Ads' }] }))
        const transport = new SSEServerTransport('/messages', res)
        sseSessions.set(transport.sessionId, transport)
        res.on('close', () => sseSessions.delete(transport.sessionId))
        await mcp.connect(transport)
        return
      }
      const transport = sseSessions.get(url.searchParams.get('sessionId'))
      if (!transport) return res.writeHead(404).end()
      return transport.handlePostMessage(req, res, JSON.parse(await readBody(req)))
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none']
      })
    }
    if (url.pathname === '/register' && req.method === 'POST') {
      const meta = JSON.parse(await readBody(req))
      seen.registrations.push(meta)
      return json(res, 201, { ...meta, client_id: `client-${seen.registrations.length}`, client_id_issued_at: 1 })
    }
    if (url.pathname === '/authorize') {
      const code = `code-${codes.size + 1}`
      codes.set(code, url.searchParams.get('code_challenge'))
      seen.authorize.push(Object.fromEntries(url.searchParams))
      const back = new URL(url.searchParams.get('redirect_uri'))
      back.searchParams.set('code', code)
      back.searchParams.set('state', seen.forceState ?? url.searchParams.get('state'))
      res.writeHead(302, { Location: back.toString() })
      return res.end()
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req))
      const challenge = codes.get(form.get('code'))
      const expected = challenge && createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url')
      if (!challenge || expected !== challenge) return json(res, 400, { error: 'invalid_grant' })
      seen.tokens++
      return json(res, 200, { access_token: 'tok-valide', token_type: 'Bearer', expires_in: 3600, refresh_token: 'rafraichir' })
    }
    if (url.pathname === '/mcp') {
      if (req.headers.authorization !== 'Bearer tok-valide') {
        res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` })
        return res.end()
      }
      const mcp = new McpServer({ name: 'service', version: '1' })
      mcp.registerTool('mes_designs', { description: 'List my designs' }, async () => ({ content: [{ type: 'text', text: 'Affiche du concert' }] }))
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      res.on('close', () => {
        void transport.close()
        void mcp.close()
      })
      await mcp.connect(transport)
      const body = req.method === 'POST' ? JSON.parse(await readBody(req)) : undefined
      return transport.handleRequest(req, res, body)
    }
    res.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
  return { url: `${base}/mcp`, sseUrl: `${base}/sse`, seen, close: () => { server.closeAllConnections?.(); server.close() } }
}

/** Le « navigateur » du test : suit la page d'autorisation, puis le retour vers Jaris. */
const followInBrowser = async (url) => {
  const first = await fetch(url, { redirect: 'manual' })
  await fetch(first.headers.get('location'))
}

test('étape 419 : connexion par compte de bout en bout — « À connecter », page ouverte, clé reçue et chiffrée, outils, redémarrage sans reconnexion, suppression qui l’efface', async () => {
  const service = await startOAuthService()
  const env = setup()
  try {
    const opened = []
    env.auth.setMcpBrowserOpener((url) => opened.push(url))
    // Sans clé : « À connecter », sans erreur, et aucune page ouverte en arrière-plan.
    const [added] = await env.hub.addMcpServers(service.url, 'Canva test')
    const signin = await waitFor(async () => (await env.hub.listMcpServers()).find((s) => s.status === 'signin' || s.status === 'error'), 'à connecter')
    assert.equal(signin.status, 'signin', signin.error)
    assert.equal(signin.error, null)
    assert.deepEqual(opened, [])
    // Étape 421 : nommé dans une demande alors qu'il est à connecter — la raison, avec quoi faire, et aucun outil.
    const asked = env.hub.mcpToolsFor('Fais-moi une affiche sur Canva test')
    assert.equal(asked.tools.length, 0)
    assert.deepEqual(asked.named, [])
    assert.match(asked.unavailable, /« Canva test » n'est pas encore connecté à ton compte\. Ouvre Options → Outils MCP, clique sur « Se connecter »/)
    assert.equal(env.hub.mcpToolsFor('Quel temps fait-il ?').unavailable, undefined, 'pas nommé : rien à dire')

    // « Se connecter » : la page s'ouvre (le test la suit comme un navigateur), puis tout se fait seul.
    env.auth.setMcpBrowserOpener((url) => {
      opened.push(url)
      void followInBrowser(url)
    })
    await env.hub.signInMcpServer(added.id)
    const connected = await waitFor(async () => (await env.hub.listMcpServers()).find((s) => s.status === 'ready' || s.status === 'error'), 'connecté')
    assert.equal(connected.status, 'ready', connected.error)
    assert.deepEqual(connected.tools.map((tool) => tool.name), ['mes_designs'])
    assert.equal(opened.length, 1)
    const page = new URL(opened[0])
    assert.equal(page.searchParams.get('code_challenge_method'), 'S256', 'PKCE')
    assert.match(page.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/callback$/, 'retour local seulement')
    assert.equal(service.seen.registrations[0].client_name, 'Jaris')
    assert.equal(service.seen.tokens, 1)
    assert.equal(await env.hub.mcpToolsFor('').call('mcp_canva_test_mes_designs', {}), 'Affiche du concert')
    const named = env.hub.mcpToolsFor('Montre mes designs sur Canva test')
    assert.deepEqual(named.named, ['Canva test'], 'connecté et nommé')
    assert.equal(named.unavailable, undefined)

    // La clé est gardée chiffrée sur le disque, et jamais montrée à l'écran.
    const file = readFileSync(path.join(env.root, 'mcp-auth', `${added.id}.bin`), 'utf8')
    assert.ok(!file.includes('tok-valide'))
    assert.ok(!JSON.stringify(await env.hub.listMcpServers()).includes('tok-valide'))

    // Jaris redémarre : connecté tout de suite avec la clé gardée, sans rien rouvrir.
    await env.hub.stopMcpHub()
    const { hub: again, auth: againAuth } = loadHub(env.root)
    againAuth.setMcpSecretBox(BOX)
    againAuth.setMcpBrowserOpener(() => assert.fail('aucune page à rouvrir'))
    await again.startMcpHub()
    const back = await waitFor(async () => (await again.listMcpServers()).find((s) => s.status === 'ready' || s.status === 'error' || s.status === 'signin'), 'reconnecté')
    assert.equal(back.status, 'ready', back.error ?? back.status)
    assert.equal(service.seen.registrations.length, 1, 'pas de nouvelle inscription')
    // Supprimer efface aussi la clé.
    await again.removeMcpServer(added.id)
    assert.throws(() => readFileSync(path.join(env.root, 'mcp-auth', `${added.id}.bin`)))
    await again.stopMcpHub()
  } finally {
    await env.done()
    service.close()
  }
})

test('étape 419 : un retour dont le « state » ne correspond pas est refusé ; « Annuler » revient à « À connecter »', async () => {
  const service = await startOAuthService()
  const env = setup()
  try {
    const [added] = await env.hub.addMcpServers(service.url, 'Service')
    await waitFor(async () => (await env.hub.listMcpServers()).find((s) => s.status === 'signin'), 'à connecter')
    service.seen.forceState = 'un-autre-state'
    env.auth.setMcpBrowserOpener((url) => void followInBrowser(url))
    await env.hub.signInMcpServer(added.id)
    const refused = await waitFor(async () => (await env.hub.listMcpServers()).find((s) => s.status === 'error'), 'refusé')
    assert.equal(refused.error, 'La connexion a échoué : state')
    assert.equal(service.seen.tokens, 0, 'aucune clé échangée')

    // Léo ne termine pas dans le navigateur, puis annule.
    env.auth.setMcpBrowserOpener(() => {})
    await env.hub.signInMcpServer(added.id)
    await waitFor(async () => (await env.hub.listMcpServers()).find((s) => s.status === 'authorizing'), 'en cours')
    await env.hub.cancelMcpSignIn(added.id)
    const cancelled = await waitFor(async () => (await env.hub.listMcpServers()).find((s) => s.status === 'signin'), 'annulé')
    assert.equal(cancelled.error, null)
  } finally {
    await env.done()
    service.close()
  }
})

test('étape 420 : un travail en cours dont le serveur dit « reviens dans 1 s » — Jaris attend avant de rendre la main ; « Arrêter » coupe l’attente', async () => {
  const env = setup()
  try {
    await env.hub.addMcpServers(config(), '')
    assert.equal((await ready(env.hub)).status, 'ready')
    const offered = env.hub.mcpToolsFor('')
    let started = Date.now()
    assert.match(await offered.call('mcp_mes_fichiers_job_status', {}), /in_progress/)
    assert.ok(Date.now() - started >= 900, `attente respectée (${Date.now() - started} ms)`)
    const stop = new AbortController()
    started = Date.now()
    const call = offered.call('mcp_mes_fichiers_job_status', {}, stop.signal)
    setTimeout(() => stop.abort(), 100)
    await call.catch(() => {})
    assert.ok(Date.now() - started < 800, 'arrêté sans attendre la fin')
  } finally {
    await env.done()
  }
})

test('étape 423 : plus d’outils que de places — « mcp_more_tools » liste les autres et les charge à la demande, appelables ensuite', async () => {
  const env = setup()
  try {
    const servers = Object.fromEntries(['Alpha', 'Beta', 'Gamma'].map((name) => [name, { command: process.execPath, args: [SERVER] }]))
    await env.hub.addMcpServers(JSON.stringify({ mcpServers: servers }), '')
    await waitFor(async () => (await env.hub.listMcpServers()).every((s) => s.status === 'ready'), 'trois serveurs prêts')
    const offered = env.hub.mcpToolsFor('Bonjour')
    const names = offered.tools.map((tool) => tool.function.name)
    assert.ok(names.includes('mcp_more_tools'), names.join())
    const more = offered.tools.find((tool) => tool.function.name === 'mcp_more_tools')
    const missing = ['mcp_gamma_add_numbers', 'mcp_beta_add_numbers', 'mcp_alpha_add_numbers'].find((name) => !names.includes(name))
    assert.ok(missing, 'au moins un outil n’a pas eu de place')
    assert.ok(more.function.description.includes(missing), 'il est listé')
    await assert.rejects(offered.call(missing, { a: 1, b: 2 }), /n'a pas été proposé/, 'pas avant d’être chargé')
    const loaded = offered.more.load([missing, 'mcp_inexistant'])
    assert.deepEqual(loaded.map((tool) => tool.function.name), [missing])
    assert.equal(loaded[0].function.parameters.type, 'object')
    assert.equal(await offered.call(missing, { a: 1, b: 2 }), '3', 'chargé : appelable, sur le vrai serveur')
  } finally {
    await env.done()
  }
})

test('étape 424 : un service qui ne parle que l’ancien SSE (Windsor.ai) — « Se connecter » marche aussi, puis ses outils', async () => {
  const service = await startOAuthService()
  const env = setup()
  try {
    const [added] = await env.hub.addMcpServers(service.sseUrl, 'Windsor test')
    const signin = await waitFor(async () => (await env.hub.listMcpServers()).find((s) => s.status === 'signin' || s.status === 'error'), 'à connecter')
    assert.equal(signin.status, 'signin', signin.error)
    env.auth.setMcpBrowserOpener((url) => void followInBrowser(url))
    await env.hub.signInMcpServer(added.id)
    const connected = await waitFor(async () => (await env.hub.listMcpServers()).find((s) => s.status === 'ready' || s.status === 'error'), 'connecté')
    assert.equal(connected.status, 'ready', connected.error)
    assert.equal(await env.hub.mcpToolsFor('').call('mcp_windsor_test_mes_rapports', {}), 'Rapport Meta Ads')
  } finally {
    await env.done()
    service.close()
  }
})
